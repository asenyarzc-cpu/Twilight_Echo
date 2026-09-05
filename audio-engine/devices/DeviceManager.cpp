#include "DeviceCatalog.h"
#include "DeviceManager.h"
#include "../output/OutputBackendFactory.h"

#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <propsys.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#endif

#if defined(_WIN32) && defined(TAE_ENABLE_MINIAUDIO)
#include "../output/miniaudio/MiniaudioPcmBackend.h"
#endif

#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#ifndef kAudioObjectPropertyElementMain
#define kAudioObjectPropertyElementMain kAudioObjectPropertyElementMaster
#endif
#endif

#if defined(__linux__) && defined(TAE_ENABLE_ALSA)
#include <alsa/asoundlib.h>
#endif

namespace twilight::audio {
namespace {

std::string escapeJson(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
std::string wideToUtf8(const wchar_t* value) {
  if (!value) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, out.data(), size, nullptr, nullptr);
  if (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

std::string readDeviceName(IMMDevice* device) {
  Microsoft::WRL::ComPtr<IPropertyStore> properties;
  if (!device || FAILED(device->OpenPropertyStore(STGM_READ, &properties))) return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  std::string name;
  if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR) {
    name = wideToUtf8(value.pwszVal);
  }
  PropVariantClear(&value);
  return name;
}

std::vector<PcmDeviceCatalogEntry> enumerateLegacyWindowsPcmDevices(std::string* error) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool shouldUninitialize = SUCCEEDED(hr);
  if (hr == RPC_E_CHANGED_MODE) hr = S_OK;
  if (FAILED(hr)) {
    if (error) *error = "初始化 Windows 音频设备目录失败";
    return {};
  }

  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) {
    if (shouldUninitialize) CoUninitialize();
    if (error) *error = "创建 Windows 音频设备目录失败";
    return {};
  }

  std::string defaultId;
  Microsoft::WRL::ComPtr<IMMDevice> defaultDevice;
  if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &defaultDevice))) {
    LPWSTR rawId = nullptr;
    if (SUCCEEDED(defaultDevice->GetId(&rawId))) {
      defaultId = wideToUtf8(rawId);
      CoTaskMemFree(rawId);
    }
  }

  std::vector<PcmDeviceCatalogEntry> devices;
  Microsoft::WRL::ComPtr<IMMDeviceCollection> collection;
  if (SUCCEEDED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection))) {
    UINT count = 0;
    collection->GetCount(&count);
    devices.reserve(count);
    for (UINT index = 0; index < count; ++index) {
      Microsoft::WRL::ComPtr<IMMDevice> device;
      if (FAILED(collection->Item(index, &device))) continue;
      LPWSTR rawId = nullptr;
      if (FAILED(device->GetId(&rawId))) continue;
      const std::string id = wideToUtf8(rawId);
      CoTaskMemFree(rawId);
      const std::string label = readDeviceName(device.Get());
      devices.push_back({id, label.empty() ? id : label, id == defaultId});
    }
  } else if (error) {
    *error = "枚举 Windows 音频设备失败";
  }

  if (shouldUninitialize) CoUninitialize();
  return keepUnambiguousPcmDevices(devices);
}
#endif

#if defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
std::string cfStringToUtf8(CFStringRef value) {
  if (!value) return {};
  char stack[512] = {};
  if (CFStringGetCString(value, stack, sizeof(stack), kCFStringEncodingUTF8)) return stack;
  const CFIndex length = CFStringGetLength(value);
  const CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  if (maxSize <= 1) return {};
  std::string out(static_cast<size_t>(maxSize), '\0');
  if (!CFStringGetCString(value, out.data(), maxSize, kCFStringEncodingUTF8)) return {};
  if (!out.empty()) out.resize(std::strlen(out.c_str()));
  return out;
}

std::string readCoreAudioString(AudioDeviceID device, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address{selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, &value) != noErr || !value) return {};
  std::string out = cfStringToUtf8(value);
  CFRelease(value);
  return out;
}

