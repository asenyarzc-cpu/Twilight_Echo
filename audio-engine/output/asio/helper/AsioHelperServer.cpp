#include "AsioHelperServer.h"

#include "../AsioRenderUtils.h"

#include <Windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <string>

namespace twilight::audio::asio_helper {
namespace {

class Server final {
 public:
  Server(
      SharedMemory* shared,
      HANDLE responseEvent,
      std::unique_ptr<IAsioHost> host,
      AsioHelperServerOptions options)
      : shared_(shared),
        responseEvent_(responseEvent),
        host_(std::move(host)),
        options_(std::move(options)) {}

  bool handle(int32_t sequence, bool* shutdown) {
    const Request request = shared_->request;
    const Command command = static_cast<Command>(request.command);
    if (options_.beforeCommand) options_.beforeCommand(command);
    Response response;
    response.command = request.command;
    bool ok = false;
    switch (command) {
      case Command::EnumerateDevices:
        ok = enumerate(&response);
        break;
      case Command::GetDiagnostics:
        response.diagnostics = encodeDiagnostics(host_->diagnostics());
        ok = true;
        break;
      case Command::ProbeDevice:
        ok = probe(request, &response);
        break;
      case Command::Open:
        ok = open(request, &response);
        break;
      case Command::CreateBuffers:
        ok = createBuffers(&response);
        break;
      case Command::Start:
        ok = start(&response);
        break;
      case Command::Stop:
        host_->stop();
        started_.store(false, std::memory_order_release);
        ok = true;
        break;
      case Command::Close:
        ok = close(&response);
        break;
      case Command::Shutdown:
        close(&response);
        ok = response.failureReason == static_cast<int32_t>(FailureReason::None);
        if (shutdown) *shutdown = true;
        break;
      case Command::None:
      default:
        fail(&response, FailureReason::ProtocolError, "ASIO helper received an unknown command");
        break;
    }
    if (response.failureReason == static_cast<int32_t>(FailureReason::ProtocolError) && shutdown) {
      *shutdown = true;
    }
    if (response.failureReason == static_cast<int32_t>(FailureReason::None)) response.ok = ok ? 1 : 0;
    shared_->response = response;
    MemoryBarrier();
    exchangeAtomic(&shared_->responseSequence, sequence);
    SetEvent(responseEvent_);
    return ok;
  }

 private:
  bool enumerate(Response* response) {
    const std::vector<AsioDeviceInfo> devices = host_->enumerateDevices();
    if (devices.size() > kMaxDevices) {
      fail(response, FailureReason::ProtocolError, "ASIO driver catalog exceeds the helper protocol limit");
      return false;
    }
    response->deviceCount = static_cast<uint32_t>(devices.size());
    for (size_t index = 0; index < devices.size(); ++index) {
      response->devices[index] = encodeDevice(devices[index]);
    }
    return true;
  }

  bool probe(const Request& request, Response* response) {
    AsioDeviceInfo info;
    std::string error;
    if (!host_->probeDevice(readText(request.deviceId), &info, &error)) {
      fail(response, FailureReason::DeviceRejected, error.empty() ? "ASIO device probe failed" : error);
      return false;
    }
    response->device = encodeDevice(info);
    return true;
  }

