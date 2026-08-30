#pragma once

#include "IAsioHost.h"

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace twilight::audio {

class MockAsioHost final : public IAsioHost {
 public:
  struct DsdProfile {
    bool dopCapable = false;
    bool nativeDsdCapable = false;
    std::vector<int> dopCarrierSampleRates;
    std::vector<AudioSampleFormat> dopCarrierSampleFormats;
    std::vector<int> nativeDsdSampleRates;
    std::vector<AudioSampleFormat> nativeDsdSampleFormats;
  };

  struct ChannelBuffer {
    std::array<std::vector<uint8_t>, 2> buffers;
  };

  enum class OpenFailure {
    DriverInit,
    DriverOpen,
    // A refusal of this specific rate / sample type. The backend is expected to
    // try its next ranked candidate, unlike the two driver-wide faults above.
    FormatRefused
  };

  std::vector<AsioDeviceInfo> devices;
  AsioOpenConfig lastOpenConfig;
  AsioOpenResult openResult;
  std::optional<AudioFormat> actualFormatOverride;
  std::vector<AudioSampleFormat> channelFormats;
  std::vector<AsioChannelFormat> channelDescriptors;
  std::vector<ChannelBuffer> channelBuffers;
  int openCalls = 0;
  int startCalls = 0;
  int stopCalls = 0;
  int closeCalls = 0;
  int createBuffersCalls = 0;
  mutable int outputChannelFormatCalls = 0;
  int outputReadyCalls = 0;
  int failOutputReadyCount = 0;
  int failOpenCount = 0;
  int failDriverInitCount = 0;
  int failDriverOpenCount = 0;
  int failCreateBuffersCount = 0;
  int failStartCount = 0;
  int probeCalls = 0;
  int failProbeCount = 0;
  /**
   * Refuse a raw DSD open whose semantic rate is absent from the target
   * device's declared nativeDsdSampleRates, as a real driver does.
   *
   * Without this the mock accepts every format, so a test cannot tell a backend
   * that pre-filters on cached capabilities from one that asks the driver. The
   * driver is the only authority on acceptance; capability data only ranks
   * candidates. Devices that declare no DSD rates are not constrained.
   */
  bool enforceDeclaredNativeDsdRates = true;
  // Capabilities the probe contributes, keyed by device id. Devices in
  // `devices` may start capability-free to model the registry-only enumeration
  // the real host performs before any probe.
  std::vector<AsioDeviceInfo> probeResults;
  OpenFailure openFailure = OpenFailure::DriverOpen;
  bool started = false;

  std::vector<AsioDeviceInfo> enumerateDevices() override;
  AsioHostDiagnostics diagnostics() const override;
  bool probeDevice(const std::string& deviceId, AsioDeviceInfo* info, std::string* error) override;
  bool open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) override;
  bool createBuffers(AsioBufferSwitchCallback bufferSwitch, AsioEventCallback eventCallback, std::string* error) override;
  bool start(std::string* error) override;
  void stop() override;
  void close() override;

  void* outputBuffer(long channel, long bufferIndex) override;
  AudioSampleFormat outputSampleFormat(long channel) const override;
  AsioChannelFormat outputChannelFormat(long channel) const override;
  bool outputReady() override;
  long activeBufferSize() const override;

  void triggerBufferSwitch(long bufferIndex);
  void triggerEvent(AsioHostEvent event, const std::string& message);

 private:
  AsioBufferSwitchCallback bufferSwitch_;
  AsioEventCallback eventCallback_;
};

AsioDeviceInfo makeMockAsioDevice(
    std::string id,
    std::vector<int> sampleRates,
    int channels = 2,
    AudioSampleFormat sampleFormat = AudioSampleFormat::Float32Interleaved,
    MockAsioHost::DsdProfile dsdProfile = {});

}  // namespace twilight::audio
