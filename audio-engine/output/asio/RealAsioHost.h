#pragma once

#include "IAsioHost.h"

#include <memory>

namespace twilight::audio {

class RealAsioHost final : public IAsioHost {
 public:
  RealAsioHost();
  ~RealAsioHost() override;

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
  std::string lastCloseError() const override;

 private:
  struct Impl;

  std::unique_ptr<Impl> impl_;
};

}  // namespace twilight::audio
