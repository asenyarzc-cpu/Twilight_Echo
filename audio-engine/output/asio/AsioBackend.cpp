#include "AsioBackend.h"
#include "AsioRenderUtils.h"
#include "DeviceCapabilityCache.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <charconv>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <set>
#include <thread>
#include <tuple>
#include <vector>

namespace twilight::audio {
namespace {

int normalizeBitDepth(int bitDepth) {
  if (bitDepth <= 1) return 1;
  if (bitDepth <= 16) return 16;
  if (bitDepth <= 24) return 24;
  return 32;
}

int bitDepthForFormat(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::DsdInt8Lsb1:
    case AudioSampleFormat::DsdInt8Msb1:
    case AudioSampleFormat::DsdInt8Ner8:
      return 1;
    case AudioSampleFormat::Int16Interleaved:
      return 16;
    case AudioSampleFormat::Int24Interleaved:
    case AudioSampleFormat::Int24In32Interleaved:
      return 24;
    case AudioSampleFormat::Int32Interleaved:
    case AudioSampleFormat::Float32Interleaved:
    default:
      return 32;
  }
}

bool sameFormat(const AudioFormat& a, const AudioFormat& b) {
  if (isDsdSampleFormat(a.sampleFormat) || isDsdSampleFormat(b.sampleFormat)) {
    return dsdFormatsExactMatch(a, b);
  }
  return a.sampleRate == b.sampleRate && a.channelCount == b.channelCount &&
         normalizeBitDepth(a.bitDepth) == normalizeBitDepth(b.bitDepth) &&
         a.sampleFormat == b.sampleFormat;
}

bool sameAsioTransportFormat(const AudioFormat& requested, const AudioFormat& actual) {
  if (sameFormat(requested, actual)) return true;
  return isDopCarrierFormat(requested) && isDopCarrierFormat(actual) &&
         requested.sampleRate == actual.sampleRate && requested.channelCount == actual.channelCount;
}

AudioFormat normalizeAsioDopOutputFormat(const AudioFormat& requested, AudioFormat actual) {
  if (isDopCarrierFormat(requested) && actual.sampleFormat == AudioSampleFormat::Int32Interleaved &&
      requested.sampleRate == actual.sampleRate && requested.channelCount == actual.channelCount) {
    actual.sampleFormat = AudioSampleFormat::Int24In32Interleaved;
    actual.bitDepth = 24;
  }
  return actual;
}

AsioChannelFormat normalizeAsioDopChannelFormat(
    const AudioFormat& requested,
    AsioChannelFormat actual) {
  if (isDopCarrierFormat(requested) && actual.logicalFormat == AudioSampleFormat::Int32Interleaved &&
      actual.containerBits == 32 && actual.littleEndian && actual.dsdPacking == AsioDsdPacking::None) {
    actual.logicalFormat = AudioSampleFormat::Int24In32Interleaved;
    actual.validBits = 24;
    actual.validBitsAreMostSignificant = true;
  }
  return actual;
}

bool sameNativeDsdStream(const AudioFormat& requested, const AudioFormat& actual) {
  return isDsdSampleFormat(requested.sampleFormat) && isDsdSampleFormat(actual.sampleFormat) &&
         requested.sampleRate == actual.sampleRate && requested.channelCount == actual.channelCount &&
         effectivePcmBitDepth(requested) == 1 && effectivePcmBitDepth(actual) == 1;
}

void appendDecimal(std::string& output, uint64_t value) {
  char digits[32] = {};
  const auto [end, error] = std::to_chars(digits, digits + sizeof(digits), value);
  if (error == std::errc{}) output.append(digits, end);
}

void appendHex(std::string& output, uint64_t value) {
  char digits[32] = {};
  const auto [end, error] = std::to_chars(digits, digits + sizeof(digits), value, 16);
  if (error == std::errc{}) output.append(digits, end);
}

std::string nativeDsdBufferSummary(size_t inspected, uint8_t idleByte, uint64_t hash) {
  std::string summary;
  summary.reserve(96);
  summary += "native-dsd bytes=";
  appendDecimal(summary, inspected);
  summary += " idle=0x";
  appendHex(summary, idleByte);
  summary += " fnv64=0x";
  appendHex(summary, hash);
  return summary;
}

bool hasAlternatingDopMarkers(
    const uint8_t* data,
    size_t frameCount,
    int channels,
    AudioSampleFormat format) {
  if (!data || frameCount < 2 || channels <= 0 || !isDopCarrierSampleFormat(format)) {
    return false;
  }
  const size_t bytesPerSample = audioSampleFormatBytes(format);
  if (bytesPerSample < 3) return false;
  const size_t channelCount = static_cast<size_t>(channels);
  uint8_t expected = data[bytesPerSample - 1];
  if (expected != 0x05 && expected != 0xfa) return false;
  for (size_t frame = 0; frame < frameCount; ++frame) {
    for (size_t channel = 0; channel < channelCount; ++channel) {
      const size_t offset = (frame * channelCount + channel) * bytesPerSample;
      if (data[offset + bytesPerSample - 1] != expected) return false;
    }
    expected = expected == 0x05 ? 0xfa : 0x05;
  }
  return true;
}

bool containsFormat(const std::vector<AudioSampleFormat>& formats, AudioSampleFormat format) {
  return std::find(formats.begin(), formats.end(), format) != formats.end();
}

void appendUniqueSampleRates(std::vector<int>* sampleRates, const std::vector<int>& extraSampleRates) {
  if (!sampleRates) return;
  for (int sampleRate : extraSampleRates) {
    if (sampleRate > 0 && std::find(sampleRates->begin(), sampleRates->end(), sampleRate) == sampleRates->end()) {
      sampleRates->push_back(sampleRate);
    }
  }
}

void appendUniqueSampleFormats(std::vector<AudioSampleFormat>* formats, const std::vector<AudioSampleFormat>& extraFormats) {
  if (!formats) return;
  for (AudioSampleFormat format : extraFormats) {
    if (!containsFormat(*formats, format)) formats->push_back(format);
  }
}

bool isNativeDsdRequest(const AudioFormat& format) {
  return format.sampleRate >= 2822400 && format.channelCount > 0 && effectivePcmBitDepth(format) == 1 &&
         isDsdSampleFormat(format.sampleFormat);
}

std::vector<std::string> sampleFormatNames(const std::vector<AudioSampleFormat>& formats) {
  std::vector<std::string> names;
  names.reserve(formats.size());
  for (AudioSampleFormat format : formats) {
    names.push_back(sampleFormatToString(format));
  }
  return names;
}

double asioCallbackFrameRate(const AudioFormat& format) {
  return static_cast<double>(std::max(1, asio::callbackFrameRate(format)));
}

std::string hostEventPrefix(AsioHostEvent event) {
  switch (event) {
    case AsioHostEvent::DriverReset:
      return "ASIO driver reset";
    case AsioHostEvent::DriverRestart:
      return "ASIO driver restart";
    case AsioHostEvent::DeviceLost:
      return "ASIO device lost";
    case AsioHostEvent::Xrun:
      return "ASIO driver load event";
    case AsioHostEvent::HelperFailure:
      return "ASIO helper failure";
    case AsioHostEvent::BufferFailure:
    default:
      return "ASIO buffer failure";
  }
}

std::string helperFailureReasonCode(const std::string& message) {
  if (!message.starts_with("asio_helper_")) return "asio_helper_process_exited";
  const size_t separator = message.find(':');
  return message.substr(0, separator);
}

bool isHelperError(const std::string& message) {
  return message.starts_with("asio_helper_");
}

bool isFatalHelperError(const std::string& message) {
  if (!isHelperError(message)) return false;
  return !message.starts_with("asio_helper_device_rejected");
}

std::string hostFailureReasonCode(const std::string& message, const char* fallback) {
  return isHelperError(message) ? helperFailureReasonCode(message) : fallback;
}

std::string hostEventReason(AsioHostEvent event, const std::string& message) {
  const auto prefix = hostEventPrefix(event);
  return message.empty() ? prefix : prefix + ": " + message;
}

std::string nativeDsdRuntimeStateName(NativeDsdRuntimeFactState state) {
  switch (state) {
    case NativeDsdRuntimeFactState::Candidate:
      return "candidate";
    case NativeDsdRuntimeFactState::Unproven:
      return "unproven";
    case NativeDsdRuntimeFactState::Mismatch:
      return "mismatch";
    case NativeDsdRuntimeFactState::Proven:
      return "proven";
    case NativeDsdRuntimeFactState::Unsupported:
    default:
      return "unsupported";
  }
}

std::string dsdBufferUnitAdaptedReason() {
  return "ASIO callback cadence implies the driver counts DSD buffers in 1-bit samples; render unit "
         "adapted to bufferSize/8 packed byte-frames so every write stays inside the driver buffer";
}

void applyNativeDsdFactsToOutputInfo(OutputInfo* info, const NativeDsdRuntimeFacts& facts) {
  if (!info) return;
  info->nativeDsdRuntimeState = nativeDsdRuntimeStateName(facts.state);
  info->nativeDsdRequestedRate = facts.requestedDsdRate;
  info->nativeDsdActualRate = facts.actualDsdRate;
  info->nativeDsdChannels = facts.channelCount;
  info->nativeDsdExplicitlyCapable = facts.explicitlyCapable;
  info->nativeDsdAdvertisedSampleRates = facts.advertisedSampleRates;
  info->nativeDsdRuntimeReason = facts.reason;
  if (facts.explicitlyCapable) info->driverNativeDsdCapable = true;
  if (facts.actualDsdRate > 0 &&
      std::find(
          info->driverNativeDsdSampleRates.begin(),
          info->driverNativeDsdSampleRates.end(),
          facts.actualDsdRate) == info->driverNativeDsdSampleRates.end()) {
    info->driverNativeDsdSampleRates.push_back(facts.actualDsdRate);
  }
}

bool explicitBufferSizeAllowed(uint32_t size) {
  static constexpr uint32_t kAllowed[] = {64, 128, 256, 512, 1024, 2048};
  return std::find(std::begin(kAllowed), std::end(kAllowed), size) != std::end(kAllowed);
}

AudioFormat emptyFormat() {
  return {};
}

bool containsSampleRate(const std::vector<int>& sampleRates, int sampleRate) {
  return std::find(sampleRates.begin(), sampleRates.end(), sampleRate) != sampleRates.end();
}

bool containsSampleFormat(const std::vector<AudioSampleFormat>& sampleFormats, AudioSampleFormat sampleFormat) {
  return std::find(sampleFormats.begin(), sampleFormats.end(), sampleFormat) != sampleFormats.end();
}

DopRuntimeFacts buildAsioDopRuntimeFacts(
    const AsioDeviceInfo& device,
    const AudioFormat& candidateFormat,
    const AudioFormat& actualFormat,
    bool actualObserved,
    bool actualChannelFormatsMatch) {
  DopRuntimeFacts facts;
  if (!isDopCarrierFormat(candidateFormat)) return facts;

  facts.candidateFormat = candidateFormat;
  facts.explicitlyCapable =
      device.dopCapable && containsSampleRate(device.dopCarrierSampleRates, candidateFormat.sampleRate) &&
      containsSampleFormat(device.dopCarrierSampleFormats, candidateFormat.sampleFormat);
  if (!actualObserved) {
    facts.state = DopRuntimeFactState::Candidate;
    facts.reason = facts.explicitlyCapable ? "ASIO DoP carrier candidate selected; waiting for runtime confirmation"
                                           : "ASIO DoP carrier candidate selected without explicit driver proof";
    return facts;
  }

  if (!actualChannelFormatsMatch) {
    facts.state = DopRuntimeFactState::Mismatch;
    facts.reason = "ASIO runtime channel sample formats differ; cannot prove a single DoP carrier";
    return facts;
  }

  if (!isDopCarrierFormat(actualFormat)) {
    facts.state = DopRuntimeFactState::Mismatch;
    facts.reason = "ASIO actual runtime format is not a DoP carrier";
    return facts;
  }

  facts.actualFormat = actualFormat;
  if (!sameAsioTransportFormat(candidateFormat, actualFormat)) {
    facts.state = DopRuntimeFactState::Mismatch;
    facts.reason = "ASIO actual DoP carrier does not exactly match the negotiated carrier";
    return facts;
  }

  if (!facts.explicitlyCapable) {
    // ASIO registration carries driver identity only. A number of production
    // drivers do not advertise DoP there, despite accepting an exact carrier
    // at runtime. The negotiated format is more reliable than that omission.
    facts.state = DopRuntimeFactState::Proven;
    facts.reason = "ASIO DoP carrier matched at runtime; the driver registry did not declare DoP support";
    return facts;
  }

  facts.state = DopRuntimeFactState::Proven;
  facts.reason = "ASIO driver advertised this exact DoP carrier and runtime format matched exactly";
  return facts;
}

NativeDsdRuntimeFacts buildAsioNativeDsdRuntimeFacts(
    const AsioDeviceInfo& device,
    const AudioFormat& requestedFormat,
    const AudioFormat& actualFormat,
    bool actualObserved,
    bool actualChannelFormatsMatch,
    bool rawDsdPathStarted) {
  NativeDsdRuntimeFacts facts;
  facts.requestedDsdRate = requestedFormat.sampleRate >= 2822400 ? requestedFormat.sampleRate : 0;
  facts.channelCount = requestedFormat.channelCount;
  facts.explicitlyCapable = device.nativeDsdCapable;
  facts.advertisedSampleRates = device.nativeDsdSampleRates;

  if (facts.requestedDsdRate <= 0) {
    facts.state = NativeDsdRuntimeFactState::Unsupported;
    facts.reason = "No Native DSD stream was requested";
    return facts;
  }

  if (!isDsdSampleFormat(requestedFormat.sampleFormat) || effectivePcmBitDepth(requestedFormat) != 1) {
    facts.state = NativeDsdRuntimeFactState::Unsupported;
    facts.reason = "Requested ASIO format is not raw Native DSD";
    return facts;
  }

  if (device.nativeDsdCapable && !device.nativeDsdSampleRates.empty() &&
      !containsSampleRate(device.nativeDsdSampleRates, facts.requestedDsdRate)) {
    facts.state = NativeDsdRuntimeFactState::Mismatch;
    facts.reason = "ASIO driver did not advertise the requested Native DSD rate";
    return facts;
  }

  if (device.nativeDsdCapable && !device.nativeDsdSampleFormats.empty() &&
      !containsSampleFormat(device.nativeDsdSampleFormats, requestedFormat.sampleFormat)) {
    facts.state = NativeDsdRuntimeFactState::Mismatch;
    facts.reason = "ASIO driver did not advertise the requested Native DSD sample type";
    return facts;
  }

  const bool runtimeReportsNativeDsd =
      actualObserved && actualChannelFormatsMatch && isDsdSampleFormat(actualFormat.sampleFormat) &&
      actualFormat.sampleRate == facts.requestedDsdRate;
  if (runtimeReportsNativeDsd) {
    facts.explicitlyCapable = true;
    if (!containsSampleRate(facts.advertisedSampleRates, actualFormat.sampleRate)) {
      facts.advertisedSampleRates.push_back(actualFormat.sampleRate);
    }
  }

  if (!rawDsdPathStarted) {
    facts.state = NativeDsdRuntimeFactState::Candidate;
    facts.reason = runtimeReportsNativeDsd
                       ? "ASIO runtime reports Native DSD, but raw DSD rendering is not active"
                       : "ASIO Native DSD format probe is awaiting runtime channel confirmation";
    return facts;
  }

  if (!actualObserved) {
    facts.state = NativeDsdRuntimeFactState::Candidate;
    facts.reason = "ASIO Native DSD buffers have not reported their runtime sample type";
    return facts;
  }

  if (!actualChannelFormatsMatch) {
    facts.state = NativeDsdRuntimeFactState::Mismatch;
    facts.reason = "ASIO runtime channel sample formats differ; cannot write a single Native DSD sample type";
    return facts;
  }

  if (!isDsdSampleFormat(actualFormat.sampleFormat) || actualFormat.sampleRate < 2822400) {
    facts.state = NativeDsdRuntimeFactState::Mismatch;
    facts.actualDsdRate = actualFormat.sampleRate >= 2822400 ? actualFormat.sampleRate : 0;
    facts.reason = "ASIO runtime sample type is not Native DSD";
    return facts;
  }

  facts.actualDsdRate = actualFormat.sampleRate;
  if (!sameNativeDsdStream(requestedFormat, actualFormat)) {
    facts.state = NativeDsdRuntimeFactState::Mismatch;
    facts.reason = "ASIO actual Native DSD stream rate or channel count does not match the negotiated stream";
    return facts;
  }

  facts.state = NativeDsdRuntimeFactState::Proven;
  facts.reason = requestedFormat.sampleFormat == actualFormat.sampleFormat
                     ? "ASIO Native DSD stream started with a matching runtime rate"
                     : "ASIO Native DSD stream started with a matching rate and a driver-selected wire sample type";
  return facts;
}

}  // namespace

