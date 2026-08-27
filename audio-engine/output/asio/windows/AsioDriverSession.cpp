#include "AsioDriverSession.h"

#include "../AsioRenderUtils.h"

#include <objbase.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <optional>
#include <thread>
#include <utility>
#include <vector>

namespace twilight::audio::asio_windows {
namespace {

constexpr uint32_t kEventReset = 1U << 0U;
constexpr uint32_t kEventRestart = 1U << 1U;
constexpr uint32_t kEventBufferFailure = 1U << 2U;
// Transient load notifications. Kept separate from kEventBufferFailure so they
// reach diagnostics without dragging the stream through a full rebuild.
constexpr uint32_t kEventXrun = 1U << 3U;

std::string hresultError(const char* stage, HRESULT value) {
  char buffer[96] = {};
  std::snprintf(
      buffer,
      sizeof(buffer),
      "%s (HRESULT=0x%08lx)",
      stage,
      static_cast<unsigned long>(value));
  return buffer;
}

int bitDepthForFormat(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::Int16Interleaved:
      return 16;
    case AudioSampleFormat::Int24Interleaved:
    case AudioSampleFormat::Int24In32Interleaved:
      return 24;
    case AudioSampleFormat::DsdInt8Lsb1:
    case AudioSampleFormat::DsdInt8Msb1:
    case AudioSampleFormat::DsdInt8Ner8:
      return 1;
    case AudioSampleFormat::Int32Interleaved:
    case AudioSampleFormat::Float32Interleaved:
    default:
      return 32;
  }
}

std::optional<AsioChannelFormat> channelFormatFor(asio_abi::AsioSampleType sampleType) {
  AsioChannelFormat format;
  switch (sampleType) {
    case asio_abi::kAsioSampleInt16Lsb:
      format.logicalFormat = AudioSampleFormat::Int16Interleaved;
      format.containerBits = 16;
      format.validBits = 16;
      break;
    case asio_abi::kAsioSampleInt24Lsb:
      format.logicalFormat = AudioSampleFormat::Int24Interleaved;
      format.containerBits = 24;
      format.validBits = 24;
      break;
    case asio_abi::kAsioSampleInt32Lsb24:
      format.logicalFormat = AudioSampleFormat::Int24In32Interleaved;
      format.containerBits = 32;
      format.validBits = 24;
      format.validBitsAreMostSignificant = true;
      break;
    case asio_abi::kAsioSampleInt32Lsb:
      format.logicalFormat = AudioSampleFormat::Int32Interleaved;
      break;
    case asio_abi::kAsioSampleFloat32Lsb:
      format.logicalFormat = AudioSampleFormat::Float32Interleaved;
      break;
    case asio_abi::kAsioSampleDsdInt8Lsb1:
      format.logicalFormat = AudioSampleFormat::DsdInt8Lsb1;
      format.containerBits = 8;
      format.validBits = 1;
      format.dsdPacking = AsioDsdPacking::Lsb1;
      break;
    case asio_abi::kAsioSampleDsdInt8Msb1:
      format.logicalFormat = AudioSampleFormat::DsdInt8Msb1;
      format.containerBits = 8;
      format.validBits = 1;
      format.dsdPacking = AsioDsdPacking::Msb1;
      break;
    case asio_abi::kAsioSampleDsdInt8Ner8:
      format.logicalFormat = AudioSampleFormat::DsdInt8Ner8;
      format.containerBits = 8;
      format.validBits = 8;
      format.dsdPacking = AsioDsdPacking::Ner8;
      break;
    default:
      return std::nullopt;
  }
  return format;
}

int32_t chooseBufferSize(int32_t requested, int32_t minimum, int32_t maximum, int32_t preferred, int32_t granularity) {
  if (minimum <= 0 || maximum < minimum) return 0;
  // Drivers report distorted ranges surprisingly often (preferred = 0, or
  // preferred outside [min,max]); clamp instead of rejecting the driver.
  const int32_t boundedPreferred = std::clamp(preferred, minimum, maximum);
  int32_t value = requested > 0 ? std::clamp(requested, minimum, maximum) : boundedPreferred;
  if (granularity == 0) {
    // Per the ASIO 2 spec this means any size inside the range is legal, so
    // honor the requested value instead of silently discarding it.
    return value;
  }
  if (granularity > 0) {
    const int32_t offset = value - minimum;
    const int32_t lower = minimum + (offset / granularity) * granularity;
    const int32_t upper = std::min(maximum, lower + granularity);
    return value - lower <= upper - value ? lower : upper;
  }
  int32_t best = 0;
  for (int32_t size = 1; size > 0 && size <= maximum; size *= 2) {
    if (size < minimum) continue;
    if (best == 0 || std::abs(size - value) < std::abs(best - value)) best = size;
  }
  return best;
}

std::string driverError(asio_abi::AsioDriver* driver, const char* fallback) {
  if (!driver) return fallback;
  std::array<char, 1024> message{};
  driver->getErrorMessage(message.data());
  const auto end = std::find(message.begin(), message.end(), '\0');
  return end == message.begin() ? fallback : std::string(message.begin(), end);
}

void traceAsioDriverCall(const char* phase) {
  const char* tracePath = std::getenv("TAE_ASIO_TRACE_PATH");
  if (!tracePath || tracePath[0] == '\0') return;
  std::ofstream trace(tracePath, std::ios::app);
  if (trace) trace << phase << '\n';
}

void traceNativeDsdResult(
    asio_abi::AsioDriver* driver,
    const char* operation,
    asio_abi::AsioError result,
    std::optional<double> rate = std::nullopt,
    const asio_abi::AsioIoFormat* ioFormat = nullptr) {
  const char* tracePath = std::getenv("TAE_ASIO_TRACE_PATH");
  if (!tracePath || tracePath[0] == '\0') return;
  std::ofstream trace(tracePath, std::ios::app);
  if (!trace) return;
  std::array<char, 1024> message{};
  if (driver) driver->getErrorMessage(message.data());
  trace << "Native DSD " << operation << " result=" << result;
  if (rate.has_value()) trace << " rate=" << *rate;
  if (ioFormat) trace << " formatType=" << ioFormat->formatType;
  trace << " error=" << message.data() << '\n';
}

void traceNativeDsdText(const char* operation, const std::string& text) {
  const char* tracePath = std::getenv("TAE_ASIO_TRACE_PATH");
  if (!tracePath || tracePath[0] == '\0') return;
  std::ofstream trace(tracePath, std::ios::app);
  if (trace) trace << "Native DSD " << operation << " " << text << '\n';
}

}  // namespace