int coreAudioOutputChannelCount(AudioDeviceID device) {
  AudioObjectPropertyAddress address{
      kAudioDevicePropertyStreamConfiguration,
      kAudioDevicePropertyScopeOutput,
      kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &address, 0, nullptr, &size) != noErr || size == 0) return 0;
  std::string storage(size, '\0');
  if (AudioObjectGetPropertyData(device, &address, 0, nullptr, &size, storage.data()) != noErr) return 0;
  auto* list = reinterpret_cast<AudioBufferList*>(storage.data());
  int channels = 0;
  for (UInt32 i = 0; i < list->mNumberBuffers; ++i) {
    channels += static_cast<int>(list->mBuffers[i].mNumberChannels);
  }
  return channels;
}

std::string defaultCoreAudioUid() {
  AudioObjectPropertyAddress address{
      kAudioHardwarePropertyDefaultOutputDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain};
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, &device) != noErr) return {};
  return readCoreAudioString(device, kAudioDevicePropertyDeviceUID);
}
#endif

#if defined(__linux__) && defined(TAE_ENABLE_ALSA)
std::string firstLine(std::string value) {
  const size_t newline = value.find('\n');
  if (newline != std::string::npos) value.resize(newline);
  return value;
}
#endif

std::string boolJson(bool value) {
  return value ? "true" : "false";
}

}  // namespace

#if defined(_WIN32) && TAE_ENABLE_ASIO
std::string enumerateAsioDevicesJson();
#endif

std::string enumeratePlatformDevicesJson() {
#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
  std::string catalogError;
  std::vector<PcmDeviceCatalogEntry> devices;
  const PcmOutputProviderSelection& selection = configuredPcmOutputProvider();
  if (selection.status != PcmOutputProviderStatus::Ready) {
    catalogError = selection.error;
  } else if (selection.provider == PcmOutputProvider::Miniaudio) {
#if defined(TAE_ENABLE_MINIAUDIO)
    devices = enumerateMiniaudioPcmDevices(&catalogError);
#else
    catalogError = "当前构建未启用 miniaudio 设备目录";
#endif
  } else {
    devices = enumerateLegacyWindowsPcmDevices(&catalogError);
  }

  std::string json = windowsPcmDeviceCatalogJson(devices, catalogError);

#if TAE_ENABLE_ASIO
  const std::string asioJson = enumerateAsioDevicesJson();
  if (asioJson.size() > 2) {
    json.pop_back();
    json += "," + asioJson.substr(1);
  }
#endif
  return json;
#elif defined(__APPLE__) && defined(TAE_ENABLE_COREAUDIO)
  std::ostringstream json;
  const std::string defaultUid = defaultCoreAudioUid();
  json << "[{\"id\":\"auto\",\"label\":\"\\u7cfb\\u7edf\\u9ed8\\u8ba4\",\"isDefault\":true,"
       << "\"supportsExclusive\":true,\"supportsHogMode\":true,\"supportsDirectHw\":false,"
       << "\"supportsDop\":false,\"supportsNativeDsd\":false,\"supportedDsdRates\":[],"
       << "\"pathKind\":\"hal\",\"capabilityReason\":\"CoreAudio HAL path; Hog Mode exclusive available\"}";

  AudioObjectPropertyAddress address{
      kAudioHardwarePropertyDevices,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) == noErr && size > 0) {
    std::string storage(size, '\0');
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, storage.data()) == noErr) {
      const auto* devices = reinterpret_cast<const AudioDeviceID*>(storage.data());
      const size_t count = size / sizeof(AudioDeviceID);
      for (size_t i = 0; i < count; ++i) {
        if (coreAudioOutputChannelCount(devices[i]) <= 0) continue;
        const std::string uid = readCoreAudioString(devices[i], kAudioDevicePropertyDeviceUID);
        if (uid.empty()) continue;
        std::string label = readCoreAudioString(devices[i], kAudioObjectPropertyName);
        if (label.empty()) label = uid;
        json << ",{\"id\":\"" << escapeJson(uid) << "\",\"label\":\"" << escapeJson(label)
             << "\",\"isDefault\":" << (uid == defaultUid ? "true" : "false")
             << ",\"supportsExclusive\":true,\"supportsHogMode\":true,\"supportsDirectHw\":false,"
             << "\"supportsDop\":false,\"supportsNativeDsd\":false,\"supportedDsdRates\":[],"
             << "\"pathKind\":\"hal\",\"capabilityReason\":\"CoreAudio HAL path; Hog Mode exclusive available\"}";
      }
    }
  }
  json << "]";
  return json.str();
