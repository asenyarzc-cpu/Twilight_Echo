#include "IAsioHost.h"

#include <memory>
#include <sstream>

namespace twilight::audio {
namespace {

std::string jsonEscape(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (unsigned char character : value) {
    switch (character) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (character >= 0x20) escaped += static_cast<char>(character);
        break;
    }
  }
  return escaped;
}

}  // namespace

#if !defined(_WIN32) || !defined(_WIN64) || !defined(TAE_ENABLE_ASIO)
/**
 * The real isolated host spawns the Windows helper process, but the portable
 * backend TU still references the factory. Non-ASIO builds link this fail-closed
 * stub instead, so device enumeration degrades to an empty list and every open
 * attempt reports ASIO as unavailable rather than failing to link.
 */
class UnsupportedAsioHost final : public IAsioHost {
 public:
  std::vector<AsioDeviceInfo> enumerateDevices() override { return {}; }
  AsioHostDiagnostics diagnostics() const override { return {}; }
  bool probeDevice(const std::string&, AsioDeviceInfo*, std::string*) override { return false; }
  bool open(const AsioOpenConfig&, AsioOpenResult*, std::string* error) override {
    if (error) *error = "ASIO is only supported on Windows x64";
    return false;
  }
  bool createBuffers(AsioBufferSwitchCallback, AsioEventCallback, std::string*) override {
    return false;
  }
  bool start(std::string*) override { return false; }
  void stop() override {}
  void close() override {}
  void* outputBuffer(long, long) override { return nullptr; }
  AudioSampleFormat outputSampleFormat(long) const override {
    return AudioSampleFormat::Float32Interleaved;
  }
  AsioChannelFormat outputChannelFormat(long) const override { return {}; }
  bool outputReady() override { return false; }
  long activeBufferSize() const override { return 0; }
};

std::unique_ptr<IAsioHost> createIsolatedAsioHost() {
  return std::make_unique<UnsupportedAsioHost>();
}
#endif

std::string enumerateAsioDevicesJson() {
  std::ostringstream json;
  json << '[';
  bool first = true;
  for (const auto& device : createIsolatedAsioHost()->enumerateDevices()) {
    if (!first) json << ',';
    first = false;
    json << "{\"id\":\"" << jsonEscape(device.id) << "\",\"label\":\""
         << jsonEscape(device.name) << "\",\"name\":\"" << jsonEscape(device.name)
         << "\",\"backend\":\"asio\",\"isDefault\":"
         << (device.isDefault ? "true" : "false") << ",\"capabilityProbed\":"
         << (device.capabilityProbed ? "true" : "false");
    if (device.capabilityProbed) {
      json << ",\"supportsNativeDsd\":" << (device.nativeDsdCapable ? "true" : "false")
           << ",\"supportsDop\":" << (device.dopCapable ? "true" : "false");
      if (!device.nativeDsdSampleRates.empty()) {
        json << ",\"nativeDsdSampleRates\":[";
        for (size_t index = 0; index < device.nativeDsdSampleRates.size(); ++index) {
          if (index > 0) json << ',';
          json << device.nativeDsdSampleRates[index];
        }
        json << ']';
      }
      if (!device.dopCarrierSampleRates.empty()) {
        json << ",\"dopCarrierSampleRates\":[";
        for (size_t index = 0; index < device.dopCarrierSampleRates.size(); ++index) {
          if (index > 0) json << ',';
          json << device.dopCarrierSampleRates[index];
        }
        json << ']';
      }
    }
    json << '}';
  }
  json << ']';
  return json.str();
}

std::vector<std::string> asioNativeDsdCapableDeviceIds() {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  auto host = createIsolatedAsioHost();
  std::vector<std::string> capable;
  for (const auto& device : host->enumerateDevices()) {
    AsioDeviceInfo probed = device;
    if (!device.nativeDsdCapable) {
      std::string probeError;
      if (!host->probeDevice(device.id, &probed, &probeError)) continue;
    }
    if (probed.nativeDsdCapable) capable.push_back(probed.id);
  }
  return capable;
#else
  return {};
#endif
}

}  // namespace twilight::audio