struct AsioDriverSession::State final : AsioCallbackTarget {
  asio_abi::AsioDriver* driver = nullptr;
  std::vector<asio_abi::AsioBufferInfo> buffers;
  std::vector<AsioChannelFormat> channelFormats;
  asio_abi::AsioCallbacks callbacks{};
  AsioBufferSwitchCallback bufferSwitch;
  AsioEventCallback eventCallback;
  std::atomic<bool> running = false;
  std::atomic<uint32_t> pendingEvents = 0;
  // Set while the init-compatibility "Cubase dance" runs its dummy engine
  // round: the dummy buffers fire real callbacks that must neither reach the
  // render pipeline nor raise spurious buffer-failure events.
  std::atomic<bool> danceInProgress = false;
  int32_t bufferSize = 0;
  int32_t latency = 0;
  asio_abi::AsioIoFormat originalIoFormat{};
  double originalSampleRate = 0;
  std::string nativeDsdNegotiation;
  bool initialized = false;
  bool buffersCreated = false;
  bool started = false;
  bool ioFormatRestoreRequired = false;
  bool originalIoFormatKnown = false;
  bool sampleRateRestoreRequired = false;
  bool nativeDsdCanDoReported = false;

  bool selectNativeDsdSemanticRate(int driverRate, const char* order, std::string* error) {
    const double requestedRate = static_cast<double>(driverRate);
    const auto canRateResult = driver->canSampleRate(requestedRate);
    traceNativeDsdResult(driver, (std::string(order) + " can-sample-rate").c_str(), canRateResult, requestedRate);
    if (!asio_abi::asioErrorIsSuccess(canRateResult)) {
      if (error) *error = "ASIO driver rejected the Native DSD semantic sample rate";
      return false;
    }

    sampleRateRestoreRequired = true;
    const auto setRateResult = driver->setSampleRate(requestedRate);
    traceNativeDsdResult(driver, (std::string(order) + " set-sample-rate").c_str(), setRateResult, requestedRate);
    if (!asio_abi::asioErrorIsSuccess(setRateResult)) {
      if (error) *error = "ASIO driver could not select the Native DSD semantic sample rate";
      return false;
    }
    return true;
  }

  bool selectNativeDsdIoFormat(const char* order, std::string* error) {
    asio_abi::AsioIoFormat requestedIoFormat{};
    requestedIoFormat.formatType = asio_abi::kAsioIoFormatDsd;
    const auto canFormatResult = driver->future(asio_abi::kFutureCanDoIoFormat, &requestedIoFormat);
    traceNativeDsdResult(driver, (std::string(order) + " can-io-format").c_str(), canFormatResult, std::nullopt, &requestedIoFormat);
    if (!asio_abi::asioErrorIsSuccess(canFormatResult)) {
      if (error) *error = "ASIO driver rejected Native DSD I/O format";
      return false;
    }
    nativeDsdCanDoReported = true;

    ioFormatRestoreRequired = true;
    const auto setFormatResult = driver->future(asio_abi::kFutureSetIoFormat, &requestedIoFormat);
    traceNativeDsdResult(driver, (std::string(order) + " set-io-format").c_str(), setFormatResult, std::nullopt, &requestedIoFormat);
    if (!asio_abi::asioErrorIsSuccess(setFormatResult)) {
      if (error) *error = "ASIO driver could not switch to Native DSD I/O format";
      return false;
    }
    return true;
  }

  bool verifyNativeDsdIoFormat(const char* order, std::string* error) {
    asio_abi::AsioIoFormat activeIoFormat{};
    const auto getFormatResult = driver->future(asio_abi::kFutureGetIoFormat, &activeIoFormat);
    traceNativeDsdResult(driver, (std::string(order) + " get-io-format").c_str(), getFormatResult, std::nullopt, &activeIoFormat);
    if (asio_abi::asioErrorIsSuccess(getFormatResult) &&
        activeIoFormat.formatType != asio_abi::kAsioIoFormatDsd) {
      if (error) *error = "ASIO driver did not confirm Native DSD I/O format";
      return false;
    }
    return true;
  }

