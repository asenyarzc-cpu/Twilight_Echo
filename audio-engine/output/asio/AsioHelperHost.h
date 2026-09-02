#pragma once

#include "IAsioHost.h"
#include "helper/AsioHelperProcess.h"

#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace twilight::audio {

class AsioHelperHost final : public IAsioHost {
 public:
  AsioHelperHost();
  explicit AsioHelperHost(std::wstring helperPath);
  ~AsioHelperHost() override;

  std::vector<AsioDeviceInfo> enumerateDevices() override;
  AsioHostDiagnostics diagnostics() const override;
  bool probeDevice(const std::string& deviceId, AsioDeviceInfo* info, std::string* error) override;
  bool open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) override;
  bool createBuffers(
      AsioBufferSwitchCallback bufferSwitch,
      AsioEventCallback eventCallback,
      std::string* error) override;
  bool start(std::string* error) override;
  void stop() override;
  void close() override;
  void* outputBuffer(long channel, long bufferIndex) override;
  AudioSampleFormat outputSampleFormat(long channel) const override;
  AsioChannelFormat outputChannelFormat(long channel) const override;
  bool outputReady() override;
  long activeBufferSize() const override;
  void commitOutputBuffer(long bufferIndex, size_t frameCount) override;
  std::string lastCloseError() const override;

 private:
  bool ensureProcess(std::string* error) const;
  void startWorker();
  void stopWorker();
  void workerLoop();
  void dispatchHelperFailure(asio_helper::FailureReason reason, const std::string& detail);
  std::chrono::milliseconds callbackDeadline() const;

  mutable asio_helper::AsioHelperProcess process_;
  mutable std::mutex stateMutex_;
  AsioBufferSwitchCallback bufferSwitch_;
  AsioEventCallback eventCallback_;
  std::vector<AsioChannelFormat> channelFormats_;
  std::array<AsioChannelFormat, asio_helper::kMaxChannels> renderChannelFormats_{};
  std::atomic<uint32_t> renderChannelCount_{0};
  AudioFormat openFormat_;
  long activeBufferSize_ = 0;
  mutable std::string closeError_;
  std::thread worker_;
  std::atomic<bool> workerRunning_{false};
  std::atomic<bool> started_{false};
  std::atomic<bool> helperFailureDispatched_{false};
};

}  // namespace twilight::audio