  bool open(const Request& request, Response* response) {
    Response closeResponse;
    if (!close(&closeResponse)) {
      response->openFailureKind = static_cast<int32_t>(AsioOpenFailureKind::Driver);
      fail(
          response,
          FailureReason::FormatRestoreFailed,
          readText(closeResponse.message).empty()
              ? "ASIO helper could not restore the previous driver format"
              : readText(closeResponse.message));
      return false;
    }
    if (!validSampleFormat(request.format.sampleFormat) || request.format.sampleRate <= 0 ||
        request.format.channelCount <= 0 ||
        request.format.channelCount > static_cast<int32_t>(kMaxChannels) ||
        request.bufferSizeFrames < 0 ||
        request.bufferSizeFrames > static_cast<int32_t>(kMaxFrames) ||
        request.dsdMinimumBufferFrames < 0 || request.dsdMinimumBufferFrames > static_cast<int32_t>(kMaxFrames) ||
        request.dsdCadenceConfirmCallbacks < 2 || request.dsdCadenceConfirmCallbacks > 8 ||
        std::memchr(request.deviceId, '\0', sizeof(request.deviceId)) == nullptr) {
      fail(response, FailureReason::ProtocolError, "ASIO helper received a malformed open request");
      return false;
    }
    openConfig_ = {};
    openConfig_.deviceId = readText(request.deviceId);
    openConfig_.format = decodeAudioFormat(request.format);
    openConfig_.bufferSizeFrames = request.bufferSizeFrames;
    openConfig_.dsdMinimumBufferFrames = request.dsdMinimumBufferFrames;
    openConfig_.dsdCadenceConfirmCallbacks = static_cast<uint32_t>(request.dsdCadenceConfirmCallbacks);
    if (validSampleFormat(request.sampleFormatMappingReported) &&
        validSampleFormat(request.sampleFormatMappingInterpreted) &&
        isDsdSampleFormat(static_cast<AudioSampleFormat>(request.sampleFormatMappingReported)) &&
        isDsdSampleFormat(static_cast<AudioSampleFormat>(request.sampleFormatMappingInterpreted))) {
      openConfig_.sampleFormatMapping = AsioSampleFormatMapping{
          .reported = static_cast<AudioSampleFormat>(request.sampleFormatMappingReported),
          .interpreted = static_cast<AudioSampleFormat>(request.sampleFormatMappingInterpreted)};
    }
    if (request.nativeDsdControlOrder >= static_cast<int32_t>(AsioNativeDsdControlOrder::Default) &&
        request.nativeDsdControlOrder <= static_cast<int32_t>(AsioNativeDsdControlOrder::RateOnly)) {
      openConfig_.nativeDsdControlOrder =
          static_cast<AsioNativeDsdControlOrder>(request.nativeDsdControlOrder);
    }
    AsioOpenResult result;
    std::string error;
    if (!host_->open(openConfig_, &result, &error)) {
      const std::string restoreError = host_->lastCloseError();
      if (!restoreError.empty()) {
        response->openFailureKind = static_cast<int32_t>(AsioOpenFailureKind::Driver);
        fail(response, FailureReason::FormatRestoreFailed, restoreError);
        return false;
      }
      response->openFailureKind = static_cast<int32_t>(result.failureKind);
      fail(response, FailureReason::DeviceRejected, error.empty() ? "ASIO driver rejected the open" : error);
      return false;
    }
    opened_ = true;
    response->actualFormat = encodeAudioFormat(result.actualFormat);
    response->bufferSizeFrames = static_cast<int32_t>(result.bufferSizeFrames);
    response->latencyFrames = static_cast<int32_t>(result.latencyFrames);
    copyText(response->driverName, sizeof(response->driverName), result.driverName);
    response->driverVersion = static_cast<int32_t>(result.driverVersion);
    copyText(
        response->nativeDsdNegotiation,
        sizeof(response->nativeDsdNegotiation),
        result.nativeDsdNegotiation);
    response->openFailureKind = static_cast<int32_t>(result.failureKind);
    return true;
  }

  bool createBuffers(Response* response) {
    if (!opened_) {
      fail(response, FailureReason::CommandFailed, "ASIO helper has no open driver session");
      return false;
    }
    std::string error;
    if (!host_->createBuffers(
            [this](long bufferIndex) noexcept { onBufferSwitch(bufferIndex); },
            [this](AsioHostEvent event, const std::string& message) {
              publishHostEvent(event, message);
            },
            &error)) {
      fail(response, FailureReason::DeviceRejected, error.empty() ? "ASIO buffer creation failed" : error);
      return false;
    }
    activeBufferSize_ = host_->activeBufferSize();
    activeChannelCount_ = openConfig_.format.channelCount;
    if (activeBufferSize_ <= 0 || activeBufferSize_ > static_cast<long>(kMaxFrames) ||
        activeChannelCount_ <= 0 || activeChannelCount_ > static_cast<int>(kMaxChannels)) {
      host_->close();
      opened_ = false;
      fail(response, FailureReason::ProtocolError, "ASIO driver buffer geometry exceeds the helper protocol limit");
      return false;
    }
    shared_->activeBufferSizeFrames = static_cast<int32_t>(activeBufferSize_);
    shared_->activeChannelCount = static_cast<uint32_t>(activeChannelCount_);
    response->bufferSizeFrames = static_cast<int32_t>(activeBufferSize_);
    response->channelCount = static_cast<uint32_t>(activeChannelCount_);
    for (int channel = 0; channel < activeChannelCount_; ++channel) {
      const ChannelFormatRecord record = encodeChannelFormat(host_->outputChannelFormat(channel));
      channelFormats_[static_cast<size_t>(channel)] = decodeChannelFormat(record);
      shared_->activeChannelFormats[channel] = record;
      response->channelFormats[channel] = record;
    }
    for (auto& buffer : shared_->buffers) {
      exchangeAtomic(&buffer.generation, 0);
      exchangeAtomic(&buffer.consumedGeneration, 0);
      buffer.committedFrames = 0;
      std::memset(buffer.channelBytes, 0, sizeof(buffer.channelBytes));
    }
    exchangeAtomic(&shared_->callbackWriteSequence, 0);
    exchangeAtomic(&shared_->callbackReadSequence, 0);
    exchangeAtomic(&shared_->callbackHeartbeat, 0);
    exchangeAtomic(&shared_->callbackDropCount, 0);
    exchangeAtomic(&shared_->renderUnderrunCount, 0);
    outputReadyEnabled_.store(true, std::memory_order_release);
    return true;
  }