  bool configureNativeDsd(const AudioFormat& format, std::string* error) {
    if (!driver || !isDsdSampleFormat(format.sampleFormat)) {
      if (error) *error = "Native DSD configuration requires a raw DSD format";
      return false;
    }
    nativeDsdCanDoReported = false;
    const int driverRate = asio::driverSampleRate(format);
    if (driverRate <= 0) {
      if (error) *error = "Native DSD requested an invalid ASIO semantic sample rate";
      return false;
    }

    const auto originalRateResult = driver->getSampleRate(&originalSampleRate);
    traceNativeDsdResult(driver, "get-original-sample-rate", originalRateResult, originalSampleRate);
    if (!asio_abi::asioErrorIsSuccess(originalRateResult) || originalSampleRate <= 0) {
      if (error) *error = "ASIO driver did not report a restorable PCM sample rate";
      return false;
    }

    const auto getIoFormatResult = driver->future(asio_abi::kFutureGetIoFormat, &originalIoFormat);
    traceNativeDsdResult(driver, "get-original-io-format", getIoFormatResult, std::nullopt, &originalIoFormat);
    if (asio_abi::asioErrorIsSuccess(getIoFormatResult)) {
      originalIoFormatKnown = true;
      std::memset(originalIoFormat.reserved, 0, sizeof(originalIoFormat.reserved));
      if (originalIoFormat.formatType != asio_abi::kAsioIoFormatPcm) {
        nativeDsdNegotiation = "get-non-pcm";
        if (error) *error = "ASIO driver did not begin the Native DSD probe in PCM I/O format";
        return false;
      }
      nativeDsdNegotiation = "get-confirmed";
    } else {
      // Several otherwise-capable ASIO drivers implement CanDo/Set but omit
      // GetIoFormat. The active channel sample type is the authoritative proof.
      nativeDsdNegotiation = "get-unsupported";
    }

    std::string formatFirstError;
    if (selectNativeDsdIoFormat("format-first", &formatFirstError) &&
        selectNativeDsdSemanticRate(driverRate, "format-first", &formatFirstError) &&
        verifyNativeDsdIoFormat("format-first", &formatFirstError)) {
      nativeDsdNegotiation = originalIoFormatKnown ? "format-first-confirmed" : "format-first-runtime-confirmed";
      return true;
    }

    restoreNativeDsdConfiguration();

    // A few drivers expose the DSD format only after the semantic rate has
    // been primed. Keep that compatibility path as a fallback, but do not
    // probe it first: a failed rate-first SetSampleRate can leave otherwise
    // capable drivers in a state where buffer creation fails.
    std::string rateFirstError;
    if (selectNativeDsdSemanticRate(driverRate, "rate-first", &rateFirstError) &&
        selectNativeDsdIoFormat("rate-first", &rateFirstError) &&
        verifyNativeDsdIoFormat("rate-first", &rateFirstError)) {
      nativeDsdNegotiation = originalIoFormatKnown ? "rate-first-confirmed" : "rate-first-runtime-confirmed";
      return true;
    }

    restoreNativeDsdConfiguration();
    nativeDsdNegotiation = "all-orders-failed";
    if (error) {
      *error = "ASIO Native DSD negotiation failed (format-first: " + formatFirstError +
               "; rate-first: " + rateFirstError + ")";
      if (nativeDsdCanDoReported) {
        // Can-do answered yes while both sets were refused. Field-verified
        // shape of a device held by another audio client — the same driver
        // accepts every switch the moment the other client closes — not of
        // missing DSD capability. Say so instead of implying the DAC cannot.
        *error += "; the driver claims DSD support but refused the switch, so another audio client "
                  "likely holds the device";
      }
    }
    return false;
  }

  void restoreNativeDsdConfiguration() {
    if (!driver) return;
    if (ioFormatRestoreRequired) {
      asio_abi::AsioIoFormat restoreIoFormat = originalIoFormat;
      if (!originalIoFormatKnown) restoreIoFormat.formatType = asio_abi::kAsioIoFormatPcm;
      const auto restoreFormatResult = driver->future(asio_abi::kFutureSetIoFormat, &restoreIoFormat);
      traceNativeDsdResult(driver, "restore-io-format", restoreFormatResult, std::nullopt, &restoreIoFormat);
      ioFormatRestoreRequired = false;
    }
    if (sampleRateRestoreRequired && originalSampleRate > 0) {
      const auto restoreRateResult = driver->setSampleRate(originalSampleRate);
      traceNativeDsdResult(driver, "restore-sample-rate", restoreRateResult, originalSampleRate);
      sampleRateRestoreRequired = false;
    }
  }

  void onAsioBufferSwitch(int32_t bufferIndex) noexcept override {
    if (danceInProgress.load(std::memory_order_acquire)) return;
    if (bufferIndex < 0 || bufferIndex > 1 || !running.load(std::memory_order_acquire)) {
      pendingEvents.fetch_or(kEventBufferFailure, std::memory_order_release);
      return;
    }
    try {
      if (bufferSwitch) bufferSwitch(bufferIndex);
    } catch (...) {
      pendingEvents.fetch_or(kEventBufferFailure, std::memory_order_release);
    }
  }

  void onAsioSampleRateChanged(double) noexcept override {
    pendingEvents.fetch_or(kEventRestart, std::memory_order_release);
  }

  int32_t onAsioMessage(int32_t selector, int32_t value, void*, double*) noexcept override {
    switch (selector) {
      case asio_abi::kSelectorSupported:
        return value == asio_abi::kSelectorEngineVersion || value == asio_abi::kSelectorSupportsTimeInfo
                   ? asio_abi::kAsioTrue
                   : asio_abi::kAsioFalse;
      case asio_abi::kSelectorResetRequest:
      case asio_abi::kSelectorResyncRequest:
        pendingEvents.fetch_or(kEventReset, std::memory_order_release);
        return asio_abi::kAsioTrue;
      case asio_abi::kSelectorBufferSizeChange:
        // The buffer geometry changed underneath us; the current buffers are
        // genuinely stale, so this one does require a rebuild.
        pendingEvents.fetch_or(kEventBufferFailure, std::memory_order_release);
        return asio_abi::kAsioTrue;
      case asio_abi::kSelectorLatenciesChanged:
      case asio_abi::kSelectorOverload:
        // Informational. Overload is the driver saying it missed a deadline
        // (typically a transient CPU spike) and LatenciesChanged only means the
        // reported latency figures moved. Neither invalidates the stream, and
        // both used to force a stop/close/open/start cycle with a 500 ms+
        // backoff - a self-inflicted dropout on top of a momentary glitch.
        pendingEvents.fetch_or(kEventXrun, std::memory_order_release);
        return asio_abi::kAsioTrue;
      case asio_abi::kSelectorEngineVersion:
        return 2;
      case asio_abi::kSelectorSupportsTimeInfo:
        return asio_abi::kAsioTrue;
      default:
        return asio_abi::kAsioFalse;
    }
  }

  void drainEvents() {
    const uint32_t events = pendingEvents.exchange(0, std::memory_order_acq_rel);
    if (!eventCallback || events == 0) return;
    if ((events & kEventReset) != 0) eventCallback(AsioHostEvent::DriverReset, "driver requested reset");
    if ((events & kEventRestart) != 0) eventCallback(AsioHostEvent::DriverRestart, "driver sample rate changed");
    if ((events & kEventBufferFailure) != 0) eventCallback(AsioHostEvent::BufferFailure, "driver requested buffer reconfiguration");
    if ((events & kEventXrun) != 0) eventCallback(AsioHostEvent::Xrun, "driver reported a transient load event");
  }
};

