#include "AsioHelperHost.h"

#include "AsioRenderUtils.h"

#include <Windows.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

namespace twilight::audio {
namespace {

constexpr auto kSlowControlDeadline = std::chrono::seconds(12);
constexpr auto kCloseControlDeadline = std::chrono::seconds(3);

}  // namespace

AsioHelperHost::AsioHelperHost()
    : AsioHelperHost(asio_helper::locateAsioHelperExecutable(nullptr)) {}

AsioHelperHost::AsioHelperHost(std::wstring helperPath) : process_(std::move(helperPath)) {}

AsioHelperHost::~AsioHelperHost() {
  close();
  stopWorker();
  process_.shutdown();
}

bool AsioHelperHost::ensureProcess(std::string* error) const {
  if (process_.alive() && process_.shared()) return true;
  if (process_.failureReason() != asio_helper::FailureReason::None) {
    if (error) *error = process_.lastFailure();
    return false;
  }
  return process_.launch(error);
}

std::vector<AsioDeviceInfo> AsioHelperHost::enumerateDevices() {
  std::string error;
  if (!ensureProcess(&error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    return {};
  }
  asio_helper::Response response;
  if (!process_.request(
          asio_helper::Command::EnumerateDevices,
          &response,
          kSlowControlDeadline,
          &error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    return {};
  }
  std::vector<AsioDeviceInfo> devices;
  const size_t count = std::min<size_t>(response.deviceCount, asio_helper::kMaxDevices);
  devices.reserve(count);
  for (size_t index = 0; index < count; ++index) {
    devices.push_back(asio_helper::decodeDevice(response.devices[index]));
  }
  return devices;
}

AsioHostDiagnostics AsioHelperHost::diagnostics() const {
  std::string error;
  if (!ensureProcess(&error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    AsioHostDiagnostics result;
    result.processArchitecture = sizeof(void*) == 8 ? "x64" : "x86";
    result.buildEnabled = true;
    return result;
  }
  asio_helper::Response response;
  if (!process_.request(
          asio_helper::Command::GetDiagnostics,
          &response,
          kSlowControlDeadline,
          &error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error;
    AsioHostDiagnostics result;
    result.processArchitecture = sizeof(void*) == 8 ? "x64" : "x86";
    result.buildEnabled = true;
    return result;
  }
  return asio_helper::decodeDiagnostics(response.diagnostics);
}

bool AsioHelperHost::probeDevice(
    const std::string& deviceId,
    AsioDeviceInfo* info,
    std::string* error) {
  if (!info) {
    if (error) *error = "ASIO capability probe requires an output record";
    return false;
  }
  if (!ensureProcess(error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_.lastFailure();
    return false;
  }
  asio_helper::Response response;
  const bool ok = process_.request(
      asio_helper::Command::ProbeDevice,
      [&](asio_helper::Request& request) {
        asio_helper::copyText(request.deviceId, sizeof(request.deviceId), deviceId);
      },
      &response,
      kSlowControlDeadline,
      error);
  if (!ok) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_.lastFailure();
    return false;
  }
  *info = asio_helper::decodeDevice(response.device);
  return true;
}

bool AsioHelperHost::open(
    const AsioOpenConfig& config,
    AsioOpenResult* result,
    std::string* error) {
  close();
  {
    std::lock_guard lock(stateMutex_);
    closeError_.clear();
  }
  helperFailureDispatched_.store(false, std::memory_order_release);
  if (!ensureProcess(error)) return false;
  asio_helper::Response response;
  const bool ok = process_.request(
      asio_helper::Command::Open,
      [&](asio_helper::Request& request) {
        asio_helper::copyText(request.deviceId, sizeof(request.deviceId), config.deviceId);
        request.format = asio_helper::encodeAudioFormat(config.format);
        request.bufferSizeFrames = static_cast<int32_t>(config.bufferSizeFrames);
        if (config.sampleFormatMapping) {
          request.sampleFormatMappingReported =
              static_cast<int32_t>(config.sampleFormatMapping->reported);
          request.sampleFormatMappingInterpreted =
              static_cast<int32_t>(config.sampleFormatMapping->interpreted);
        }
        request.nativeDsdControlOrder = static_cast<int32_t>(config.nativeDsdControlOrder);
        request.dsdMinimumBufferFrames = static_cast<int32_t>(config.dsdMinimumBufferFrames);
        request.dsdCadenceConfirmCallbacks = static_cast<int32_t>(config.dsdCadenceConfirmCallbacks);
      },
      &response,
      kSlowControlDeadline,
      error);
  if (result) {
    result->actualFormat = asio_helper::decodeAudioFormat(response.actualFormat);
    result->bufferSizeFrames = response.bufferSizeFrames;
    result->latencyFrames = response.latencyFrames;
    result->driverName = asio_helper::readText(response.driverName);
    result->driverVersion = response.driverVersion;
    result->nativeDsdNegotiation = asio_helper::readText(response.nativeDsdNegotiation);
    result->failureKind = static_cast<AsioOpenFailureKind>(response.openFailureKind);
  }
  if (!ok) {
    {
      std::lock_guard lock(stateMutex_);
      closeError_ = error ? *error : process_.lastFailure();
    }
    if (response.failureReason ==
        static_cast<int32_t>(asio_helper::FailureReason::FormatRestoreFailed)) {
      process_.abort(
          asio_helper::FailureReason::FormatRestoreFailed,
          asio_helper::readText(response.message));
    }
    return false;
  }
  std::lock_guard lock(stateMutex_);
  openFormat_ = config.format;
  return true;
}

bool AsioHelperHost::createBuffers(
    AsioBufferSwitchCallback bufferSwitch,
    AsioEventCallback eventCallback,
    std::string* error) {
  if (!ensureProcess(error)) return false;
  asio_helper::Response response;
  if (!process_.request(
          asio_helper::Command::CreateBuffers,
          &response,
          kSlowControlDeadline,
          error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_.lastFailure();
    return false;
  }
  if (response.channelCount == 0 || response.channelCount > asio_helper::kMaxChannels ||
      response.bufferSizeFrames <= 0 ||
      response.bufferSizeFrames > static_cast<int32_t>(asio_helper::kMaxFrames)) {
    if (error) *error = asio_helper::failureMessage(
        asio_helper::FailureReason::ProtocolError,
        "ASIO helper returned invalid buffer geometry");
    process_.abort(asio_helper::FailureReason::ProtocolError, "invalid buffer geometry");
    return false;
  }
  {
    std::lock_guard lock(stateMutex_);
    bufferSwitch_ = std::move(bufferSwitch);
    eventCallback_ = std::move(eventCallback);
    activeBufferSize_ = response.bufferSizeFrames;
    channelFormats_.clear();
    channelFormats_.reserve(response.channelCount);
    for (uint32_t channel = 0; channel < response.channelCount; ++channel) {
      const AsioChannelFormat format =
          asio_helper::decodeChannelFormat(response.channelFormats[channel]);
      channelFormats_.push_back(format);
      renderChannelFormats_[channel] = format;
    }
    renderChannelCount_.store(response.channelCount, std::memory_order_release);
  }
  startWorker();
  return true;
}

bool AsioHelperHost::start(std::string* error) {
  asio_helper::Response response;
  if (!process_.request(
          asio_helper::Command::Start,
          &response,
          kSlowControlDeadline,
          error)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = error ? *error : process_.lastFailure();
    return false;
  }
  started_.store(true, std::memory_order_release);
  return true;
}

void AsioHelperHost::stop() {
  started_.store(false, std::memory_order_release);
  if (!process_.alive()) return;
  asio_helper::Response response;
  std::string ignored;
  if (!process_.request(
      asio_helper::Command::Stop,
      &response,
      kCloseControlDeadline,
      &ignored)) {
    std::lock_guard lock(stateMutex_);
    closeError_ = ignored.empty() ? process_.lastFailure() : ignored;
  }
}

void AsioHelperHost::close() {
  started_.store(false, std::memory_order_release);
  if (process_.alive()) {
    asio_helper::Response response;
    std::string error;
    if (!process_.request(
            asio_helper::Command::Close,
            &response,
            kCloseControlDeadline,
            &error)) {
      {
        std::lock_guard lock(stateMutex_);
        closeError_ = error;
      }
      if (response.failureReason ==
          static_cast<int32_t>(asio_helper::FailureReason::FormatRestoreFailed)) {
        process_.abort(
            asio_helper::FailureReason::FormatRestoreFailed,
            asio_helper::readText(response.message));
      }
    } else if (response.formatRestored == 0) {
      {
        std::lock_guard lock(stateMutex_);
        closeError_ = asio_helper::failureMessage(
            asio_helper::FailureReason::FormatRestoreFailed,
            "ASIO helper did not restore the retained PCM format");
      }
      process_.abort(
          asio_helper::FailureReason::FormatRestoreFailed,
          "ASIO helper did not restore the retained PCM format");
    } else {
      std::lock_guard lock(stateMutex_);
      closeError_.clear();
    }
  } else if (!process_.lastFailure().empty()) {
    std::lock_guard lock(stateMutex_);
    closeError_ = process_.lastFailure();
  }
  stopWorker();
  renderChannelCount_.store(0, std::memory_order_release);
  std::lock_guard lock(stateMutex_);
  bufferSwitch_ = nullptr;
  eventCallback_ = nullptr;
  channelFormats_.clear();
  activeBufferSize_ = 0;
}

void* AsioHelperHost::outputBuffer(long channel, long bufferIndex) {
  return asio_helper::channelBuffer(process_.shared(), channel, bufferIndex);
}

AudioSampleFormat AsioHelperHost::outputSampleFormat(long channel) const {
  return outputChannelFormat(channel).logicalFormat;
}

AsioChannelFormat AsioHelperHost::outputChannelFormat(long channel) const {
  std::lock_guard lock(stateMutex_);
  if (channel < 0 || static_cast<size_t>(channel) >= channelFormats_.size()) return {};
  return channelFormats_[static_cast<size_t>(channel)];
}

bool AsioHelperHost::outputReady() {
  return process_.alive();
}

long AsioHelperHost::activeBufferSize() const {
  std::lock_guard lock(stateMutex_);
  return activeBufferSize_;
}

void AsioHelperHost::commitOutputBuffer(long bufferIndex, size_t frameCount) {
  auto* shared = process_.shared();
  if (!shared || bufferIndex < 0 || bufferIndex > 1) return;
  asio_helper::RenderBuffer& buffer = shared->buffers[bufferIndex];
  const uint32_t boundedFrames = static_cast<uint32_t>(
      std::min<size_t>(frameCount, asio_helper::kMaxFrames));
  const uint32_t channelCount = std::min<uint32_t>(
      renderChannelCount_.load(std::memory_order_acquire),
      asio_helper::kMaxChannels);
  buffer.committedFrames = boundedFrames;
  std::memset(buffer.channelBytes, 0, sizeof(buffer.channelBytes));
  for (uint32_t channel = 0; channel < channelCount; ++channel) {
    const size_t bytes =
        boundedFrames * asio::bytesPerSample(renderChannelFormats_[channel]);
    buffer.channelBytes[channel] = static_cast<uint32_t>(
        std::min<size_t>(bytes, asio_helper::kChannelStride));
  }
  MemoryBarrier();
  asio_helper::incrementAtomic(&buffer.generation);
}

std::string AsioHelperHost::lastCloseError() const {
  std::lock_guard lock(stateMutex_);
  return closeError_;
}

void AsioHelperHost::startWorker() {
  bool expected = false;
  if (!workerRunning_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return;
  worker_ = std::thread([this] { workerLoop(); });
}

void AsioHelperHost::stopWorker() {
  workerRunning_.store(false, std::memory_order_release);
  if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
}

std::chrono::milliseconds AsioHelperHost::callbackDeadline() const {
  std::lock_guard lock(stateMutex_);
  const int frameRate = std::max(1, asio::callbackFrameRate(openFormat_));
  const double periodMs = static_cast<double>(std::max<long>(1, activeBufferSize_)) * 1000.0 /
      static_cast<double>(frameRate);
  return std::chrono::milliseconds(static_cast<int64_t>(std::max(2000.0, periodMs * 8.0)));
}

void AsioHelperHost::workerLoop() {
  int32_t callbackRead = 0;
  int32_t hostEventRead = 0;
  int32_t lastHeartbeat = 0;
  bool wasStarted = false;
  auto lastCallback = std::chrono::steady_clock::now();
  while (workerRunning_.load(std::memory_order_acquire)) {
    auto* shared = process_.shared();
    if (!shared || !process_.alive()) {
      if (started_.load(std::memory_order_acquire)) {
        dispatchHelperFailure(
            process_.failureReason() == asio_helper::FailureReason::None
                ? asio_helper::FailureReason::ProcessExited
                : process_.failureReason(),
            process_.lastFailure());
      }
      break;
    }

    const int32_t callbackWrite = asio_helper::readAtomic(&shared->callbackWriteSequence);
    while (callbackRead < callbackWrite) {
      const asio_helper::CallbackRecord record =
          shared->callbacks[static_cast<uint32_t>(callbackRead) % asio_helper::kCallbackRingSize];
      ++callbackRead;
      asio_helper::exchangeAtomic(&shared->callbackReadSequence, callbackRead);
      AsioBufferSwitchCallback callback;
      {
        std::lock_guard lock(stateMutex_);
        callback = bufferSwitch_;
      }
      if (callback && record.bufferIndex >= 0 && record.bufferIndex <= 1) {
        asio_helper::RenderBuffer& buffer = shared->buffers[record.bufferIndex];
        const LONG generation = asio_helper::readAtomic(&buffer.generation);
        const LONG consumed = asio_helper::readAtomic(&buffer.consumedGeneration);
        if (generation == consumed) {
          callback(record.bufferIndex);
        } else {
          asio_helper::incrementAtomic(&shared->callbackDropCount);
        }
      }
    }

    const int32_t hostEventWrite = asio_helper::readAtomic(&shared->hostEventWriteSequence);
    while (hostEventRead < hostEventWrite) {
      const asio_helper::HostEventRecord record =
          shared->hostEvents[static_cast<uint32_t>(hostEventRead) % asio_helper::kHostEventRingSize];
      ++hostEventRead;
      asio_helper::exchangeAtomic(&shared->hostEventReadSequence, hostEventRead);
      AsioEventCallback callback;
      {
        std::lock_guard lock(stateMutex_);
        callback = eventCallback_;
      }
      if (callback && record.event >= static_cast<int32_t>(AsioHostEvent::DriverReset) &&
          record.event <= static_cast<int32_t>(AsioHostEvent::Xrun)) {
        callback(
            static_cast<AsioHostEvent>(record.event),
            asio_helper::readText(record.message));
      }
    }

    const bool isStarted = started_.load(std::memory_order_acquire);
    const int32_t heartbeat = asio_helper::readAtomic(&shared->callbackHeartbeat);
    if (isStarted && !wasStarted) {
      lastHeartbeat = heartbeat;
      lastCallback = std::chrono::steady_clock::now();
    }
    wasStarted = isStarted;
    if (heartbeat != lastHeartbeat) {
      lastHeartbeat = heartbeat;
      lastCallback = std::chrono::steady_clock::now();
    } else if (isStarted &&
               std::chrono::steady_clock::now() - lastCallback > callbackDeadline()) {
      const std::string detail = "ASIO helper callback heartbeat stopped";
      process_.abort(asio_helper::FailureReason::CallbackStalled, detail);
      dispatchHelperFailure(asio_helper::FailureReason::CallbackStalled, detail);
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  workerRunning_.store(false, std::memory_order_release);
}

void AsioHelperHost::dispatchHelperFailure(
    asio_helper::FailureReason reason,
    const std::string& detail) {
  bool expected = false;
  if (!helperFailureDispatched_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return;
  started_.store(false, std::memory_order_release);
  AsioEventCallback callback;
  {
    std::lock_guard lock(stateMutex_);
    callback = eventCallback_;
  }
  const std::string message = detail.starts_with("asio_helper_")
      ? detail
      : asio_helper::failureMessage(reason, detail);
  if (callback) callback(AsioHostEvent::HelperFailure, message);
}

std::unique_ptr<IAsioHost> createIsolatedAsioHost() {
  return std::make_unique<AsioHelperHost>();
}

}  // namespace twilight::audio