  bool start(Response* response) {
    std::string error;
    if (!host_->start(&error)) {
      fail(response, FailureReason::DeviceRejected, error.empty() ? "ASIO driver start failed" : error);
      return false;
    }
    started_.store(true, std::memory_order_release);
    if (options_.afterStart) options_.afterStart();
    return true;
  }

  bool close(Response* response) {
    if (options_.beforeClose) options_.beforeClose();
    if (started_.exchange(false, std::memory_order_acq_rel)) host_->stop();
    if (opened_) host_->close();
    opened_ = false;
    outputReadyEnabled_.store(false, std::memory_order_release);
    std::string closeError = host_->lastCloseError();
    if (options_.closeErrorOverride) {
      const std::string overrideError = options_.closeErrorOverride();
      if (!overrideError.empty()) closeError = overrideError;
    }
    if (response) response->formatRestored = closeError.empty() ? 1 : 0;
    if (!closeError.empty()) {
      if (response) fail(response, FailureReason::FormatRestoreFailed, closeError);
      return false;
    }
    activeBufferSize_ = 0;
    activeChannelCount_ = 0;
    return true;
  }

  void fail(Response* response, FailureReason reason, const std::string& message) {
    if (!response) return;
    response->ok = 0;
    response->failureReason = static_cast<int32_t>(reason);
    copyText(response->message, sizeof(response->message), message);
  }

  void onBufferSwitch(long bufferIndex) noexcept {
    if (!started_.load(std::memory_order_acquire) || bufferIndex < 0 || bufferIndex > 1 ||
        !shared_) {
      return;
    }
    RenderBuffer& buffer = shared_->buffers[bufferIndex];
    const LONG generation = readAtomic(&buffer.generation);
    const LONG consumed = readAtomic(&buffer.consumedGeneration);
    const bool fresh = generation != consumed && generation > 0;
    MemoryBarrier();
    for (int channel = 0; channel < activeChannelCount_; ++channel) {
      uint8_t* destination = static_cast<uint8_t*>(host_->outputBuffer(channel, bufferIndex));
      if (!destination) continue;
      const AsioChannelFormat& format = channelFormats_[static_cast<size_t>(channel)];
      const size_t bytesPerFrame = asio::bytesPerSample(format);
      if (bytesPerFrame == 0) continue;
      if (fresh) {
        const uint32_t bytes = buffer.channelBytes[channel];
        if (bytes <= kChannelStride) {
          std::memcpy(destination, channelBuffer(shared_, channel, bufferIndex), bytes);
          continue;
        }
      }
      const size_t safeFrames = isDsdSampleFormat(format.logicalFormat)
          ? std::max<size_t>(1, static_cast<size_t>(activeBufferSize_) / 8)
          : static_cast<size_t>(activeBufferSize_);
      const size_t bytes = std::min<size_t>(safeFrames * bytesPerFrame, kChannelStride);
      const uint8_t idle = isDsdSampleFormat(format.logicalFormat)
          ? asio::nativeDsdIdleByte(format.logicalFormat)
          : 0;
      std::memset(destination, idle, bytes);
    }
    if (fresh) {
      MemoryBarrier();
      exchangeAtomic(&buffer.consumedGeneration, generation);
    } else {
      incrementAtomic(&shared_->renderUnderrunCount);
    }
    if (outputReadyEnabled_.load(std::memory_order_acquire) && !host_->outputReady()) {
      outputReadyEnabled_.store(false, std::memory_order_release);
    }
    const LONG write = readAtomic(&shared_->callbackWriteSequence);
    const LONG read = readAtomic(&shared_->callbackReadSequence);
    if (write - read >= static_cast<LONG>(kCallbackRingSize)) {
      incrementAtomic(&shared_->callbackDropCount);
    } else {
      CallbackRecord& record = shared_->callbacks[static_cast<uint32_t>(write) % kCallbackRingSize];
      record.bufferIndex = static_cast<int32_t>(bufferIndex);
      record.sequence = static_cast<uint32_t>(write + 1);
      MemoryBarrier();
      exchangeAtomic(&shared_->callbackWriteSequence, write + 1);
    }
    incrementAtomic(&shared_->callbackHeartbeat);
  }