AsioDriverSession::AsioDriverSession(AsioDriverEntry entry, std::shared_ptr<AsioControlThread> controlThread)
    : entry_(std::move(entry)), controlThread_(std::move(controlThread)), state_(std::make_shared<State>()) {}

AsioDriverSession::~AsioDriverSession() {
  close();
}

bool AsioDriverSession::open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) {
  if (!controlThread_ || !controlThread_->start(error)) return false;
  const auto state = state_;
  const auto operation = controlThread_->call(
      [state, config, clsidText = entry_.clsid, systemReference = controlThread_->systemReference()]() {
        struct OpenState {
          bool ok = false;
          AsioOpenResult result;
          std::string error;
        } outcome;
        // Default to a driver-wide fault; each format-specific refusal below
        // downgrades this so the caller knows another candidate is worth trying.
        outcome.result.failureKind = AsioOpenFailureKind::Driver;

        CLSID clsid{};
        const std::wstring wideClsid(clsidText.begin(), clsidText.end());
        if (FAILED(CLSIDFromString(wideClsid.c_str(), &clsid))) {
          outcome.error = "ASIO driver CLSID is invalid";
          return outcome;
        }
        HRESULT activation = CoCreateInstance(
            clsid,
            nullptr,
            CLSCTX_INPROC_SERVER,
            clsid,
            reinterpret_cast<void**>(&state->driver));
        traceAsioDriverCall("after CoCreateInstance");
        if (FAILED(activation) || !state->driver) {
          outcome.error = hresultError("ASIO driver activation failed", activation);
          return outcome;
        }
        traceAsioDriverCall("before init");
        const auto initialized = state->driver->init(systemReference);
        traceAsioDriverCall("after init");
        if (!asio_abi::asioBoolIsTrue(initialized)) {
          outcome.error = driverError(state->driver, "ASIO driver initialization failed");
          state->driver->Release();
          state->driver = nullptr;
          return outcome;
        }
        state->initialized = true;

        int32_t inputChannels = 0;
        int32_t outputChannels = 0;
        traceAsioDriverCall("before getChannels");
        if (!asio_abi::asioErrorIsSuccess(state->driver->getChannels(&inputChannels, &outputChannels))) {
          outcome.error = driverError(state->driver, "ASIO output channel configuration is unavailable");
          return outcome;
        }
        if (config.format.channelCount <= 0 || config.format.channelCount > outputChannels) {
          // The driver works; this channel count does not fit it.
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = driverError(state->driver, "ASIO output channel configuration is unavailable");
          return outcome;
        }
        traceAsioDriverCall("after getChannels");
        int32_t minimum = 0;
        int32_t maximum = 0;
        int32_t preferred = 0;
        int32_t granularity = 0;
        traceAsioDriverCall("before getBufferSize");
        if (!asio_abi::asioErrorIsSuccess(state->driver->getBufferSize(&minimum, &maximum, &preferred, &granularity))) {
          outcome.error = driverError(state->driver, "ASIO buffer size query failed");
          return outcome;
        }
        traceNativeDsdText(
            "buffer-size",
            "minimum=" + std::to_string(minimum) + " maximum=" + std::to_string(maximum) +
                " preferred=" + std::to_string(preferred) + " granularity=" + std::to_string(granularity));
        traceAsioDriverCall("after getBufferSize");
        state->bufferSize = chooseBufferSize(config.bufferSizeFrames, minimum, maximum, preferred, granularity);
        if (state->bufferSize <= 0) {
          outcome.error = "ASIO driver reported an invalid buffer size range";
          return outcome;
        }
        const bool nativeDsdRequested = isDsdSampleFormat(config.format.sampleFormat);
        if (nativeDsdRequested && !state->configureNativeDsd(config.format, &outcome.error)) {
          // DSD negotiation is about this stream's format, not the driver.
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          return outcome;
        }

        if (nativeDsdRequested) {
          // A driver's valid buffer-size range can change once the DSD I/O
          // format is active; handing createBuffers a PCM-mode size then fails
          // with ASE_InvalidParameter on exactly those drivers. Re-read the
          // range and re-choose. A failed re-read or an invalid DSD-mode range
          // keeps the PCM-mode choice instead of failing an otherwise working
          // open.
          traceAsioDriverCall("before getBufferSize (native DSD)");
          if (asio_abi::asioErrorIsSuccess(
                  state->driver->getBufferSize(&minimum, &maximum, &preferred, &granularity))) {
            traceNativeDsdText(
                "buffer-size-dsd",
                "minimum=" + std::to_string(minimum) + " maximum=" + std::to_string(maximum) +
                    " preferred=" + std::to_string(preferred) + " granularity=" +
                    std::to_string(granularity));
            const int32_t dsdBufferSize =
                chooseBufferSize(config.bufferSizeFrames, minimum, maximum, preferred, granularity);
            if (dsdBufferSize > 0) state->bufferSize = dsdBufferSize;
          }
          traceAsioDriverCall("after getBufferSize (native DSD)");
        }

        const int driverRate = asio::driverSampleRate(config.format);
        const double requestedRate = static_cast<double>(driverRate);
        traceAsioDriverCall("before sample rate negotiation");
        if (requestedRate <= 0) {
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = driverError(state->driver, "ASIO sample rate is unsupported");
          return outcome;
        }
        if (!nativeDsdRequested) {
          // PortAudio/RtAudio only set the rate when it differs: a redundant
          // setSampleRate can disturb some drivers and re-triggers the
          // exclusive-format arbitration on multi-client devices.
          double currentRate = 0;
          const bool alreadyAtRate =
              asio_abi::asioErrorIsSuccess(state->driver->getSampleRate(&currentRate)) &&
              std::abs(currentRate - requestedRate) <= 0.01;
          if (!alreadyAtRate &&
              (!asio_abi::asioErrorIsSuccess(state->driver->canSampleRate(requestedRate)) ||
               !asio_abi::asioErrorIsSuccess(state->driver->setSampleRate(requestedRate)))) {
            outcome.result.failureKind = AsioOpenFailureKind::Format;
            outcome.error = driverError(state->driver, "ASIO sample rate is unsupported");
            return outcome;
          }
        }
        traceAsioDriverCall("after sample rate negotiation");
        // JUCE re-reads the channel count after the rate switch: on a few
        // drivers it changes, and createBuffers with a stale count then fails
        // obscurely. A failed re-read is not fatal - the original count stands.
        traceAsioDriverCall("before getChannels (post-rate)");
        int32_t postRateInputs = 0;
        int32_t postRateOutputs = 0;
        if (asio_abi::asioErrorIsSuccess(
                state->driver->getChannels(&postRateInputs, &postRateOutputs)) &&
            config.format.channelCount > postRateOutputs) {
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = "ASIO output channel configuration changed after the rate switch";
          return outcome;
        }
        traceAsioDriverCall("after getChannels (post-rate)");
        double actualRate = 0;
        traceAsioDriverCall("before getSampleRate");
        if (!asio_abi::asioErrorIsSuccess(state->driver->getSampleRate(&actualRate)) || actualRate <= 0) {
          outcome.error = driverError(state->driver, "ASIO sample rate verification failed");
          return outcome;
        }
        traceAsioDriverCall("after getSampleRate");
        const long long roundedRate = std::llround(actualRate);
        if (std::abs(actualRate - static_cast<double>(roundedRate)) > 0.01 || roundedRate > std::numeric_limits<int>::max()) {
          outcome.error = "ASIO driver returned a non-integral sample rate";
          return outcome;
        }

        state->channelFormats.clear();
        state->channelFormats.reserve(static_cast<size_t>(config.format.channelCount));
        std::optional<AsioChannelFormat> firstNativeDsdChannelFormat;
        traceAsioDriverCall("before getChannelInfo");
        for (int32_t channel = 0; channel < config.format.channelCount; ++channel) {
          asio_abi::AsioChannelInfo info{};
          info.channel = channel;
          info.isInput = asio_abi::kAsioFalse;
          info.isActive = asio_abi::kAsioTrue;
          if (!asio_abi::asioErrorIsSuccess(state->driver->getChannelInfo(&info))) {
            outcome.error = driverError(state->driver, "ASIO output channel format query failed");
            return outcome;
          }
          auto format = channelFormatFor(info.type);
          traceNativeDsdText(
              "channel-info",
              "channel=" + std::to_string(channel) + " sampleType=" + std::to_string(info.type));
          if (!format || !asio::isSupportedChannelFormat(*format)) {
            outcome.result.failureKind = AsioOpenFailureKind::Format;
            outcome.error = "unsupported_asio_sample_type";
            return outcome;
          }
          if (nativeDsdRequested && !isDsdSampleFormat(format->logicalFormat)) {
            state->nativeDsdNegotiation = "channel-format-mismatch";
            outcome.result.failureKind = AsioOpenFailureKind::Format;
            outcome.error = "ASIO driver did not switch to a Native DSD sample type";
            return outcome;
          }
          if (nativeDsdRequested && firstNativeDsdChannelFormat.has_value() &&
              !asio::channelFormatsMatch(*firstNativeDsdChannelFormat, *format)) {
            state->nativeDsdNegotiation = "channel-format-mismatch";
            outcome.result.failureKind = AsioOpenFailureKind::Format;
            outcome.error = "ASIO driver reported inconsistent Native DSD channel sample types";
            return outcome;
          }
          if (nativeDsdRequested) firstNativeDsdChannelFormat = *format;
          // The driver owns the Native DSD wire sample type. Accept LSB1/MSB1/NER8
          // even when it differs from the source bit order; AudioPipeline converts
          // the source bytes to the runtime type before the planar ASIO write.
          state->channelFormats.push_back(*format);
        }
        traceAsioDriverCall("after getChannelInfo");
        int32_t inputLatency = 0;
        int32_t outputLatency = 0;
        traceAsioDriverCall("before getLatencies");
        if (asio_abi::asioErrorIsSuccess(state->driver->getLatencies(&inputLatency, &outputLatency))) {
          state->latency = outputLatency;
        } else {
          // Emulated and proxy drivers (ASIO4ALL, ASIO2WASAPI, WINE) commonly
          // return ASE_NotPresent before buffers exist. Tolerate it as zero —
          // the post-createBuffers latency re-read fills in the real value —
          // instead of failing the whole driver.
          state->latency = 0;
        }
        traceAsioDriverCall("after getLatencies");
        std::array<char, 32> driverName{};
        traceAsioDriverCall("before getDriverName");
        state->driver->getDriverName(driverName.data());
        traceAsioDriverCall("after getDriverName");
        outcome.result.driverName = driverName.data();
        outcome.result.driverVersion = state->driver->getDriverVersion();
        const AudioSampleFormat actualSampleFormat = state->channelFormats.front().logicalFormat;
        const int actualSemanticRate = static_cast<int>(roundedRate);
        if (nativeDsdRequested && actualSemanticRate != config.format.sampleRate) {
          state->nativeDsdNegotiation = "sample-rate-mismatch";
          outcome.result.failureKind = AsioOpenFailureKind::Format;
          outcome.error = "ASIO driver returned a Native DSD semantic rate different from the requested stream";
          return outcome;
        }
        if (nativeDsdRequested && state->nativeDsdNegotiation == "get-unsupported") {
          state->nativeDsdNegotiation = "runtime-confirmed";
        }
        outcome.result.actualFormat = config.format;
        outcome.result.actualFormat.sampleRate = actualSemanticRate;
        outcome.result.actualFormat.sampleFormat = actualSampleFormat;
        outcome.result.actualFormat.bitDepth = bitDepthForFormat(outcome.result.actualFormat.sampleFormat);
        outcome.result.bufferSizeFrames = state->bufferSize;
        outcome.result.latencyFrames = state->latency;
        outcome.result.nativeDsdNegotiation = state->nativeDsdNegotiation;
        outcome.result.failureKind = AsioOpenFailureKind::None;
        outcome.ok = true;
        return outcome;
      },
      error);

  if (!operation || !operation->ok) {
    if (result) {
      result->nativeDsdNegotiation = state->nativeDsdNegotiation;
      // A control-thread timeout or rejection leaves no outcome; treat that as a
      // driver fault so the caller stops rather than hammering a wedged driver.
      result->failureKind =
          operation ? operation->result.failureKind : AsioOpenFailureKind::Driver;
    }
    if (error && operation) *error = operation->error;
    close();
    return false;
  }
  if (result) *result = operation->result;
  controlThread_->setMaintenance([state] { state->drainEvents(); });
  return true;
}