struct AsioBackend::FormatCandidate {
  AudioFormat format;
  int sampleRateError = 0;
  int bitDepthError = 0;
  bool exact = false;
  bool isDefault = false;
};

AsioBackend::AsioBackend() : AsioBackend(createIsolatedAsioHost()) {}

AsioBackend::AsioBackend(std::unique_ptr<IAsioHost> host, AsioQuirkRegistry quirkRegistry)
    : host_(std::move(host)), quirkRegistry_(std::move(quirkRegistry)) {}

AsioBackend::~AsioBackend() {
  close();
}

const char* AsioBackend::id() const {
  return "asio";
}

bool AsioBackend::open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) {
  close();
  if (!host_) {
    if (error) *error = "当前构建未启用 ASIO 输出";
    std::lock_guard lock(mutex_);
    diagnostics_.lastError = error ? *error : "当前构建未启用 ASIO 输出";
    outputInfo_ = {};
    outputInfo_.exclusive = true;
    outputInfo_.accessMode = "exclusive";
    outputInfo_.backend = "asio";
    outputInfo_.actualBackend = "asio";
    outputInfo_.devicePathKind = "asio";
    outputInfo_.perfectReasonCode = "backend_open_failure";
    outputInfo_.capabilityReason = diagnostics_.lastError;
    outputInfo_.perfectReason = diagnostics_.lastError;
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }

  {
    std::lock_guard lock(mutex_);
    OutputInfo::Diagnostics lifetime = diagnostics_;
    diagnostics_ = {};
    diagnostics_.lifetimeUnderrunCount = lifetime.lifetimeUnderrunCount;
    diagnostics_.lifetimeBufferDropCount = lifetime.lifetimeBufferDropCount;
    diagnostics_.lifetimeRecoveryCount = lifetime.lifetimeRecoveryCount;
    diagnostics_.driverRestartCount = lifetime.driverRestartCount;
    diagnostics_.deviceLostCount = lifetime.deviceLostCount;
    recoveryAttempts_ = 0;
    recoveryWindow_.clear();
    recoveryCooldownUntil_ = {};
    recoveryInProgress_ = false;
    deviceRecovered_ = false;
    dopRuntimeFacts_ = {};
    nativeDsdRuntimeFacts_ = unsupportedNativeDsdRuntimeFacts("No Native DSD stream was requested");
    actualOutputFormatObserved_ = false;
    actualOutputChannelFormatsMatch_ = true;
    nativeDsdTypedCallbackMissing_ = false;
    pendingRenderUnderruns_.store(0, std::memory_order_relaxed);
    pendingRenderBufferDrops_.store(0, std::memory_order_relaxed);
    pendingDsdShortReads_.store(0, std::memory_order_relaxed);
    pendingDsdIdleFrames_.store(0, std::memory_order_relaxed);
    pendingNativeDsdTypedCallbackMissing_.store(false, std::memory_order_relaxed);
    pendingDsdBufferUnitAdapted_.store(false, std::memory_order_relaxed);
    firstNativeDsdBufferClaimed_.store(false, std::memory_order_relaxed);
    firstNativeDsdBufferObserved_.store(false, std::memory_order_relaxed);
    firstNativeDsdInspectedBytes_.store(0, std::memory_order_relaxed);
    firstNativeDsdIdleByte_.store(0, std::memory_order_relaxed);
    firstNativeDsdHash_.store(0, std::memory_order_relaxed);
    dopMarkerState_.store(0, std::memory_order_relaxed);
    dopMarkerFramesVerified_.store(0, std::memory_order_relaxed);
    outputInfo_ = {};
    outputInfo_.exclusive = true;
    outputInfo_.accessMode = "exclusive";
    outputInfo_.backend = "asio";
    outputInfo_.actualBackend = "asio";
    outputInfo_.devicePathKind = "asio";
    outputInfo_.diagnostics = diagnostics_;
    outputInfo_.deviceRecovered = false;
    outputInfo_.recoveryCount = recoveryCount_;
  }

  const AsioHostDiagnostics hostDiagnostics = host_->diagnostics();
  diagnostics_.processArchitecture = hostDiagnostics.processArchitecture;
  diagnostics_.asioBuildEnabled = hostDiagnostics.buildEnabled;
  diagnostics_.asioEnvironmentDisabled = hostDiagnostics.environmentDisabled;
  diagnostics_.asioRegisteredDriverCount32 = hostDiagnostics.registeredDriverCount32;
  diagnostics_.asioRegisteredDriverCount64 = hostDiagnostics.registeredDriverCount64;
  diagnostics_.asioLoadableDriverCount64 = hostDiagnostics.loadableDriverCount64;

  const auto devices = host_->enumerateDevices();
  if (devices.empty()) {
    const std::string hostError = host_->lastCloseError();
    std::string reason = isHelperError(hostError) ? hostError : "未找到可用 ASIO 驱动";
    if (!isHelperError(hostError) && !hostDiagnostics.buildEnabled) {
      reason = "当前构建未启用 Windows x64 ASIO 输出";
    } else if (!isHelperError(hostError) && hostDiagnostics.environmentDisabled) {
      reason = "ASIO 已被 TWILIGHT_DISABLE_ASIO=1 禁用";
    } else if (!isHelperError(hostError) &&
        hostDiagnostics.registeredDriverCount32 > 0 &&
        hostDiagnostics.registeredDriverCount64 == 0) {
      reason = "仅检测到 32 位 ASIO 驱动；Twilight Echo x64 需要安装对应的 64 位 ASIO 驱动";
    } else if (!isHelperError(hostError) &&
        hostDiagnostics.registeredDriverCount64 > 0 &&
        hostDiagnostics.loadableDriverCount64 == 0) {
      reason = "检测到 64 位 ASIO 注册项，但未找到可加载的 64 位进程内驱动 DLL";
    }
    if (error) *error = reason;
    diagnostics_.lastError = reason;
    outputInfo_.backend = "asio";
    outputInfo_.actualBackend = "asio";
    outputInfo_.accessMode = "exclusive";
    outputInfo_.devicePathKind = "asio";
    outputInfo_.perfectReasonCode = hostFailureReasonCode(reason, "device_not_found");
    outputInfo_.capabilityReason = diagnostics_.lastError;
    outputInfo_.perfectReason = diagnostics_.lastError;
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }

  const auto deviceIt = std::find_if(devices.begin(), devices.end(), [&](const AsioDeviceInfo& device) {
    return deviceId.empty() || deviceId == "auto" || device.id == deviceId || device.name == deviceId ||
           device.driverName == deviceId || ("asio:" + device.driverName) == deviceId;
  });
  if (deviceIt == devices.end()) {
    if (error) *error = "无法找到请求的 ASIO 设备：" + deviceId;
    diagnostics_.lastError = error ? *error : "无法找到请求的 ASIO 设备";
    outputInfo_.backend = "asio";
    outputInfo_.actualBackend = "asio";
    outputInfo_.accessMode = "exclusive";
    outputInfo_.devicePathKind = "asio";
    outputInfo_.perfectReasonCode = "device_not_found";
    outputInfo_.capabilityReason = diagnostics_.lastError;
    outputInfo_.perfectReason = diagnostics_.lastError;
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }

  // The ASIO registry reports identity only. Interrogate the driver before
  // ranking formats so candidates come from real capabilities rather than a
  // hardcoded guess set.
  AsioDeviceInfo device = *deviceIt;
  std::string capabilityError;
  if (!ensureDeviceCapabilities(&device, &capabilityError)) {
    if (error) *error = capabilityError;
    diagnostics_.lastError = capabilityError;
    outputInfo_.deviceName = device.name.empty() ? device.driverName : device.name;
    outputInfo_.actualDeviceName = outputInfo_.deviceName;
    outputInfo_.driverName = device.driverName;
    outputInfo_.actualDriverName = device.driverName;
    outputInfo_.perfectReasonCode = hostFailureReasonCode(capabilityError, "backend_open_failure");
    outputInfo_.capabilityReason = capabilityError;
    outputInfo_.perfectReason = capabilityError;
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }
  quirkApplication_ = quirkRegistry_.apply(device);
  diagnostics_.quirkRegistryState = quirkApplication_.registryState;
  diagnostics_.quirkFingerprint = quirkApplication_.fingerprint;
  diagnostics_.quirkApplied.clear();
  for (size_t index = 0; index < quirkApplication_.applied.size(); ++index) {
    if (index != 0) diagnostics_.quirkApplied += ",";
    diagnostics_.quirkApplied += quirkApplication_.applied[index];
  }

  AudioFormat selected;
  const std::vector<AudioFormat> candidates = rankFormatCandidates(device, requestedFormat);
  if (candidates.empty()) {
    if (error) *error = "ASIO 设备没有可协商的输出格式";
    diagnostics_.lastError = error ? *error : "ASIO 设备没有可协商的输出格式";
    outputInfo_.backend = "asio";
    outputInfo_.actualBackend = "asio";
    outputInfo_.accessMode = "exclusive";
    outputInfo_.devicePathKind = "asio";
    outputInfo_.deviceName = device.name.empty() ? device.driverName : device.name;
    outputInfo_.actualDeviceName = outputInfo_.deviceName;
    outputInfo_.driverName = device.driverName;
    outputInfo_.actualDriverName = device.driverName;
    outputInfo_.perfectReasonCode = "format_not_supported";
    outputInfo_.capabilityReason = diagnostics_.lastError;
    outputInfo_.perfectReason = diagnostics_.lastError;
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }
  deviceInfo_ = device;
  openConfig_.deviceId = device.id;
  openConfig_.sampleFormatMapping = quirkApplication_.sampleFormatMapping;
  openConfig_.nativeDsdControlOrder = quirkApplication_.dsdControlOrder;
  openConfig_.dsdMinimumBufferFrames = quirkApplication_.dsdMinimumBufferFrames;
  openConfig_.dsdCadenceConfirmCallbacks = quirkApplication_.dsdCadenceConfirmCallbacks;

  // Walk the ranked candidates. A driver may reject a rate or sample type that
  // looked plausible from its capability record, and a single rejection must
  // not become "audio engine unavailable" while other candidates remain.
  AsioOpenResult result;
  std::string lastOpenError;
  bool opened = false;
  for (const AudioFormat& candidate : candidates) {
    AudioFormat attempt = candidate;
    attempt.channelCount = routedOutputChannels(deviceInfo_, requestedFormat.channelCount);
    openConfig_.format = attempt;
    openConfig_.bufferSizeFrames = chooseBufferSize(deviceInfo_, attempt);

    std::string attemptError;
    result = AsioOpenResult{};
    if (host_->open(openConfig_, &result, &attemptError)) {
      selected = attempt;
      opened = true;
      break;
    }
    if (lastOpenError.empty() || !attemptError.empty()) lastOpenError = attemptError;
    host_->close();
    const std::string closeError = host_->lastCloseError();
    if (isFatalHelperError(closeError)) {
      lastOpenError = closeError;
      result.failureKind = AsioOpenFailureKind::Driver;
      break;
    }
    // Only a format refusal leaves another candidate worth trying. A driver-wide
    // fault rejects everything identically, so retrying would just bury the real
    // error behind the last candidate's message.
    if (result.failureKind == AsioOpenFailureKind::Driver) break;
  }

  if (!opened) {
    if (error) {
      *error = lastOpenError.empty() ? "ASIO 设备拒绝了所有候选输出格式" : lastOpenError;
    }
    diagnostics_.nativeDsdNegotiation = result.nativeDsdNegotiation;
    diagnostics_.lastError = error ? *error : "ASIO 设备拒绝了所有候选输出格式";
    outputInfo_.backend = "asio";
    outputInfo_.actualBackend = "asio";
    outputInfo_.accessMode = "exclusive";
    outputInfo_.devicePathKind = "asio";
    outputInfo_.deviceName = device.name.empty() ? device.driverName : device.name;
    outputInfo_.actualDeviceName = outputInfo_.deviceName;
    outputInfo_.driverName = device.driverName;
    outputInfo_.actualDriverName = device.driverName;
    outputInfo_.perfectReasonCode = hostFailureReasonCode(lastOpenError, "backend_open_failure");
    outputInfo_.capabilityReason = diagnostics_.lastError;
    outputInfo_.perfectReason = diagnostics_.lastError;
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }

  diagnostics_.nativeDsdNegotiation = result.nativeDsdNegotiation;

  outputFormat_ = result.actualFormat;
  if (outputFormat_.sampleRate <= 0) outputFormat_.sampleRate = selected.sampleRate;
  outputFormat_.channelCount = requestedFormat.channelCount > 0 ? requestedFormat.channelCount : selected.channelCount;
  if (outputFormat_.bitDepth <= 0) outputFormat_.bitDepth = selected.bitDepth;
  outputFormat_ = normalizeAsioDopOutputFormat(openConfig_.format, outputFormat_);
  driverName_ = result.driverName.empty() ? device.driverName : result.driverName;
  driverVersion_ = result.driverVersion;
  bufferSizeFrames_ = result.bufferSizeFrames;
  latencyFrames_ = result.latencyFrames;
  deviceName_ = device.name.empty() ? driverName_ : device.name;

  outputInfo_ = {};
  outputInfo_.exclusive = true;
  outputInfo_.accessMode = "exclusive";
  outputInfo_.supportsOutputPerfect = true;
  outputInfo_.sourceExact = false;
  outputInfo_.outputPerfect = false;
  outputInfo_.pcmPassthrough = false;
  // A driver that hands back int24-in-32 for a 24-bit request widened the
  // container without touching a bit, so that is not a conversion either.
  outputInfo_.resampled = !sameAsioTransportFormat(requestedFormat, outputFormat_) &&
                          !pcmFormatsSemanticallyMatch(requestedFormat, outputFormat_);
  outputInfo_.perfectReasonCode = outputInfo_.resampled ? "pcm_converted" : "";
  outputInfo_.perfectReason = outputInfo_.resampled ? "ASIO 输出格式已协商为驱动支持格式" : "";
  outputInfo_.outputSampleRate = outputFormat_.sampleRate;
  outputInfo_.outputBitDepth = outputFormat_.bitDepth;
  outputInfo_.outputChannels = outputFormat_.channelCount;
  outputInfo_.backend = "asio";
  outputInfo_.actualBackend = "asio";
  outputInfo_.devicePathKind = "asio";
  outputInfo_.deviceName = deviceName_;
  outputInfo_.actualDeviceName = deviceName_;
  outputInfo_.driverName = driverName_;
  outputInfo_.actualDriverName = driverName_;
  outputInfo_.driverVersion = driverVersion_;
  outputInfo_.actualDriverVersion = driverVersion_;
  outputInfo_.actualOutputFormat = sampleFormatToString(outputFormat_.sampleFormat);
  outputInfo_.actualSampleRate = outputFormat_.sampleRate;
  outputInfo_.actualBitDepth = outputFormat_.bitDepth;
  outputInfo_.actualChannels = selected.channelCount;
  outputInfo_.driverDopCapable = deviceInfo_.dopCapable;
  outputInfo_.driverNativeDsdCapable = deviceInfo_.nativeDsdCapable;
  outputInfo_.driverDopCarrierSampleRates = deviceInfo_.dopCarrierSampleRates;
  outputInfo_.driverDopCarrierFormats = sampleFormatNames(deviceInfo_.dopCarrierSampleFormats);
  outputInfo_.driverNativeDsdSampleRates = deviceInfo_.nativeDsdSampleRates;
  outputInfo_.bufferSizeFrames = static_cast<int>(bufferSizeFrames_);
  outputInfo_.latencyFrames = static_cast<int>(latencyFrames_);
  const double callbackFrameRate = asioCallbackFrameRate(outputFormat_);
  outputInfo_.latencyMs =
      callbackFrameRate > 0.0 ? static_cast<double>(latencyFrames_) * 1000.0 / callbackFrameRate : 0.0;
  outputInfo_.latencyInfo.bufferLatencyMs =
      callbackFrameRate > 0.0 ? static_cast<double>(bufferSizeFrames_) * 1000.0 / callbackFrameRate : 0.0;
  outputInfo_.latencyInfo.outputLatencyMs = outputInfo_.latencyMs;
  outputInfo_.latencyInfo.totalLatencyMs = outputInfo_.latencyInfo.bufferLatencyMs + outputInfo_.latencyInfo.outputLatencyMs;
  outputInfo_.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
  outputInfo_.diagnostics = diagnostics_;
  outputInfo_.deviceRecovered = false;
  outputInfo_.recoveryCount = recoveryCount_;
  dopRuntimeFacts_ = buildAsioDopRuntimeFacts(
      deviceInfo_,
      openConfig_.format,
      emptyFormat(),
      actualOutputFormatObserved_,
      actualOutputChannelFormatsMatch_);
  diagnostics_.dopRuntimeEvidence = dopRuntimeFacts_.reason;
  nativeDsdRuntimeFacts_ = buildAsioNativeDsdRuntimeFacts(
      deviceInfo_,
      openConfig_.format,
      emptyFormat(),
      actualOutputFormatObserved_,
      actualOutputChannelFormatsMatch_,
      false);
  applyNativeDsdFactsToOutputInfo(&outputInfo_, nativeDsdRuntimeFacts_);
  outputInfo_.diagnostics = diagnostics_;
  if (isNativeDsdRequest(openConfig_.format)) {
    diagnostics_.dsdTransport = "asio-native";
    diagnostics_.requestedWireFormat = sampleFormatToString(openConfig_.format.sampleFormat);
    diagnostics_.actualWireFormat = sampleFormatToString(outputFormat_.sampleFormat);
    diagnostics_.containerBits = static_cast<int>(audioSampleFormatBytes(outputFormat_.sampleFormat) * 8);
    diagnostics_.validBits = 1;
    diagnostics_.blockAlign = outputFormat_.channelCount;
    diagnostics_.semanticSampleRate = outputFormat_.sampleRate;
    diagnostics_.transportSampleRate = asio::callbackFrameRate(outputFormat_);
    diagnostics_.typedRawPath = true;
    diagnostics_.processingBypassed = true;
    outputInfo_.diagnostics = diagnostics_;
  }
  opened_ = true;
  return true;
}