  void publishHostEvent(AsioHostEvent event, const std::string& message) {
    const LONG write = readAtomic(&shared_->hostEventWriteSequence);
    const LONG read = readAtomic(&shared_->hostEventReadSequence);
    if (write - read >= static_cast<LONG>(kHostEventRingSize)) return;
    HostEventRecord& record = shared_->hostEvents[static_cast<uint32_t>(write) % kHostEventRingSize];
    record.event = static_cast<int32_t>(event);
    record.sequence = static_cast<uint32_t>(write + 1);
    copyText(record.message, sizeof(record.message), message);
    MemoryBarrier();
    exchangeAtomic(&shared_->hostEventWriteSequence, write + 1);
  }

  SharedMemory* shared_ = nullptr;
  HANDLE responseEvent_ = nullptr;
  std::unique_ptr<IAsioHost> host_;
  AsioHelperServerOptions options_;
  AsioOpenConfig openConfig_;
  std::array<AsioChannelFormat, kMaxChannels> channelFormats_{};
  long activeBufferSize_ = 0;
  int activeChannelCount_ = 0;
  bool opened_ = false;
  std::atomic<bool> started_{false};
  std::atomic<bool> outputReadyEnabled_{false};
};

void publishStartupFailure(SharedMemory* shared, FailureReason reason, const std::string& message) {
  if (!shared) return;
  copyText(shared->statusMessage, sizeof(shared->statusMessage), message);
  exchangeAtomic(&shared->failureReason, static_cast<LONG>(reason));
  MemoryBarrier();
  exchangeAtomic(&shared->helperState, static_cast<LONG>(HelperState::Failed));
}

}  // namespace

int runAsioHelperServer(
    const std::wstring& mappingName,
    const std::wstring& requestEventName,
    const std::wstring& responseEventName,
    std::unique_ptr<IAsioHost> host,
    AsioHelperServerOptions options) {
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName.c_str());
  if (!mapping) return 2;
  auto* shared = static_cast<SharedMemory*>(
      MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedMemory)));
  if (!shared) {
    CloseHandle(mapping);
    return 2;
  }
  const auto cleanup = [&] {
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
  };
  if (shared->magic != kProtocolMagic || shared->version != kProtocolVersion ||
      shared->structureBytes != sizeof(SharedMemory) || !host) {
    publishStartupFailure(shared, FailureReason::ProtocolError, "ASIO helper protocol validation failed");
    cleanup();
    return 2;
  }
  HANDLE requestEvent = OpenEventW(SYNCHRONIZE, FALSE, requestEventName.c_str());
  HANDLE responseEvent = OpenEventW(EVENT_MODIFY_STATE, FALSE, responseEventName.c_str());
  if (!requestEvent || !responseEvent) {
    publishStartupFailure(shared, FailureReason::ProtocolError, "ASIO helper could not open control events");
    if (responseEvent) CloseHandle(responseEvent);
    if (requestEvent) CloseHandle(requestEvent);
    cleanup();
    return 2;
  }

  Server server(shared, responseEvent, std::move(host), std::move(options));
  exchangeAtomic(&shared->failureReason, static_cast<LONG>(FailureReason::None));
  exchangeAtomic(&shared->helperState, static_cast<LONG>(HelperState::Ready));
  int32_t handledSequence = 0;
  bool shutdown = false;
  while (!shutdown && readAtomic(&shared->helperState) == static_cast<LONG>(HelperState::Ready)) {
    const DWORD wait = WaitForSingleObject(requestEvent, 250);
    incrementAtomic(&shared->helperHeartbeat);
    if (wait == WAIT_FAILED) {
      publishStartupFailure(shared, FailureReason::ProtocolError, "ASIO helper request wait failed");
      break;
    }
    if (wait == WAIT_TIMEOUT) continue;
    const int32_t sequence = readAtomic(&shared->requestSequence);
    if (sequence <= handledSequence) continue;
    MemoryBarrier();
    server.handle(sequence, &shutdown);
    handledSequence = sequence;
  }
  exchangeAtomic(&shared->helperState, static_cast<LONG>(HelperState::Stopped));
  CloseHandle(responseEvent);
  CloseHandle(requestEvent);
  cleanup();
  return 0;
}

}  // namespace twilight::audio::asio_helper