bool AsioDriverSession::probe(AsioDeviceInfo* info, std::string* error) {
  if (!info) {
    if (error) *error = "ASIO capability probe requires an output record";
    return false;
  }
  if (!controlThread_ || !controlThread_->start(error)) return false;

  const auto state = state_;
  const auto operation = controlThread_->call(
      [state, clsidText = entry_.clsid, systemReference = controlThread_->systemReference()]() {
        struct ProbeState {
          bool ok = false;
          AsioDeviceInfo info;
          std::string error;
        } outcome;

        CLSID clsid{};
        const std::wstring wideClsid(clsidText.begin(), clsidText.end());
        if (FAILED(CLSIDFromString(wideClsid.c_str(), &clsid))) {
          outcome.error = "ASIO driver CLSID is invalid";
          return outcome;
        }
        asio_abi::AsioDriver* driver = nullptr;
        const HRESULT activation = CoCreateInstance(
            clsid, nullptr, CLSCTX_INPROC_SERVER, clsid, reinterpret_cast<void**>(&driver));
        if (FAILED(activation) || !driver) {
          outcome.error = hresultError("ASIO driver activation failed", activation);
          return outcome;
        }
        if (!asio_abi::asioBoolIsTrue(driver->init(systemReference))) {
          outcome.error = driverError(driver, "ASIO driver initialization failed");
          driver->Release();
          return outcome;
        }

        // Everything below only reads, or writes a value we restore before
        // returning. A probe must leave the driver exactly as it found it.
        double originalRate = 0;
        const bool originalRateKnown =
            asio_abi::asioErrorIsSuccess(driver->getSampleRate(&originalRate)) && originalRate > 0;

        int32_t inputChannels = 0;
        int32_t outputChannels = 0;
        if (asio_abi::asioErrorIsSuccess(driver->getChannels(&inputChannels, &outputChannels))) {
          outcome.info.outputChannels = static_cast<int>(outputChannels);
        }

        int32_t minimum = 0;
        int32_t maximum = 0;
        int32_t preferred = 0;
        int32_t granularity = 0;
        if (asio_abi::asioErrorIsSuccess(
                driver->getBufferSize(&minimum, &maximum, &preferred, &granularity))) {
          outcome.info.minBufferSize = minimum;
          outcome.info.maxBufferSize = maximum;
          outcome.info.preferredBufferSize = preferred;
          outcome.info.bufferGranularity = granularity;
        }

        for (int rate : asioDefaultSampleRateProbeSet()) {
          if (asio_abi::asioErrorIsSuccess(driver->canSampleRate(static_cast<double>(rate)))) {
            outcome.info.supportedSampleRates.push_back(rate);
          }
        }
        if (originalRateKnown) {
          const int rounded = static_cast<int>(std::llround(originalRate));
          outcome.info.defaultSampleRate = rounded;
          if (std::find(
                  outcome.info.supportedSampleRates.begin(),
                  outcome.info.supportedSampleRates.end(),
                  rounded) == outcome.info.supportedSampleRates.end()) {
            outcome.info.supportedSampleRates.push_back(rounded);
            std::sort(outcome.info.supportedSampleRates.begin(), outcome.info.supportedSampleRates.end());
          }
        }

        // The active channel sample type is the driver's authoritative PCM wire
        // format. Record it verbatim: guessing Int16/Int24/Float32 is exactly
        // what made format selection unreliable.
        asio_abi::AsioChannelInfo channelInfo{};
        channelInfo.channel = 0;
        channelInfo.isInput = asio_abi::kAsioFalse;
        channelInfo.isActive = asio_abi::kAsioTrue;
        if (asio_abi::asioErrorIsSuccess(driver->getChannelInfo(&channelInfo))) {
          if (const auto format = channelFormatFor(channelInfo.type)) {
            outcome.info.sampleFormats.push_back(format->logicalFormat);
            outcome.info.defaultSampleFormat = format->logicalFormat;
            const int depth = bitDepthForFormat(format->logicalFormat);
            outcome.info.bitDepths.push_back(depth);
            outcome.info.defaultBitDepth = depth;
          }
        }

        int32_t inputLatency = 0;
        int32_t outputLatency = 0;
        if (asio_abi::asioErrorIsSuccess(driver->getLatencies(&inputLatency, &outputLatency))) {
          outcome.info.outputLatencyFrames = outputLatency;
        }

        std::array<char, 32> driverName{};
        driver->getDriverName(driverName.data());
        outcome.info.driverName = driverName.data();
        outcome.info.driverVersion = driver->getDriverVersion();

        // DSD capability: ask before switching. CanDo is non-destructive, so a
        // driver that answers yes here is a genuine Native DSD candidate even
        // when it omits GetIoFormat.
        asio_abi::AsioIoFormat dsdIoFormat{};
        dsdIoFormat.formatType = asio_abi::kAsioIoFormatDsd;
        if (asio_abi::asioErrorIsSuccess(driver->future(asio_abi::kFutureCanDoIoFormat, &dsdIoFormat))) {
          outcome.info.nativeDsdCapable = true;
          // Most drivers only accept DSD semantic rates while a DSD I/O format
          // is active, so switch first and restore below. Probing these rates
          // against a PCM-mode driver reports nothing and would understate the
          // device.
          asio_abi::AsioIoFormat probeIoFormat{};
          probeIoFormat.formatType = asio_abi::kAsioIoFormatDsd;
          const bool dsdModeEntered =
              asio_abi::asioErrorIsSuccess(driver->future(asio_abi::kFutureSetIoFormat, &probeIoFormat));
          for (int rate : asioDsdSemanticRateProbeSet()) {
            if (asio_abi::asioErrorIsSuccess(driver->canSampleRate(static_cast<double>(rate)))) {
              outcome.info.nativeDsdSampleRates.push_back(rate);
            }
          }
          if (dsdModeEntered) {
            asio_abi::AsioIoFormat restoreIoFormat{};
            restoreIoFormat.formatType = asio_abi::kAsioIoFormatPcm;
            driver->future(asio_abi::kFutureSetIoFormat, &restoreIoFormat);
          }
          outcome.info.nativeDsdSampleFormats = {
              AudioSampleFormat::DsdInt8Msb1,
              AudioSampleFormat::DsdInt8Lsb1,
              AudioSampleFormat::DsdInt8Ner8};
        }

        // DoP rides a normal PCM carrier, so any driver taking a 24-bit type at
        // a DoP carrier rate can attempt it. Both rate families are probed to
        // match dopCarrierFormatForDsd's carrier table: a 48k-family source
        // needs 192k/384k/768k/1536k carriers, and understating them here
        // mislabels capable devices.
        for (int rate : {176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000}) {
          if (std::find(
                  outcome.info.supportedSampleRates.begin(),
                  outcome.info.supportedSampleRates.end(),
                  rate) != outcome.info.supportedSampleRates.end()) {
            outcome.info.dopCarrierSampleRates.push_back(rate);
          }
        }
        if (!outcome.info.dopCarrierSampleRates.empty()) {
          outcome.info.dopCapable = true;
          outcome.info.dopCarrierSampleFormats = {
              AudioSampleFormat::Int24Interleaved,
              AudioSampleFormat::Int24In32Interleaved,
              AudioSampleFormat::Int32Interleaved};
        }

        if (originalRateKnown) driver->setSampleRate(originalRate);
        driver->Release();
        outcome.ok = outcome.info.outputChannels > 0 || !outcome.info.supportedSampleRates.empty();
        if (!outcome.ok) outcome.error = "ASIO driver did not report any usable capability";
        return outcome;
      },
      error);

  if (!operation || !operation->ok) {
    if (error && operation && !operation->error.empty()) *error = operation->error;
    return false;
  }

  // Identity fields stay owned by the catalog entry; the probe only contributes
  // capabilities.
  AsioDeviceInfo probed = operation->info;
  probed.id = info->id;
  probed.name = info->name;
  probed.isDefault = info->isDefault;
  if (probed.driverName.empty()) probed.driverName = info->driverName;
  probed.capabilityVersion = info->capabilityVersion;
  *info = probed;
  return true;
}