bool AsioBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  if (config.preferredBufferSize != 0 && !explicitBufferSizeAllowed(config.preferredBufferSize)) {
    if (error) *error = "ASIO buffer size 只支持 Auto/64/128/256/512/1024/2048";
    return false;
  }
  std::lock_guard lock(mutex_);
  outputConfig_ = config;
  outputInfo_.channelRoutingMode = channelRoutingModeToString(outputConfig_.routingMode);
  return true;
}

bool AsioBackend::start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) {
  if (!opened_) {
    if (error) *error = "ASIO 后端尚未打开";
    return false;
  }
  stopAndJoinRecoveryWorker();
  {
    std::lock_guard lock(mutex_);
    callback_ = std::move(callback);
    typedCallback_ = nullptr;
    eventCallback_ = std::move(eventCallback);
    lastRenderTime_ = {};
    renderCallbacksSeen_ = 0;
    nativeDsdTypedCallbackMissing_ = false;
    pendingDsdBufferUnitAdapted_.store(false, std::memory_order_relaxed);
  }
  return createAndStartHost(error);
}

bool AsioBackend::startTyped(
    TypedRenderCallback callback,
    RenderCallback fallbackCallback,
    OutputEventCallback eventCallback,
    std::string* error) {
  if (!opened_) {
    if (error) *error = "ASIO 后端尚未打开";
    return false;
  }
  stopAndJoinRecoveryWorker();
  {
    std::lock_guard lock(mutex_);
    typedCallback_ = std::move(callback);
    callback_ = std::move(fallbackCallback);
    eventCallback_ = std::move(eventCallback);
    lastRenderTime_ = {};
    renderCallbacksSeen_ = 0;
    nativeDsdTypedCallbackMissing_ = false;
    pendingDsdBufferUnitAdapted_.store(false, std::memory_order_relaxed);
  }
  return createAndStartHost(error);
}

