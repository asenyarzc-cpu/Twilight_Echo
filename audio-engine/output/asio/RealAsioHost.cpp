#include "RealAsioHost.h"

#include "DeviceCapabilityCache.h"

#if defined(_WIN32) && defined(_WIN64) && defined(TAE_ENABLE_ASIO)
#include "windows/AsioControlThread.h"
#include "windows/AsioDriverCatalog.h"
#include "windows/AsioDriverSession.h"
#endif

#include <cstdlib>
#include <memory>
#include <utility>

namespace twilight::audio {
namespace {

bool asioEnabled() {
  const char* value = std::getenv("TWILIGHT_DISABLE_ASIO");
  return !value || std::string_view(value) != "1";
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
  std::string lastCloseError;
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
  const std::string closeError = session.lastCloseError();
  controlThread->stop();
  if (!closeError.empty()) {
    if (error) *error = closeError;
    return false;
  }
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
  if (!impl_->lastCloseError.empty()) {
    if (error) *error = impl_->lastCloseError;
    return false;
  }
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
  const std::string closeError = impl_->session->lastCloseError();
  close();
  if (!closeError.empty()) {
    impl_->lastCloseError = closeError;
    if (error) *error = closeError;
  }
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
  if (impl_->session) {
    impl_->lastCloseError.clear();
    impl_->session->close();
    impl_->lastCloseError = impl_->session->lastCloseError();
  }
  impl_->session.reset();
  if (impl_->controlThread) impl_->controlThread->stop();
  impl_->controlThread.reset();
#endif
}

std::string RealAsioHost::lastCloseError() const {
  return impl_->lastCloseError;
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

}  // namespace twilight::audio