bool AsioDriverSession::createBuffers(
    AsioBufferSwitchCallback bufferSwitch,
    AsioEventCallback eventCallback,
    std::string* error) {
  const auto state = state_;
  const auto operation = controlThread_->call(
      [state, bufferSwitch = std::move(bufferSwitch), eventCallback = std::move(eventCallback)]() mutable {
        if (!state->driver || !state->initialized || state->buffersCreated) return false;
        state->bufferSwitch = std::move(bufferSwitch);
        state->eventCallback = std::move(eventCallback);
        const auto prepareBuffers = [state]() {
          state->buffers.assign(state->channelFormats.size(), {});
          for (size_t channel = 0; channel < state->buffers.size(); ++channel) {
            state->buffers[channel].isInput = asio_abi::kAsioFalse;
            state->buffers[channel].channelNum = static_cast<int32_t>(channel);
          }
        };
        prepareBuffers();
        std::string installError;
        if (!AsioCallbackRouter::install(state.get(), &installError)) return false;
        state->callbacks = AsioCallbackRouter::callbacks();
        const auto attemptCreateBuffers = [state](int32_t size) {
          return state->driver->createBuffers(
              state->buffers.data(),
              static_cast<int32_t>(state->buffers.size()),
              size,
              &state->callbacks);
        };
        traceAsioDriverCall("before createBuffers");
        auto createBuffersResult = attemptCreateBuffers(state->bufferSize);
        traceNativeDsdResult(
            state->driver,
            "create-buffers",
            createBuffersResult,
            static_cast<double>(state->bufferSize));
        if (!asio_abi::asioErrorIsSuccess(createBuffersResult)) {
          // JUCE and PortAudio both carry this retry: some drivers report a
          // range but only accept createBuffers at their preferred size (the
          // Hoontech DSP24 class). One bounded retry at preferred, then fail.
          int32_t retryMinimum = 0;
          int32_t retryMaximum = 0;
          int32_t retryPreferred = 0;
          int32_t retryGranularity = 0;
          if (asio_abi::asioErrorIsSuccess(state->driver->getBufferSize(
                  &retryMinimum, &retryMaximum, &retryPreferred, &retryGranularity))) {
            const int32_t preferredSize =
                chooseBufferSize(0, retryMinimum, retryMaximum, retryPreferred, retryGranularity);
            if (preferredSize > 0 && preferredSize != state->bufferSize) {
              prepareBuffers();
              state->bufferSize = preferredSize;
              traceAsioDriverCall("before createBuffers (preferred retry)");
              createBuffersResult = attemptCreateBuffers(state->bufferSize);
              traceNativeDsdResult(
                  state->driver,
                  "create-buffers-retry",
                  createBuffersResult,
                  static_cast<double>(state->bufferSize));
            }
          }
        }
        if (!asio_abi::asioErrorIsSuccess(createBuffersResult)) {
          // Last resort mirroring JUCE's init-time "Cubase dance": some
          // drivers only complete internal initialization after one dummy
          // engine round (dummy buffers -> start -> 80ms -> stop -> dispose)
          // and refuse every createBuffers until then. Bounded to this
          // failure path so healthy drivers never pay the 80ms.
          int32_t danceMinimum = 0;
          int32_t danceMaximum = 0;
          int32_t dancePreferred = 0;
          int32_t danceGranularity = 0;
          int32_t danceSize = state->bufferSize;
          if (asio_abi::asioErrorIsSuccess(state->driver->getBufferSize(
                  &danceMinimum, &danceMaximum, &dancePreferred, &danceGranularity))) {
            const int32_t preferredSize =
                chooseBufferSize(0, danceMinimum, danceMaximum, dancePreferred, danceGranularity);
            if (preferredSize > 0) danceSize = preferredSize;
          }
          state->danceInProgress.store(true, std::memory_order_release);
          traceAsioDriverCall("before cubase dance");
          std::array<asio_abi::AsioBufferInfo, 2> danceBuffers{};
          const int32_t danceChannels =
              std::min<int32_t>(2, static_cast<int32_t>(state->channelFormats.size()));
          for (int32_t channel = 0; channel < danceChannels; ++channel) {
            danceBuffers[static_cast<size_t>(channel)].isInput = asio_abi::kAsioFalse;
            danceBuffers[static_cast<size_t>(channel)].channelNum = channel;
          }
          const auto danceCreateResult = state->driver->createBuffers(
              danceBuffers.data(), danceChannels, danceSize, &state->callbacks);
          traceNativeDsdResult(
              state->driver, "dance-create-buffers", danceCreateResult, static_cast<double>(danceSize));
          if (asio_abi::asioErrorIsSuccess(danceCreateResult)) {
            const auto danceStartResult = state->driver->start();
            traceNativeDsdResult(state->driver, "dance-start", danceStartResult);
            std::this_thread::sleep_for(std::chrono::milliseconds(80));
            state->driver->stop();
            state->driver->disposeBuffers();
          }
          traceAsioDriverCall("after cubase dance");
          state->danceInProgress.store(false, std::memory_order_release);
          prepareBuffers();
          createBuffersResult = attemptCreateBuffers(state->bufferSize);
          traceNativeDsdResult(
              state->driver,
              "create-buffers-after-dance",
              createBuffersResult,
              static_cast<double>(state->bufferSize));
        }
        if (!asio_abi::asioErrorIsSuccess(createBuffersResult)) {
          AsioCallbackRouter::uninstall(state.get(), nullptr);
          state->buffers.clear();
          return false;
        }
        traceAsioDriverCall("after createBuffers");
        int32_t inputLatency = 0;
        int32_t outputLatency = 0;
        if (asio_abi::asioErrorIsSuccess(state->driver->getLatencies(&inputLatency, &outputLatency))) {
          state->latency = outputLatency;
        }
        state->buffersCreated = true;
        return true;
      },
      error);
  if (!operation || !*operation) {
    if (error && error->empty()) *error = "ASIO buffer creation failed";
    return false;
  }
  return true;
}