void AsioBackend::stopAndJoinRecoveryWorker() {
  // A device-failure recovery may still be mid-reopen on its own thread; the
  // render path must not race it for the session/host state. recover() checks
  // stopRequested_ between every driver step, so the worker exits promptly.
  {
    std::lock_guard queueLock(recoveryQueueMutex_);
    stopRequested_ = true;
    recoveryRequests_.clear();
  }
  recoveryQueueCv_.notify_all();
  joinRecoveryThread();
  stopRequested_ = false;
}

void AsioBackend::stop() {
  {
    std::lock_guard queueLock(recoveryQueueMutex_);
    stopRequested_ = true;
    recoveryRequests_.clear();
  }
  recoveryQueueCv_.notify_all();
  joinRecoveryThread();
  running_ = false;
  if (host_) host_->stop();
}

void AsioBackend::close() {
  {
    std::lock_guard queueLock(recoveryQueueMutex_);
    stopRequested_ = true;
    recoveryRequests_.clear();
  }
  recoveryQueueCv_.notify_all();
  joinRecoveryThread();
  stop();
  std::string closeError;
  if (host_) {
    host_->close();
    closeError = host_->lastCloseError();
  }
  std::lock_guard lock(mutex_);
  const uint64_t pendingUnderruns = pendingRenderUnderruns_.exchange(0, std::memory_order_relaxed);
  const uint64_t pendingBufferDrops = pendingRenderBufferDrops_.exchange(0, std::memory_order_relaxed);
  diagnostics_.lifetimeUnderrunCount += pendingUnderruns;
  diagnostics_.lifetimeBufferDropCount += pendingBufferDrops;
  callback_ = nullptr;
  typedCallback_ = nullptr;
  eventCallback_ = nullptr;
  renderCallbackSession_ = nullptr;
  typedCallbackSession_ = nullptr;
  renderOutputConfigSession_ = {};
  renderOutputFormatSession_ = {};
  renderOpenFormatSession_ = {};
  renderBufferSizeFramesSession_ = 0;
  renderChannelFormatsMatchSession_ = true;
  renderChannelFormatsSession_.clear();
  renderDsdUnitFramesSession_ = 0;
  renderTypedPathAvailableSession_ = false;
  dsdRenderUnitProbe_ = {};
  renderScratch_.clear();
  typedRenderScratch_.clear();
  lastRenderTime_ = {};
  renderCallbacksSeen_ = 0;
  recoveryInProgress_ = false;
  dopRuntimeFacts_ = {};
  nativeDsdRuntimeFacts_ = unsupportedNativeDsdRuntimeFacts("No Native DSD stream was requested");
  actualOutputFormatObserved_ = false;
  actualOutputChannelFormatsMatch_ = true;
  nativeDsdTypedCallbackMissing_ = false;
  pendingRenderUnderruns_.store(0, std::memory_order_relaxed);
  pendingRenderBufferDrops_.store(0, std::memory_order_relaxed);
  pendingDsdShortReads_.store(0, std::memory_order_relaxed);
  pendingDsdIdleFrames_.store(0, std::memory_order_relaxed);
  pendingNativeDsdTypedCallbackMissing_.store(false, std::memory_order_relaxed);
  pendingDsdBufferUnitAdapted_.store(false, std::memory_order_relaxed);
  firstNativeDsdBufferObserved_.store(false, std::memory_order_relaxed);
  firstNativeDsdInspectedBytes_.store(0, std::memory_order_relaxed);
  firstNativeDsdIdleByte_.store(0, std::memory_order_relaxed);
  firstNativeDsdHash_.store(0, std::memory_order_relaxed);
  if (!closeError.empty()) {
    diagnostics_.lastError = closeError;
    outputInfo_.perfectReasonCode = helperFailureReasonCode(closeError);
    if (!closeError.starts_with("asio_helper_")) {
      outputInfo_.perfectReasonCode = "asio_helper_format_restore_failed";
    }
    outputInfo_.capabilityReason = closeError;
    outputInfo_.perfectReason = closeError;
    outputInfo_.diagnostics = diagnostics_;
  }
  opened_ = false;
}

AudioFormat AsioBackend::outputFormat() const {
  return outputFormat_;
}

OutputInfo AsioBackend::outputInfo() const {
  std::lock_guard lock(mutex_);
  OutputInfo info = outputInfo_;
  info.deviceRecovered = deviceRecovered_;
  info.recoveryCount = recoveryCount_;
  info.diagnostics = diagnostics_;
  const uint64_t pendingUnderruns = pendingRenderUnderruns_.load(std::memory_order_relaxed);
  const uint64_t pendingBufferDrops = pendingRenderBufferDrops_.load(std::memory_order_relaxed);
  info.diagnostics.sessionUnderrunCount += pendingUnderruns;
  info.diagnostics.lifetimeUnderrunCount += pendingUnderruns;
  info.diagnostics.sessionBufferDropCount += pendingBufferDrops;
  info.diagnostics.lifetimeBufferDropCount += pendingBufferDrops;
  info.diagnostics.dsdShortReadCount += pendingDsdShortReads_.load(std::memory_order_relaxed);
  info.diagnostics.dsdIdleFrameCount += pendingDsdIdleFrames_.load(std::memory_order_relaxed);
  if (isDopCarrierFormat(openConfig_.format)) {
    const int markerState = dopMarkerState_.load(std::memory_order_acquire);
    if (markerState == 1) {
      info.diagnostics.dopRuntimeEvidence =
          dopRuntimeFacts_.reason + "; DoP marker sequence confirmed in the first typed buffer";
    } else if (markerState == 2) {
      const std::string reason = "ASIO DoP marker sequence was invalid in the first typed buffer";
      info.diagnostics.dopRuntimeEvidence = reason;
      info.diagnostics.processingBypassed = false;
      info.perfectReasonCode = "dop_marker_mismatch";
      info.perfectReason = reason;
      info.capabilityReason = reason;
    } else {
      info.diagnostics.dopRuntimeEvidence =
          dopRuntimeFacts_.reason + "; waiting for first typed DoP marker sequence";
    }
  }
  if (firstNativeDsdBufferObserved_.load(std::memory_order_acquire)) {
    info.diagnostics.firstBufferSummary = nativeDsdBufferSummary(
        firstNativeDsdInspectedBytes_.load(std::memory_order_relaxed),
        firstNativeDsdIdleByte_.load(std::memory_order_relaxed),
        firstNativeDsdHash_.load(std::memory_order_acquire));
  }
  if (nativeDsdTypedCallbackMissing_ ||
      pendingNativeDsdTypedCallbackMissing_.load(std::memory_order_acquire)) {
    const std::string reason = "ASIO Native DSD render requires a typed raw DSD callback";
    info.perfectReasonCode = "native_dsd_typed_callback_missing";
    info.perfectReason = reason;
    info.capabilityReason = reason;
    if (info.diagnostics.lastError.empty()) info.diagnostics.lastError = reason;
  }
  if (isNativeDsdRequest(openConfig_.format) &&
      pendingDsdBufferUnitAdapted_.load(std::memory_order_acquire)) {
    // A bit-sample-counting driver no longer demotes the stream: the probe
    // unit kept every write inside the driver buffer, so passthrough holds
    // and only the report gains the adaptation note.
    info.nativeDsdRuntimeReason = dsdBufferUnitAdaptedReason();
  }
  synchronizeOutputConversionInfo(info);
  return info;
}

DopRuntimeFacts AsioBackend::dopRuntimeFacts() const {
  std::lock_guard lock(mutex_);
  DopRuntimeFacts facts = dopRuntimeFacts_;
  if (facts.state == DopRuntimeFactState::Candidate || facts.state == DopRuntimeFactState::Proven) {
    // The render thread verifies the 0x05/0xFA marker alternation in the first
    // typed DoP buffer. Fold that observation into the reported facts so the
    // pipeline can settle a Candidate instead of falling back to PCM, and a
    // broken marker stream demotes an earlier Proven claim.
    const int markerState = dopMarkerState_.load(std::memory_order_acquire);
    if (markerState == 2) {
      facts.state = DopRuntimeFactState::Mismatch;
      facts.reason = "ASIO DoP marker sequence was invalid in the first typed buffer";
    } else if (markerState == 1 && facts.state == DopRuntimeFactState::Candidate) {
      facts.state = DopRuntimeFactState::Proven;
      facts.reason = facts.explicitlyCapable
                         ? "ASIO DoP carrier matched and the marker sequence was confirmed in the first typed buffer"
                         : "ASIO DoP marker sequence confirmed in the first typed buffer";
    }
  }
  return facts;
}

NativeDsdRuntimeFacts AsioBackend::nativeDsdRuntimeFacts() const {
  std::lock_guard lock(mutex_);
  NativeDsdRuntimeFacts facts = nativeDsdRuntimeFacts_;
  // The render thread watches the callback cadence while the stream runs. A
  // driver that counts DSD buffers in 1-bit samples keeps the conservative
  // probe unit (bufferSize/8 byte-frames), which fits its buffers exactly, so
  // the observation narrows the report instead of demoting a Proven claim.
  if (pendingDsdBufferUnitAdapted_.load(std::memory_order_acquire)) {
    facts.reason = facts.reason.empty()
                       ? dsdBufferUnitAdaptedReason()
                       : facts.reason + "; " + dsdBufferUnitAdaptedReason();
  }
  return facts;
}

std::string AsioBackend::deviceName() const {
  return deviceName_;
}

