#pragma once

#include "../IOutputBackend.h"
#include "MiniaudioApi.h"

#include <memory>
#include <string>

namespace twilight::audio {

class MiniaudioPcmBackend final : public IOutputBackend {
 public:
  MiniaudioPcmBackend();
  explicit MiniaudioPcmBackend(const miniaudio_backend_detail::Api& api);
  ~MiniaudioPcmBackend() override;

  const char* id() const override;
  bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) override;
  bool setOutputConfig(const OutputConfig& config, std::string* error) override;
  bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) override;
  void stop() override;
  void close() override;

  AudioFormat outputFormat() const override;
  OutputInfo outputInfo() const override;
  DopRuntimeFacts dopRuntimeFacts() const override;
  NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const override;
  std::string deviceName() const override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

bool miniaudioPcmBackendAvailable();

}  // namespace twilight::audio
