#include "RealAsioHost.h"

#include "DeviceCapabilityCache.h"

#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
#include "windows/AsioControlThread.h"
#include "windows/AsioDriverCatalog.h"
#include "windows/AsioDriverSession.h"
#endif

#include <cstdlib>
#include <memory>
#include <sstream>
#include <utility>

namespace twilight::audio {
namespace {

bool asioEnabled() {
  const char* value = std::getenv("TWILIGHT_DISABLE_ASIO");
  return !value || std::string_view(value) != "1";
}

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

#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
AsioDeviceInfo deviceInfoFor(const asio_windows::AsioDriverEntry& entry) {
  AsioDeviceInfo device;
  device.id = entry.id;
  device.name = entry.displayName;
  device.driverName = entry.displayName;
  return device;
}
#endif

}  // namespace

struct RealAsioHost::Impl {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  std::shared_ptr<asio_windows::AsioControlThread> controlThread;
  std::unique_ptr<asio_windows::AsioDriverSession> session;
#endif
};

RealAsioHost::RealAsioHost() : impl_(std::make_unique<Impl>()) {}

RealAsioHost::~RealAsioHost() {
  close();
}

std::vector<AsioDeviceInfo> RealAsioHost::enumerateDevices() {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  if (!asioEnabled()) return {};
  std::vector<AsioDeviceInfo> devices;
  for (const auto& entry : asio_windows::AsioDriverCatalog::enumerate()) {
    AsioDeviceInfo device = deviceInfoFor(entry);
    // The registry has identity only. Prefer a previously probed capability
    // record so format selection ranks against what the driver really accepts
    // instead of a hardcoded guess set.
    if (const auto cached = DeviceCapabilityCache::instance().get(device.id)) {
      AsioDeviceInfo merged = *cached;
      merged.id = device.id;
      merged.name = device.name;
      if (merged.driverName.empty()) merged.driverName = device.driverName;
      device = merged;
    }
    devices.push_back(std::move(device));
  }
  return devices;
#else
  return {};
#endif
}

bool RealAsioHost::probeDevice(const std::string& deviceId, AsioDeviceInfo* info, std::string* error) {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  if (!info) {
    if (error) *error = "ASIO capability probe requires an output record";
    return false;
  }
  if (!asioEnabled()) {
    if (error) *error = "ASIO backend is disabled by TWILIGHT_DISABLE_ASIO=1";
    return false;
  }
  const auto entry = asio_windows::AsioDriverCatalog::resolve(deviceId);
  if (!entry) {
    if (error) *error = "ASIO device was not found or legacy device name is ambiguous";
    return false;
  }

  AsioDeviceInfo probed = deviceInfoFor(*entry);
  probed.capabilityVersion = DeviceCapabilityCache::instance().version(probed.id);

  // A probe owns its own control thread and driver instance so it can never
  // disturb the session this host may already be holding open.
  auto controlThread = std::make_shared<asio_windows::AsioControlThread>();
  asio_windows::AsioDriverSession session(*entry, controlThread);
  const bool ok = session.probe(&probed, error);
  session.close();
  controlThread->stop();
  if (!ok) return false;

  DeviceCapabilityCache::instance().put(probed);
  *info = probed;
  return true;
#else
  (void)deviceId;
  (void)info;
  if (error) *error = "ASIO is available only in a Windows x64 build";
  return false;
#endif
}

AsioHostDiagnostics RealAsioHost::diagnostics() const {
  AsioHostDiagnostics result;
  result.processArchitecture = sizeof(void*) == 8 ? "x64" : "x86";
  result.environmentDisabled = !asioEnabled();
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  result.buildEnabled = true;
  const auto catalog = asio_windows::AsioDriverCatalog::diagnostics();
  result.registeredDriverCount32 = catalog.registeredDriverCount32;
  result.registeredDriverCount64 = catalog.registeredDriverCount64;
  result.loadableDriverCount64 = catalog.loadableDriverCount64;
#endif
  return result;
}

bool RealAsioHost::open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  close();
  if (!asioEnabled()) {
    if (error) *error = "ASIO backend is disabled by TWILIGHT_DISABLE_ASIO=1";
    return false;
  }
  const auto entry = asio_windows::AsioDriverCatalog::resolve(config.deviceId);
  if (!entry) {
    if (error) *error = "ASIO device was not found or legacy device name is ambiguous";
    return false;
  }
  impl_->controlThread = std::make_shared<asio_windows::AsioControlThread>();
  impl_->session = std::make_unique<asio_windows::AsioDriverSession>(*entry, impl_->controlThread);
  if (impl_->session->open(config, result, error)) return true;
  close();
  return false;
#else
  if (error) *error = "ASIO is available only in a Windows x64 build";
  return false;
#endif
}