bool AsioBackend::ensureDeviceCapabilities(AsioDeviceInfo* device, std::string* error) const {
  if (!device) return true;
  // Sample rates plus a sample type is the minimum needed to rank candidates
  // against reality. Anything less means this record is registry-only.
  const bool hasCapabilities = !device->supportedSampleRates.empty() && !device->sampleFormats.empty();
  if (hasCapabilities) return true;

  AsioDeviceInfo probed = *device;
  std::string probeError;
  if (host_->probeDevice(device->id, &probed, &probeError)) {
    *device = probed;
    return true;
  }
  // A probe-hostile driver still deserves an attempt. Leaving the record as-is
  // keeps the legacy guess-set path, which the candidate retry loop now makes
  // survivable.
  if (isFatalHelperError(probeError)) {
    if (error) *error = probeError;
    return false;
  }
  return true;
}

std::vector<AudioFormat> AsioBackend::rankFormatCandidates(
    const AsioDeviceInfo& device,
    const AudioFormat& requestedFormat) const {
  std::vector<AudioFormat> ranked;
  AudioFormat best;
  if (!chooseFormat(device, requestedFormat, &best)) return ranked;
  ranked.push_back(best);

  // A Native DSD request has one legal wire form per packing; the session
  // negotiates the packing itself, so alternates would only re-ask the same
  // question.
  if (isNativeDsdRequest(requestedFormat)) return ranked;

  // Alternates for PCM: keep the negotiated rate but offer the other container
  // types drivers commonly expose, then the device's own default rate. This is
  // what turns a single driver refusal from a playback failure into a retry.
  const std::array<AudioSampleFormat, 5> containerOrder = {
      AudioSampleFormat::Int32Interleaved,
      AudioSampleFormat::Int24In32Interleaved,
      AudioSampleFormat::Int24Interleaved,
      AudioSampleFormat::Float32Interleaved,
      AudioSampleFormat::Int16Interleaved};

  const auto pushCandidate = [&](int sampleRate, AudioSampleFormat sampleFormat) {
    if (sampleRate <= 0) return;
    const int depth = bitDepthForFormat(sampleFormat);
    const bool duplicate = std::any_of(ranked.begin(), ranked.end(), [&](const AudioFormat& existing) {
      return existing.sampleRate == sampleRate && existing.sampleFormat == sampleFormat;
    });
    if (duplicate) return;
    AudioFormat candidate = best;
    candidate.sampleRate = sampleRate;
    candidate.sampleFormat = sampleFormat;
    candidate.bitDepth = depth;
    ranked.push_back(candidate);
  };

  for (const AudioSampleFormat sampleFormat : containerOrder) {
    pushCandidate(best.sampleRate, sampleFormat);
  }
  if (device.defaultSampleRate > 0 && device.defaultSampleRate != best.sampleRate) {
    pushCandidate(device.defaultSampleRate, best.sampleFormat);
    for (const AudioSampleFormat sampleFormat : containerOrder) {
      pushCandidate(device.defaultSampleRate, sampleFormat);
    }
  }
  return ranked;
}

bool AsioBackend::chooseFormat(const AsioDeviceInfo& device, const AudioFormat& requestedFormat, AudioFormat* selected) const {
  if (!selected || requestedFormat.sampleRate <= 0 || requestedFormat.channelCount <= 0) return false;

  // The ASIO registry exposes driver identity, not its active sample types. Probe a
  // raw DSD request directly and only treat it as capable after getChannelInfo()
  // reports a matching DSD type at runtime.
  if (isNativeDsdRequest(requestedFormat) && !device.nativeDsdCapable) {
    *selected = requestedFormat;
    return true;
  }

  // A DSD-capable device whose probed rate list does not name this rate still
  // gets the request verbatim.
  //
  // Capability data is advisory: only the driver can actually refuse a rate, and
  // it does so at open() where the session negotiates the I/O format and the
  // candidate loop can react. Filtering the rate out here instead reports "no
  // negotiable format", which the pipeline reads as "this device cannot do DSD"
  // and answers by degrading to DoP or PCM. That made a *better* probe produce
  // *worse* routing: before capabilities were probed, this same request took the
  // branch above and passed through untouched.
  if (isNativeDsdRequest(requestedFormat) &&
      !containsSampleRate(device.nativeDsdSampleRates, requestedFormat.sampleRate)) {
    *selected = requestedFormat;
    return true;
  }

  // DoP carriers get the same treatment: the probed PCM rate list routinely
  // omits 176.4/352.8kHz-style carrier rates even when the driver accepts
  // them. Picking "nearest supported rate" here opened the device at the
  // wrong rate and silently killed passthrough, so pass the carrier through
  // verbatim and let the driver's own open() verdict decide.
  if (isDopCarrierFormat(requestedFormat)) {
    *selected = requestedFormat;
    return true;
  }

  std::vector<int> sampleRates = device.supportedSampleRates;
  if (device.dopCapable) appendUniqueSampleRates(&sampleRates, device.dopCarrierSampleRates);
  if (device.nativeDsdCapable) appendUniqueSampleRates(&sampleRates, device.nativeDsdSampleRates);
  if (sampleRates.empty() && device.defaultSampleRate > 0) sampleRates.push_back(device.defaultSampleRate);
  if (sampleRates.empty()) sampleRates = asioDefaultSampleRateProbeSet();

  std::vector<AudioSampleFormat> sampleFormats = device.sampleFormats;
  if (device.dopCapable) appendUniqueSampleFormats(&sampleFormats, device.dopCarrierSampleFormats);
  if (device.nativeDsdCapable) appendUniqueSampleFormats(&sampleFormats, device.nativeDsdSampleFormats);
  if (sampleFormats.empty()) sampleFormats.push_back(device.defaultSampleFormat);
  if (!containsFormat(sampleFormats, device.defaultSampleFormat)) sampleFormats.push_back(device.defaultSampleFormat);
  if (device.bitDepths.empty()) {
    // Int32Lsb / Int32Lsb24 are the types most professional drivers expose, and
    // some expose nothing else. Omitting them made the fallback guess miss the
    // common case outright.
    for (const AudioSampleFormat fallback : {
             AudioSampleFormat::Int16Interleaved,
             AudioSampleFormat::Int24Interleaved,
             AudioSampleFormat::Int24In32Interleaved,
             AudioSampleFormat::Int32Interleaved,
             AudioSampleFormat::Float32Interleaved}) {
      if (!containsFormat(sampleFormats, fallback)) sampleFormats.push_back(fallback);
    }
  }

  std::vector<FormatCandidate> candidates;
  std::set<std::tuple<int, int, AudioSampleFormat>> seen;
  for (int sampleRate : sampleRates) {
    if (sampleRate <= 0) continue;
    if (isNativeDsdRequest(requestedFormat) && sampleRate != requestedFormat.sampleRate) continue;
    for (AudioSampleFormat sampleFormat : sampleFormats) {
      const int normalized = bitDepthForFormat(sampleFormat);
      if (isNativeDsdRequest(requestedFormat) && !isDsdSampleFormat(sampleFormat)) continue;
      if (!isNativeDsdRequest(requestedFormat) && isDsdSampleFormat(sampleFormat)) continue;
      // bitDepths describes PCM container widths, so it only gates PCM
      // candidates. DSD and DoP carrier formats arrive from the device's own
      // nativeDsd*/dopCarrier* declarations, which already are the capability
      // statement for those paths.
      //
      // Applying the whitelist to them silently discards every DSD candidate:
      // a probe reports the one PCM width it observed on channel 0 (commonly
      // 32), and DSD normalizes to a 1-bit depth that can never match it.
      const bool declaredCapabilityFormat =
          (device.nativeDsdCapable && containsFormat(device.nativeDsdSampleFormats, sampleFormat)) ||
          (device.dopCapable && containsFormat(device.dopCarrierSampleFormats, sampleFormat));
      if (!device.bitDepths.empty() && !isDsdSampleFormat(sampleFormat) && !declaredCapabilityFormat) {
        const bool supportedDepth = std::find_if(device.bitDepths.begin(), device.bitDepths.end(), [&](int depth) {
                                      return normalizeBitDepth(depth) == normalized;
                                    }) != device.bitDepths.end();
        if (!supportedDepth) continue;
      }
      if (!seen.insert({sampleRate, normalized, sampleFormat}).second) continue;
      FormatCandidate candidate;
      candidate.format.sampleRate = sampleRate;
      candidate.format.channelCount = requestedFormat.channelCount;
      candidate.format.bitDepth = normalized;
      candidate.format.sampleFormat = sampleFormat;
      candidate.sampleRateError = std::abs(sampleRate - requestedFormat.sampleRate);
      candidate.bitDepthError = std::abs(normalized - normalizeBitDepth(requestedFormat.bitDepth));
      candidate.exact = candidate.sampleRateError == 0 && candidate.bitDepthError == 0 &&
                        candidate.format.channelCount == requestedFormat.channelCount &&
                        candidate.format.sampleFormat == requestedFormat.sampleFormat;
      candidate.isDefault = sampleRate == device.defaultSampleRate && normalized == normalizeBitDepth(device.defaultBitDepth);
      candidates.push_back(candidate);
    }
  }

  if (candidates.empty()) return false;
  std::sort(candidates.begin(), candidates.end(), [](const FormatCandidate& left, const FormatCandidate& right) {
    if (left.exact != right.exact) return left.exact;
    if (left.sampleRateError != right.sampleRateError) return left.sampleRateError < right.sampleRateError;
    if (left.format.sampleRate != right.format.sampleRate) return left.format.sampleRate > right.format.sampleRate;
    if (left.bitDepthError != right.bitDepthError) return left.bitDepthError < right.bitDepthError;
    if (isDsdSampleFormat(left.format.sampleFormat) != isDsdSampleFormat(right.format.sampleFormat)) {
      return isDsdSampleFormat(left.format.sampleFormat);
    }
    if ((left.format.sampleFormat == AudioSampleFormat::Float32Interleaved) !=
        (right.format.sampleFormat == AudioSampleFormat::Float32Interleaved)) {
      return left.format.sampleFormat == AudioSampleFormat::Float32Interleaved;
    }
    if (left.isDefault != right.isDefault) return left.isDefault;
    return left.format.bitDepth > right.format.bitDepth;
  });

  *selected = candidates.front().format;
  return true;
}

long AsioBackend::chooseBufferSize(const AsioDeviceInfo& device, const AudioFormat& requestedFormat) const {
  const bool nativeDsd = isNativeDsdRequest(requestedFormat);
  const long defaultPreferred = nativeDsd ? 2048 : 512;
  const long preferred = device.preferredBufferSize > 0 ? device.preferredBufferSize : defaultPreferred;
  const bool hasBufferRange = device.minBufferSize > 0 && device.maxBufferSize >= device.minBufferSize;
  const long minSize = hasBufferRange ? device.minBufferSize : preferred;
  const long maxSize = hasBufferRange ? device.maxBufferSize : preferred;
  const long granularity = device.bufferGranularity;
  if (outputConfig_.preferredBufferSize == 0) {
    if (!hasBufferRange) return nativeDsd ? std::max(preferred, 2048L) : preferred;
    const long automaticTarget = nativeDsd ? std::max(preferred, 2048L) : preferred;
    long selected = std::clamp(automaticTarget, minSize, maxSize);
    if (nativeDsd && quirkApplication_.dsdMinimumBufferFrames > 0 && hasBufferRange) {
      selected = std::clamp(
          std::max(selected, quirkApplication_.dsdMinimumBufferFrames), minSize, maxSize);
    }
    return selected;
  }

  const long requested = static_cast<long>(outputConfig_.preferredBufferSize);
  // ASIO device enumeration does not expose the session's buffer range on
  // Windows. Preserve an explicit setting so the session can validate it
  // against the driver's authoritative getBufferSize() result.
  if (!hasBufferRange) return requested;

  auto legalize = [&](long value) {
    value = std::clamp(value, minSize, maxSize);
    if (granularity > 0) {
      const long offset = value - minSize;
      const long lower = minSize + (offset / granularity) * granularity;
      const long upper = std::min(maxSize, lower + granularity);
      const long lowerDistance = std::labs(value - lower);
      const long upperDistance = std::labs(upper - value);
      return lowerDistance <= upperDistance ? lower : upper;
    }
    if (granularity < 0) {
      long best = minSize;
      long bestDistance = std::labs(requested - best);
      for (long size = minSize; size <= maxSize; size *= 2) {
        const long distance = std::labs(requested - size);
        if (distance < bestDistance || (distance == bestDistance && size < best)) {
          best = size;
          bestDistance = distance;
        }
        if (size > maxSize / 2) break;
      }
      return best;
    }
    return value;
  };
  long selected = legalize(requested);
  if (nativeDsd && quirkApplication_.dsdMinimumBufferFrames > 0 && hasBufferRange) {
    selected = std::clamp(
        std::max(selected, quirkApplication_.dsdMinimumBufferFrames), minSize, maxSize);
  }
  return selected;
}