bool AsioDriverSession::start(std::string* error) {
  const auto state = state_;
  const auto operation = controlThread_->call(
      [state] {
        if (!state->driver || !state->buffersCreated || state->started) return false;
        state->running = true;
        traceAsioDriverCall("before start");
        if (!asio_abi::asioErrorIsSuccess(state->driver->start())) {
          state->running = false;
          return false;
        }
        traceAsioDriverCall("after start");
        state->started = true;
        return true;
      },
      error);
  if (!operation || !*operation) {
    if (error && error->empty()) *error = "ASIO driver start failed";
    return false;
  }
  return true;
}

void AsioDriverSession::stop() {
  const auto state = state_;
  std::string ignored;
  controlThread_->call(
      [state] {
        state->running = false;
        if (state->driver && state->started) state->driver->stop();
        state->started = false;
        return true;
      },
      &ignored);
}

void AsioDriverSession::close() {
  if (!controlThread_) return;
  const auto state = state_;
  std::string cleanupError;
  const auto operation = controlThread_->call(
      [state] {
        state->running = false;
        if (!state->driver) return true;
        traceAsioDriverCall("before close");
        if (state->started) state->driver->stop();
        state->started = false;
        if (state->buffersCreated) {
          std::string uninstallError;
          if (!AsioCallbackRouter::uninstall(state.get(), &uninstallError)) return false;
          state->driver->disposeBuffers();
          state->buffersCreated = false;
        }
        state->restoreNativeDsdConfiguration();
        state->buffers.clear();
        state->channelFormats.clear();
        state->bufferSwitch = nullptr;
        state->eventCallback = nullptr;
        traceAsioDriverCall("before Release");
        state->driver->Release();
        traceAsioDriverCall("after Release");
        state->driver = nullptr;
        state->initialized = false;
        return true;
      },
      &cleanupError);
  controlThread_->setMaintenance(nullptr);
  if (!operation || !*operation) {
    traceAsioDriverCall(("close cleanup incomplete: " + cleanupError).c_str());
    // The worker is wedged inside a driver call and this session is being
    // abandoned; the cleanup lambda above will never run. The process-wide
    // callback router still points at this session's State, so without a
    // forced release every future ASIO session fails at install ("only one
    // ASIO session may own the callback router") until process restart, and a
    // late driver callback could reach freed memory. The router's dispatch
    // double-check makes this race-free: callbacks arriving after the CAS see
    // a null target and no-op. The drain result is best-effort — the CAS is
    // the part that matters.
    std::string forceError;
    AsioCallbackRouter::uninstall(state.get(), &forceError);
    traceAsioDriverCall(("forced callback router release: " + forceError).c_str());
    return;
  }
}

void* AsioDriverSession::outputBuffer(long channel, long bufferIndex) const {
  if (channel < 0 || bufferIndex < 0 || bufferIndex > 1) return nullptr;
  const size_t channelIndex = static_cast<size_t>(channel);
  if (channelIndex >= state_->buffers.size()) return nullptr;
  return state_->buffers[channelIndex].buffers[static_cast<size_t>(bufferIndex)];
}

AsioChannelFormat AsioDriverSession::outputChannelFormat(long channel) const {
  if (channel >= 0 && static_cast<size_t>(channel) < state_->channelFormats.size()) {
    return state_->channelFormats[static_cast<size_t>(channel)];
  }
  return {};
}

bool AsioDriverSession::outputReady() {
  if (!state_->running.load(std::memory_order_acquire) || !state_->driver) return false;
  return asio_abi::asioErrorIsSuccess(state_->driver->outputReady());
}

long AsioDriverSession::activeBufferSize() const { return state_->bufferSize; }

}  // namespace twilight::audio::asio_windows