bool RealAsioHost::createBuffers(
    AsioBufferSwitchCallback bufferSwitch,
    AsioEventCallback eventCallback,
    std::string* error) {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  if (!impl_->session) {
    if (error) *error = "ASIO session is not open";
    return false;
  }
  return impl_->session->createBuffers(std::move(bufferSwitch), std::move(eventCallback), error);
#else
  if (error) *error = "ASIO is available only in a Windows x64 build";
  return false;
#endif
}

bool RealAsioHost::start(std::string* error) {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  if (!impl_->session) {
    if (error) *error = "ASIO session is not open";
    return false;
  }
  return impl_->session->start(error);
#else
  if (error) *error = "ASIO is available only in a Windows x64 build";
  return false;
#endif
}

void RealAsioHost::stop() {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  if (impl_->session) impl_->session->stop();
#endif
}

void RealAsioHost::close() {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  if (impl_->session) impl_->session->close();
  impl_->session.reset();
  if (impl_->controlThread) impl_->controlThread->stop();
  impl_->controlThread.reset();
#endif
}

void* RealAsioHost::outputBuffer(long channel, long bufferIndex) {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  return impl_->session ? impl_->session->outputBuffer(channel, bufferIndex) : nullptr;
#else
  return nullptr;
#endif
}

AudioSampleFormat RealAsioHost::outputSampleFormat(long channel) const {
  return outputChannelFormat(channel).logicalFormat;
}

AsioChannelFormat RealAsioHost::outputChannelFormat(long channel) const {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  return impl_->session ? impl_->session->outputChannelFormat(channel) : AsioChannelFormat{};
#else
  return {};
#endif
}

bool RealAsioHost::outputReady() {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  return impl_->session && impl_->session->outputReady();
#else
  return false;
#endif
}

long RealAsioHost::activeBufferSize() const {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  return impl_->session ? impl_->session->activeBufferSize() : 0;
#else
  return 0;
#endif
}

std::unique_ptr<IAsioHost> createRealAsioHost() {
  return std::make_unique<RealAsioHost>();
}

std::vector<int> asioDefaultSampleRateProbeSet() {
  return {
      44100,
      48000,
      88200,
      96000,
      176400,
      192000,
      352800,
      384000,
      705600,
      768000,
      1411200,
      1536000};
}

std::vector<int> asioDsdSemanticRateProbeSet() {
  return {
      2822400,   // DSD64
      3072000,   // DSD64  (48k family)
      5644800,   // DSD128
      6144000,   // DSD128 (48k family)
      11289600,  // DSD256
      12288000,  // DSD256 (48k family)
      22579200,  // DSD512
      24576000};  // DSD512 (48k family)
}

std::string asioSampleFormatName(AudioSampleFormat format) {
  return sampleFormatToString(format);
}

std::string enumerateAsioDevicesJson() {
  std::ostringstream json;
  json << '[';
  bool first = true;
  for (const auto& device : createRealAsioHost()->enumerateDevices()) {
    if (!first) json << ',';
    first = false;
    json << "{\"id\":\"" << jsonEscape(device.id) << "\",\"label\":\"" << jsonEscape(device.name)
         << "\",\"name\":\"" << jsonEscape(device.name)
         << "\",\"backend\":\"asio\",\"isDefault\":" << (device.isDefault ? "true" : "false")
         << ",\"supportsNativeDsd\":" << (device.nativeDsdCapable ? "true" : "false")
         << ",\"supportsDop\":" << (device.dopCapable ? "true" : "false") << '}';
  }
  json << ']';
  return json.str();
}

std::vector<std::string> asioNativeDsdCapableDeviceIds() {
#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
  auto host = createRealAsioHost();
  std::vector<std::string> capable;
  for (const auto& device : host->enumerateDevices()) {
    AsioDeviceInfo probed = device;
    // Probe results are cached, so repeated auto-discovery costs one driver
    // interrogation per device per process, not one per track.
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