int AsioBackend::routedOutputChannels(const AsioDeviceInfo& device, int sourceChannels) const {
  const int requested = std::max(1, sourceChannels);
  if (device.outputChannels <= 0) {
    switch (outputConfig_.routingMode) {
      case ChannelRoutingMode::StereoTo51:
        return 6;
      case ChannelRoutingMode::StereoTo71:
        return 8;
      case ChannelRoutingMode::MonoToStereo:
        return 2;
      case ChannelRoutingMode::MonoToMultichannel:
        return std::max(2, requested);
      case ChannelRoutingMode::Stereo:
        return 2;
      case ChannelRoutingMode::Auto:
      default:
        return requested;
    }
  }
  const int available = device.outputChannels;
  switch (outputConfig_.routingMode) {
    case ChannelRoutingMode::StereoTo51:
      return std::min(available, 6);
    case ChannelRoutingMode::StereoTo71:
      return std::min(available, 8);
    case ChannelRoutingMode::MonoToStereo:
      return std::min(available, 2);
    case ChannelRoutingMode::MonoToMultichannel:
      return std::min(available, std::max(2, available));
    case ChannelRoutingMode::Stereo:
      return std::min(available, 2);
    case ChannelRoutingMode::Auto:
    default:
      return std::min(available, std::max(1, sourceChannels));
  }
}

bool AsioBackend::createAndStartHost(std::string* error) {
  if (!host_->createBuffers(
          [this](long bufferIndex) { renderBuffer(bufferIndex); },
          [this](AsioHostEvent event, const std::string& message) {
            queueRecoveryFromHostCallback(event, message);
          },
          error)) {
    std::lock_guard lock(mutex_);
    ++diagnostics_.sessionBufferDropCount;
    ++diagnostics_.lifetimeBufferDropCount;
    if (error) diagnostics_.lastError = *error;
    if (error) {
      outputInfo_.perfectReasonCode = hostFailureReasonCode(*error, "buffer_failure");
      outputInfo_.capabilityReason = *error;
      outputInfo_.perfectReason = "ASIO buffer creation failed: " + *error;
    }
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }
  {
    // createBuffers may have fallen back to the driver's preferred size; the
    // render scratch and callback pacing must run at the size the driver
    // actually accepted, not the one open() chose.
    const long activeSize = host_->activeBufferSize();
    if (activeSize > 0) bufferSizeFrames_ = activeSize;
    const int outputChannels = std::max(1, openConfig_.format.channelCount);
    std::vector<AsioChannelFormat> channelFormats;
    channelFormats.reserve(static_cast<size_t>(outputChannels));
    for (int channel = 0; channel < outputChannels; ++channel) {
      channelFormats.push_back(
          normalizeAsioDopChannelFormat(openConfig_.format, host_->outputChannelFormat(channel)));
    }
    const AsioChannelFormat firstChannelFormat = channelFormats.front();
    std::lock_guard lock(mutex_);
    outputInfo_.bufferSizeFrames = static_cast<int>(bufferSizeFrames_);
    if (!asio::isSupportedChannelFormat(firstChannelFormat)) {
      if (error) *error = "unsupported_asio_sample_type";
      ++diagnostics_.sessionBufferDropCount;
      ++diagnostics_.lifetimeBufferDropCount;
      diagnostics_.lastError = error ? *error : "unsupported_asio_sample_type";
      outputInfo_.perfectReasonCode = "unsupported_asio_sample_type";
      outputInfo_.capabilityReason = diagnostics_.lastError;
      outputInfo_.perfectReason = "ASIO driver reported an unsupported output channel format";
      outputInfo_.diagnostics = diagnostics_;
      return false;
    }
    const AudioSampleFormat firstActualSampleFormat = firstChannelFormat.logicalFormat;
    bool uniformActualSampleFormat = true;
    for (int channel = 1; channel < outputChannels; ++channel) {
      const AsioChannelFormat& channelFormat = channelFormats[static_cast<size_t>(channel)];
      if (!asio::isSupportedChannelFormat(channelFormat) ||
          !asio::channelFormatsMatch(channelFormat, firstChannelFormat)) {
        uniformActualSampleFormat = false;
        break;
      }
    }
    actualOutputFormatObserved_ = true;
    actualOutputChannelFormatsMatch_ = uniformActualSampleFormat;
    outputFormat_.sampleFormat = firstActualSampleFormat;
    outputFormat_.bitDepth = bitDepthForFormat(firstActualSampleFormat);
    outputInfo_.actualOutputFormat = sampleFormatToString(firstActualSampleFormat);
    outputInfo_.actualBitDepth = outputFormat_.bitDepth;
    outputInfo_.outputBitDepth = outputFormat_.bitDepth;
    if (isNativeDsdRequest(openConfig_.format)) {
      diagnostics_.actualWireFormat = sampleFormatToString(firstActualSampleFormat);
      diagnostics_.containerBits = firstChannelFormat.containerBits;
      diagnostics_.validBits = firstChannelFormat.validBits;
      diagnostics_.blockAlign = static_cast<int>(
          asio::bytesPerSample(firstChannelFormat) * static_cast<size_t>(outputChannels));
      outputInfo_.diagnostics = diagnostics_;
    }
    outputInfo_.resampled = isNativeDsdRequest(openConfig_.format)
                                ? !sameNativeDsdStream(openConfig_.format, outputFormat_)
                                : !sameAsioTransportFormat(openConfig_.format, outputFormat_);
    const size_t callbackFrames = static_cast<size_t>(std::max<long>(1, bufferSizeFrames_));
    const size_t renderSamples = callbackFrames * static_cast<size_t>(std::max(1, outputFormat_.channelCount));
    renderScratch_.resize(renderSamples);
    const size_t typedBytesPerFrame = audioFormatBytesPerFrame(outputFormat_);
    if (typedCallback_ && typedBytesPerFrame > 0) {
      typedRenderScratch_.resize(callbackFrames * typedBytesPerFrame);
    }
    renderCallbackSession_ = callback_;
    typedCallbackSession_ = typedCallback_;
    renderOutputConfigSession_ = outputConfig_;
    renderOutputFormatSession_ = outputFormat_;
    renderOpenFormatSession_ = openConfig_.format;
    renderBufferSizeFramesSession_ = bufferSizeFrames_;
    renderDsdCadenceConfirmCallbacksSession_ =
        std::clamp<uint32_t>(openConfig_.dsdCadenceConfirmCallbacks, 2, 8);
    renderChannelFormatsMatchSession_ = actualOutputChannelFormatsMatch_;
    renderChannelFormatsSession_ = std::move(channelFormats);
    // Native DSD buffer-count calibration: start at the conservative probe
    // unit (fits both the packed byte-frame and the 1-bit-sample readings of
    // the driver's buffer size) and widen on cadence confirmation in the
    // render callback. PCM/DoP carriers have one unambiguous unit.
    if (isNativeDsdRequest(openConfig_.format)) {
      renderDsdUnitFramesSession_ = std::max<size_t>(1, callbackFrames / 8);
    } else {
      renderDsdUnitFramesSession_ = 0;
    }
    dsdRenderUnitProbe_ = {};
    pendingDsdBufferUnitAdapted_.store(false, std::memory_order_relaxed);
    // Mirror of the typed-branch structural conditions, snapshotted so the
    // render callback can tell "typed path absent" from "typed path present
    // but transiently starved" when it falls back to idle fill.
    renderTypedPathAvailableSession_ =
        typedCallbackSession_ != nullptr && outputConfig_.routingMode == ChannelRoutingMode::Auto &&
        std::max(1, outputFormat_.channelCount) == std::max(1, openConfig_.format.channelCount) &&
        actualOutputChannelFormatsMatch_ && audioFormatBytesPerFrame(outputFormat_) > 0 &&
        typedRenderScratch_.size() >= callbackFrames * audioFormatBytesPerFrame(outputFormat_);
    outputReadyEnabled_.store(true, std::memory_order_relaxed);
    if (outputInfo_.resampled && outputInfo_.perfectReason.empty()) {
      outputInfo_.perfectReasonCode = isNativeDsdRequest(openConfig_.format) ? "native_dsd_format_mismatch"
                                                                             : "pcm_converted";
      outputInfo_.perfectReason = isNativeDsdRequest(openConfig_.format)
                                      ? "ASIO actual Native DSD format differs from negotiated format"
                                      : "ASIO actual output format differs from negotiated format";
    }
    dopRuntimeFacts_ = buildAsioDopRuntimeFacts(
        deviceInfo_,
        openConfig_.format,
        outputFormat_,
        actualOutputFormatObserved_,
        actualOutputChannelFormatsMatch_);
    diagnostics_.dopRuntimeEvidence = dopRuntimeFacts_.reason;
    nativeDsdRuntimeFacts_ = buildAsioNativeDsdRuntimeFacts(
        deviceInfo_,
        openConfig_.format,
        outputFormat_,
        actualOutputFormatObserved_,
        actualOutputChannelFormatsMatch_,
        false);
    applyNativeDsdFactsToOutputInfo(&outputInfo_, nativeDsdRuntimeFacts_);
    outputInfo_.diagnostics = diagnostics_;
  }
  // Pre-fill both driver buffer sets with silence (PCM zeros / the DSD idle
  // pattern) before start, so the very first callbacks can never hand the DAC
  // uninitialized memory when the render thread is a tick late. Same guard
  // foo_out_asio+dsd ships as "delay playback until buffers are primed" and
  // JUCE applies by zeroing whenever no callback is registered.
  //
  // Native DSD fills only the probe unit (bufferSize/8 bytes per channel): a
  // driver that counts buffers in 1-bit samples owns a bufferSize/8-byte
  // buffer, so a full-size prefill would write 8x past its allocation before
  // any cadence evidence exists. The unverified tail on byte-frame drivers is
  // overwritten by the widened unit once the probe confirms.
  {
    const int fillChannels = std::max(1, openConfig_.format.channelCount);
    const bool nativeDsdFill = isNativeDsdRequest(openConfig_.format);
    const size_t fillFrames = static_cast<size_t>(std::max<long>(1, bufferSizeFrames_));
    for (int channel = 0; channel < fillChannels; ++channel) {
      const AsioChannelFormat& channelFormat = renderChannelFormatsSession_[static_cast<size_t>(channel)];
      const size_t bytesPerFrame = asio::bytesPerSample(channelFormat);
      if (bytesPerFrame == 0) continue;
      const size_t fillBytes =
          (nativeDsdFill ? std::max<size_t>(1, fillFrames / 8) : fillFrames) * bytesPerFrame;
      const uint8_t fillByte =
          isDsdSampleFormat(channelFormat.logicalFormat)
              ? asio::nativeDsdIdleByte(channelFormat.logicalFormat)
              : 0;
      for (long bufferIndex = 0; bufferIndex < 2; ++bufferIndex) {
        if (uint8_t* buffer = static_cast<uint8_t*>(host_->outputBuffer(channel, bufferIndex))) {
          std::memset(buffer, fillByte, fillBytes);
        }
      }
    }
    const size_t committedFrames =
        nativeDsdFill ? std::max<size_t>(1, fillFrames / 8) : fillFrames;
    host_->commitOutputBuffer(0, committedFrames);
    host_->commitOutputBuffer(1, committedFrames);
  }
  running_ = true;
  if (!host_->start(error)) {
    running_ = false;
    std::lock_guard lock(mutex_);
    if (error) diagnostics_.lastError = *error;
    if (error) {
      outputInfo_.perfectReasonCode = hostFailureReasonCode(*error, "backend_start_failure");
      outputInfo_.capabilityReason = *error;
      outputInfo_.perfectReason = "ASIO start failed: " + *error;
    }
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }
  {
    std::lock_guard lock(mutex_);
    const bool rawDsdStarted = isNativeDsdRequest(openConfig_.format);
    if (rawDsdStarted) {
      nativeDsdRuntimeFacts_ = buildAsioNativeDsdRuntimeFacts(
          deviceInfo_,
          openConfig_.format,
          outputFormat_,
          actualOutputFormatObserved_,
          actualOutputChannelFormatsMatch_,
          true);
      outputInfo_.resampled = nativeDsdRuntimeFacts_.state == NativeDsdRuntimeFactState::Proven
                                  ? false
                                  : !sameFormat(openConfig_.format, outputFormat_);
      outputInfo_.perfectReason = nativeDsdRuntimeFacts_.state == NativeDsdRuntimeFactState::Proven
                                      ? ""
                                      : nativeDsdRuntimeFacts_.reason;
      outputInfo_.perfectReasonCode = nativeDsdRuntimeFacts_.state == NativeDsdRuntimeFactState::Proven
                                          ? ""
                                          : "native_dsd_runtime_unproven";
      applyNativeDsdFactsToOutputInfo(&outputInfo_, nativeDsdRuntimeFacts_);
    }
    outputInfo_.diagnostics = diagnostics_;
  }
  return true;
}