#elif defined(__linux__) && defined(TAE_ENABLE_ALSA)
  std::ostringstream json;
  json << "[{\"id\":\"auto\",\"label\":\"\\u7cfb\\u7edf\\u9ed8\\u8ba4\",\"isDefault\":true,"
       << "\"supportsExclusive\":false,\"supportsHogMode\":false,\"supportsDirectHw\":false,"
       << "\"supportsDop\":false,\"supportsNativeDsd\":false,\"supportedDsdRates\":[],"
       << "\"pathKind\":\"default\",\"capabilityReason\":\"ALSA default route may include plugin or mixer stages\"}";
  void** hints = nullptr;
  if (snd_device_name_hint(-1, "pcm", &hints) == 0 && hints) {
    for (void** hint = hints; *hint; ++hint) {
      char* rawName = snd_device_name_get_hint(*hint, "NAME");
      char* rawDesc = snd_device_name_get_hint(*hint, "DESC");
      char* rawIo = snd_device_name_get_hint(*hint, "IOID");
      const std::string io = rawIo ? rawIo : "";
      if (rawName && (io.empty() || io == "Output")) {
        const std::string name = rawName;
        std::string label = rawDesc ? firstLine(rawDesc) : name;
        if (label.empty()) label = name;
        const bool directHw = name.rfind("hw:", 0) == 0;
        const bool plugHw = name.rfind("plughw:", 0) == 0;
        const std::string pathKind = directHw ? "hw" : (plugHw ? "plughw" : "default");
        const std::string capabilityReason = directHw
                                                 ? "ALSA hw: direct device; native DSD probed at runtime via DSD_U8/U16_LE/U32_LE"
                                                 : (plugHw ? "plughw may insert format conversion"
                                                           : "ALSA default route may include plugin or mixer stages");
        json << ",{\"id\":\"" << escapeJson(name) << "\",\"label\":\"" << escapeJson(label)
             << "\",\"isDefault\":" << (name == "default" ? "true" : "false")
             << ",\"supportsExclusive\":false,\"supportsHogMode\":false,\"supportsDirectHw\":"
             << boolJson(directHw) << ",\"supportsDop\":false,\"supportsNativeDsd\":"
             << boolJson(directHw) << ",\"supportedDsdRates\":"
             << (directHw ? "[2822400,5644800,11289600,22579200]" : "[]")
             << ",\"pathKind\":\"" << pathKind
             << "\",\"capabilityReason\":\"" << escapeJson(capabilityReason) << "\"}";
      }
      if (rawName) free(rawName);
      if (rawDesc) free(rawDesc);
      if (rawIo) free(rawIo);
    }
    snd_device_name_free_hint(hints);
  }
  json << "]";
  return json.str();
#else
  return "[{\"id\":\"auto\",\"label\":\"\\u7cfb\\u7edf\\u9ed8\\u8ba4\",\"isDefault\":true,"
         "\"supportsExclusive\":false,\"supportsHogMode\":false,\"supportsDirectHw\":false,"
         "\"supportsDop\":false,\"supportsNativeDsd\":false,\"supportedDsdRates\":[],"
         "\"pathKind\":\"default\",\"capabilityReason\":\"\"}]";
#endif
}

}  // namespace twilight::audio