void AsioBackend::commitAndNotifyOutputReady(long bufferIndex, size_t frameCount) noexcept {
  host_->commitOutputBuffer(bufferIndex, frameCount);
  if (!outputReadyEnabled_.load(std::memory_order_relaxed)) return;
  if (!host_->outputReady()) {
    outputReadyEnabled_.store(false, std::memory_order_relaxed);
  }
}

void AsioBackend::recordRenderUnderrun() noexcept {
  pendingRenderUnderruns_.fetch_add(1, std::memory_order_relaxed);
}

void AsioBackend::recordRenderBufferDrop() noexcept {
  pendingRenderBufferDrops_.fetch_add(1, std::memory_order_relaxed);
}

void AsioBackend::renderBuffer(long bufferIndex) {
  const RenderCallback& callback = renderCallbackSession_;
  const TypedRenderCallback& typedCallback = typedCallbackSession_;
  const OutputConfig& outputConfig = renderOutputConfigSession_;
  const AudioFormat& outputFormat = renderOutputFormatSession_;
  const int sourceChannels = std::max(1, outputFormat.channelCount);
  const int outputChannels = std::max(1, renderOpenFormatSession_.channelCount);
  const size_t frames = static_cast<size_t>(std::max<long>(1, renderBufferSizeFramesSession_));
  const bool actualOutputChannelFormatsMatch = renderChannelFormatsMatchSession_;
  const bool nativeDsdOutput =
      isNativeDsdRequest(renderOpenFormatSession_) || isDsdSampleFormat(outputFormat.sampleFormat);

  const auto now = std::chrono::high_resolution_clock::now();
  const uint32_t callbacksSeen = renderCallbacksSeen_++;
  static constexpr uint32_t kUnderrunWarmupCallbacks = 2;
  const uint32_t kDsdUnitConfirmCallbacks = renderDsdCadenceConfirmCallbacksSession_;
  const double byteFrameExpectedMs =
      static_cast<double>(frames) * 1000.0 / asioCallbackFrameRate(outputFormat);
  const double elapsedMs =
      lastRenderTime_.time_since_epoch().count() > 0
          ? std::chrono::duration<double, std::milli>(now - lastRenderTime_).count()
          : 0.0;
  if (nativeDsdOutput && !dsdRenderUnitProbe_.confirmed && callbacksSeen >= kUnderrunWarmupCallbacks) {
    // Unit probe: cadence intervals are the only runtime evidence of which
    // buffer unit the driver counts. Writes stay at the conservative probe
    // unit until the verdict latches, so neither interpretation can overflow.
    const auto decision = asio::advanceDsdRenderUnitProbe(
        dsdRenderUnitProbe_,
        asio::classifyDsdCallbackUnit(byteFrameExpectedMs, elapsedMs),
        kDsdUnitConfirmCallbacks);
    if (decision == asio::DsdRenderUnitDecision::UseByteFrames) {
      renderDsdUnitFramesSession_ = frames;
    } else if (decision == asio::DsdRenderUnitDecision::UseBitSamples) {
      pendingDsdBufferUnitAdapted_.store(true, std::memory_order_release);
    }
  }
  lastRenderTime_ = now;
  // While the probe is undecided the deadline reference stays on the declared
  // byte-frame period: a bit-sample driver's real interval is 8x shorter (no
  // false underruns) and a byte-frame driver's matches it exactly. Once a
  // bit-sample driver is confirmed, the expectation follows the adapted unit.
  const size_t renderFrames = renderDsdUnitFramesSession_ > 0 ? renderDsdUnitFramesSession_ : frames;
  const double deadlineExpectedMs =
      (nativeDsdOutput && dsdRenderUnitProbe_.confirmed &&
       renderDsdUnitFramesSession_ != 0 && renderDsdUnitFramesSession_ < frames)
          ? static_cast<double>(renderFrames) * 1000.0 / asioCallbackFrameRate(outputFormat)
          : byteFrameExpectedMs;
  const bool callbackDeadlineMissed =
      callbacksSeen >= kUnderrunWarmupCallbacks && elapsedMs > 0.0 &&
      deadlineExpectedMs > 0 && elapsedMs > deadlineExpectedMs * 1.5;

  const bool typedDsdPathActive = typedCallback && renderTypedPathAvailableSession_;
  if (typedCallback && outputConfig.routingMode == ChannelRoutingMode::Auto && sourceChannels == outputChannels &&
      actualOutputChannelFormatsMatch && !renderChannelFormatsSession_.empty() &&
      renderChannelFormatsSession_.front().logicalFormat == outputFormat.sampleFormat &&
      audioFormatBytesPerFrame(outputFormat) > 0) {
    const size_t bytesPerFrame = audioFormatBytesPerFrame(outputFormat);
    const size_t typedByteCount = renderFrames * bytesPerFrame;
    if (typedRenderScratch_.size() >= typedByteCount) {
      PcmBlock block;
      block.format = outputFormat;
      block.data = typedRenderScratch_.data();
      block.frames = renderFrames;
      block.byteSize = typedByteCount;
      const size_t rendered = typedCallback(block);
      if (rendered > 0) {
        const size_t renderedFrames = std::min(rendered, renderFrames);
        if (isDopCarrierFormat(outputFormat) &&
            dopMarkerState_.load(std::memory_order_relaxed) == 0 && renderedFrames >= 2) {
          dopMarkerFramesVerified_.store(renderedFrames, std::memory_order_relaxed);
          dopMarkerState_.store(
              hasAlternatingDopMarkers(
                  typedRenderScratch_.data(), renderedFrames, sourceChannels, outputFormat.sampleFormat)
                  ? 1
                  : 2,
              std::memory_order_release);
        }
        if (nativeDsdOutput &&
            !firstNativeDsdBufferClaimed_.exchange(true, std::memory_order_acq_rel)) {
          uint64_t hash = 1469598103934665603ULL;
          const size_t inspected = std::min<size_t>(renderedFrames * bytesPerFrame, 512);
          for (size_t i = 0; i < inspected; ++i) {
            hash ^= typedRenderScratch_[i];
            hash *= 1099511628211ULL;
          }
          firstNativeDsdInspectedBytes_.store(inspected, std::memory_order_relaxed);
          firstNativeDsdIdleByte_.store(
              asio::nativeDsdIdleByte(outputFormat.sampleFormat),
              std::memory_order_relaxed);
          firstNativeDsdHash_.store(hash, std::memory_order_relaxed);
          firstNativeDsdBufferObserved_.store(true, std::memory_order_release);
        }
        if (renderedFrames < renderFrames) {
          recordRenderUnderrun();
          const uint8_t idleByte = nativeDsdOutput
                                       ? asio::nativeDsdIdleByte(outputFormat.sampleFormat)
                                       : 0;
          std::memset(
              typedRenderScratch_.data() + renderedFrames * bytesPerFrame,
              idleByte,
              (renderFrames - renderedFrames) * bytesPerFrame);
          if (nativeDsdOutput) {
            pendingDsdShortReads_.fetch_add(1, std::memory_order_relaxed);
            pendingDsdIdleFrames_.fetch_add(renderFrames - renderedFrames, std::memory_order_relaxed);
          }
        }
        if (callbackDeadlineMissed && renderedFrames == renderFrames) recordRenderUnderrun();
        for (int channel = 0; channel < outputChannels; ++channel) {
          auto* output = static_cast<uint8_t*>(host_->outputBuffer(channel, bufferIndex));
          if (!output) continue;
          if (static_cast<size_t>(channel) >= renderChannelFormatsSession_.size()) continue;
          const AsioChannelFormat& channelFormat = renderChannelFormatsSession_[static_cast<size_t>(channel)];
          if (channelFormat.logicalFormat != outputFormat.sampleFormat ||
              !asio::isSupportedChannelFormat(channelFormat)) {
            continue;
          }
          asio::writeInterleavedTypedChannelToPlanar(
              typedRenderScratch_.data(),
              renderFrames,
              sourceChannels,
              channel,
              channelFormat,
              output);
        }
        commitAndNotifyOutputReady(bufferIndex, renderFrames);
        return;
      }
    }
  }

  if (nativeDsdOutput) {
    if (callbackDeadlineMissed) recordRenderUnderrun();
    for (int channel = 0; channel < outputChannels; ++channel) {
      auto* output = static_cast<uint8_t*>(host_->outputBuffer(channel, bufferIndex));
      if (!output) continue;
      if (static_cast<size_t>(channel) >= renderChannelFormatsSession_.size()) continue;
      const AsioChannelFormat& channelFormat = renderChannelFormatsSession_[static_cast<size_t>(channel)];
      const AudioSampleFormat sampleFormat = channelFormat.logicalFormat;
      if (!isDsdSampleFormat(sampleFormat)) continue;
      std::memset(
          output,
          asio::nativeDsdIdleByte(sampleFormat),
          renderFrames * asio::bytesPerSample(channelFormat));
    }
    recordRenderBufferDrop();
    // The typed path is structurally present in every pipeline start; reaching
    // this branch with it available means a transient starvation (rendered==0),
    // not a missing callback. Only a structurally missing path is a fact.
    if (!typedDsdPathActive) {
      pendingNativeDsdTypedCallbackMissing_.store(true, std::memory_order_release);
    }
    pendingDsdShortReads_.fetch_add(1, std::memory_order_relaxed);
    pendingDsdIdleFrames_.fetch_add(renderFrames, std::memory_order_relaxed);
    commitAndNotifyOutputReady(bufferIndex, renderFrames);
    return;
  }

  const size_t samples = frames * static_cast<size_t>(sourceChannels);
  if (renderScratch_.size() < samples) {
    recordRenderBufferDrop();
    for (int channel = 0; channel < outputChannels; ++channel) {
      auto* output = static_cast<uint8_t*>(host_->outputBuffer(channel, bufferIndex));
      if (!output) continue;
      if (static_cast<size_t>(channel) >= renderChannelFormatsSession_.size()) continue;
      std::memset(
          output,
          0,
          frames * asio::bytesPerSample(renderChannelFormatsSession_[static_cast<size_t>(channel)]));
    }
    commitAndNotifyOutputReady(bufferIndex, frames);
    return;
  }
  const size_t renderedFrames = callback ? std::min(callback(renderScratch_.data(), frames), frames) : 0;
  if (renderedFrames < frames) {
    recordRenderUnderrun();
    const size_t renderedSamples = renderedFrames * static_cast<size_t>(sourceChannels);
    std::fill(
        renderScratch_.begin() + static_cast<std::ptrdiff_t>(renderedSamples),
        renderScratch_.begin() + static_cast<std::ptrdiff_t>(samples),
        0.0f);
  } else if (callbackDeadlineMissed) {
    recordRenderUnderrun();
  }

  for (int channel = 0; channel < outputChannels; ++channel) {
    auto* output = static_cast<uint8_t*>(host_->outputBuffer(channel, bufferIndex));
    if (!output) continue;
    if (static_cast<size_t>(channel) >= renderChannelFormatsSession_.size()) continue;
    const AsioChannelFormat& channelFormat = renderChannelFormatsSession_[static_cast<size_t>(channel)];
    asio::writePackedChannelFromFloatScratch(
        renderScratch_.data(),
        frames,
        sourceChannels,
        channel,
        outputConfig.routingMode,
        channelFormat,
        output);
  }
  commitAndNotifyOutputReady(bufferIndex, frames);
}

void AsioBackend::queueRecoveryFromHostCallback(AsioHostEvent event, std::string message) {
  if (stopRequested_.load()) return;
  {
    std::lock_guard lock(recoveryQueueMutex_);
    if (stopRequested_.load()) return;
    recoveryRequests_.push_back({event, std::move(message)});
    if (!recoveryThread_.joinable()) {
      recoveryThread_ = std::thread([this] { recoveryWorkerLoop(); });
    }
  }
  recoveryQueueCv_.notify_one();
}

void AsioBackend::recoveryWorkerLoop() {
  for (;;) {
    RecoveryRequest request;
    {
      std::unique_lock lock(recoveryQueueMutex_);
      recoveryQueueCv_.wait(lock, [this] {
        return stopRequested_.load() || !recoveryRequests_.empty();
      });
      if (stopRequested_.load()) break;
      request = std::move(recoveryRequests_.front());
      recoveryRequests_.pop_front();
    }
    recover(request.event, request.message);
  }
}

void AsioBackend::joinRecoveryThread() {
  std::thread threadToJoin;
  {
    std::lock_guard lock(recoveryQueueMutex_);
    if (recoveryThread_.joinable() && recoveryThread_.get_id() != std::this_thread::get_id()) {
      threadToJoin = std::move(recoveryThread_);
    }
  }
  if (threadToJoin.joinable()) threadToJoin.join();
}

bool AsioBackend::recover(AsioHostEvent event, const std::string& message) {
  static constexpr int kMaxAttempts = 3;
  static constexpr int kBackoffMs[] = {500, 1000, 2000};
  static constexpr auto kRecoveryWindow = std::chrono::seconds(10);
  static constexpr auto kRecoveryCooldown = std::chrono::seconds(10);
  // A transient load event leaves the stream valid. Count it, surface it, and
  // return before touching the recovery machinery: no rebuild, no backoff, and
  // crucially no entry in recoveryWindow_ - otherwise a burst of driver
  // overloads would trip the 3-per-10s limiter into its 10 s cooldown and
  // suppress recovery from a *real* fault arriving right after.
  if (event == AsioHostEvent::Xrun) {
    std::lock_guard lock(mutex_);
    ++diagnostics_.driverXrunCount;
    diagnostics_.lastError = hostEventReason(event, message);
    outputInfo_.diagnostics = diagnostics_;
    return false;
  }

  OutputEventCallback eventCallback;
  {
    std::lock_guard lock(mutex_);
    eventCallback = eventCallback_;
  }

  if (event == AsioHostEvent::HelperFailure) {
    running_ = false;
    host_->stop();
    host_->close();
    const std::string reason = helperFailureReasonCode(message);
    {
      std::lock_guard lock(mutex_);
      diagnostics_.lastError = hostEventReason(event, message);
      outputInfo_.perfectReasonCode = reason;
      outputInfo_.capabilityReason = diagnostics_.lastError;
      outputInfo_.perfectReason = diagnostics_.lastError;
      outputInfo_.deviceRecovered = false;
      outputInfo_.diagnostics = diagnostics_;
    }
    if (eventCallback) {
      eventCallback(
          OutputBackendEvent::RenderError,
          message.empty() ? "ASIO helper process failed" : message);
    }
    return false;
  }

  const auto now = std::chrono::steady_clock::now();
  {
    std::lock_guard lock(mutex_);
    diagnostics_.lastError = hostEventReason(event, message);
    if (event == AsioHostEvent::DriverReset || event == AsioHostEvent::DriverRestart) ++diagnostics_.driverRestartCount;
    if (event == AsioHostEvent::DeviceLost) ++diagnostics_.deviceLostCount;
    if (event == AsioHostEvent::BufferFailure) {
      ++diagnostics_.sessionUnderrunCount;
      ++diagnostics_.lifetimeUnderrunCount;
    }
    outputInfo_.perfectReasonCode =
        event == AsioHostEvent::BufferFailure
            ? "buffer_failure"
            : (event == AsioHostEvent::DeviceLost ? "device_lost" : "driver_restart");
    outputInfo_.capabilityReason = diagnostics_.lastError;
    outputInfo_.perfectReason = diagnostics_.lastError;
    outputInfo_.diagnostics = diagnostics_;
  }
  if (event == AsioHostEvent::DriverReset || event == AsioHostEvent::DriverRestart || event == AsioHostEvent::DeviceLost) {
    const uint64_t version = DeviceCapabilityCache::instance().bumpVersion(openConfig_.deviceId);
    std::lock_guard lock(mutex_);
    deviceInfo_.capabilityVersion = version;
  }

  {
    std::lock_guard lock(mutex_);
    while (!recoveryWindow_.empty() && now - recoveryWindow_.front() > kRecoveryWindow) {
      recoveryWindow_.pop_front();
    }
    if (recoveryInProgress_) {
      diagnostics_.lastError = message.empty() ? "ASIO recovery already in progress"
                                               : message + " (ASIO recovery already in progress)";
      outputInfo_.capabilityReason = diagnostics_.lastError;
      outputInfo_.perfectReason = diagnostics_.lastError;
      outputInfo_.diagnostics = diagnostics_;
      return false;
    }
    if (now < recoveryCooldownUntil_) {
      diagnostics_.lastError = message.empty() ? "ASIO recovery cooldown active"
                                               : message + " (ASIO recovery cooldown active)";
      outputInfo_.capabilityReason = diagnostics_.lastError;
      outputInfo_.perfectReason = diagnostics_.lastError;
      outputInfo_.diagnostics = diagnostics_;
      return false;
    }
    if (recoveryWindow_.size() >= static_cast<size_t>(kMaxAttempts)) {
      recoveryCooldownUntil_ = now + kRecoveryCooldown;
      diagnostics_.lastError = message.empty() ? "ASIO recovery cooldown active"
                                               : message + " (ASIO recovery cooldown active)";
      outputInfo_.capabilityReason = diagnostics_.lastError;
      outputInfo_.perfectReason = diagnostics_.lastError;
      outputInfo_.diagnostics = diagnostics_;
      return false;
    }
    recoveryWindow_.push_back(now);
    recoveryInProgress_ = true;
    recoveryAttempts_ = 0;
    outputInfo_.deviceRecovered = false;
    outputInfo_.recoveryCount = recoveryCount_;
    outputInfo_.diagnostics = diagnostics_;
  }

  const auto cancelRecovery = [this]() {
    std::lock_guard lock(mutex_);
    recoveryInProgress_ = false;
    recoveryAttempts_ = 0;
    outputInfo_.recoveryCount = recoveryCount_;
    outputInfo_.diagnostics = diagnostics_;
  };

  std::string lastAttemptError;
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    {
      std::lock_guard lock(mutex_);
      recoveryAttempts_ = attempt;
      outputInfo_.recoveryCount = recoveryCount_;
      outputInfo_.diagnostics = diagnostics_;
    }
    {
      std::unique_lock queueLock(recoveryQueueMutex_);
      if (recoveryQueueCv_.wait_for(
              queueLock,
              std::chrono::milliseconds(kBackoffMs[attempt]),
              [this] { return stopRequested_.load(); })) {
        cancelRecovery();
        return false;
      }
    }
    if (stopRequested_.load()) {
      cancelRecovery();
      return false;
    }
    if (event == AsioHostEvent::BufferFailure && attempt > 0) {
      // JRiver's "Use large hardware buffers" as an automatic ladder: each
      // retry of a buffer-geometry fault reopens one step larger, capped by
      // the driver's advertised maximum, so repeated buffer failures heal
      // into a more forgiving geometry instead of flapping at the same one.
      std::lock_guard lock(mutex_);
      const long ceiling =
          deviceInfo_.maxBufferSize > 0
              ? deviceInfo_.maxBufferSize
              : std::max<long>(openConfig_.bufferSizeFrames * 8, 4096);
      long escalated = openConfig_.bufferSizeFrames > 0 ? openConfig_.bufferSizeFrames * 4 : 1024;
      if (escalated > ceiling) escalated = ceiling;
      if (escalated > openConfig_.bufferSizeFrames) openConfig_.bufferSizeFrames = escalated;
    }
    std::string error;
    host_->stop();
    host_->close();
    if (stopRequested_.load()) {
      cancelRecovery();
      return false;
    }
    AsioOpenResult result;
    if (!host_->open(openConfig_, &result, &error)) {
      lastAttemptError = error;
      continue;
    }
    if (stopRequested_.load()) {
      host_->close();
      cancelRecovery();
      return false;
    }
    if (!createAndStartHost(&error)) {
      lastAttemptError = error;
      continue;
    }
    if (stopRequested_.load()) {
      host_->stop();
      host_->close();
      cancelRecovery();
      return false;
    }

    std::lock_guard lock(mutex_);
    recoveryAttempts_ = 0;
    recoveryInProgress_ = false;
    ++recoveryCount_;
    deviceRecovered_ = true;
    ++diagnostics_.sessionRecoveryCount;
    ++diagnostics_.lifetimeRecoveryCount;
    outputInfo_.deviceRecovered = true;
    outputInfo_.recoveryCount = recoveryCount_;
    outputInfo_.diagnostics = diagnostics_;
    return true;
  }

  running_ = false;
  {
    std::lock_guard lock(mutex_);
    recoveryInProgress_ = false;
    recoveryAttempts_ = kMaxAttempts;
    diagnostics_.lastError =
        lastAttemptError.empty() ? (message.empty() ? "ASIO 设备恢复失败" : message) : lastAttemptError;
    outputInfo_.capabilityReason = diagnostics_.lastError;
    outputInfo_.perfectReason = diagnostics_.lastError;
    outputInfo_.diagnostics = diagnostics_;
  }
  if (eventCallback) {
    eventCallback(OutputBackendEvent::DeviceInvalidated, message.empty() ? "ASIO 设备恢复失败" : message);
  }
  return false;
}

bool asioBackendAvailable() {
#if defined(_WIN32) && defined(TAE_ENABLE_ASIO)
  return true;
#else
  return false;
#endif
}

}  // namespace twilight::audio
