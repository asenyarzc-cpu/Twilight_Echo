#pragma once

#include <cstddef>
#include <cstdint>

namespace twilight::audio::miniaudio_backend_detail {

enum class DeviceFormat {
  Unknown,
  U8,
  S16,
  S24,
  S32,
  F32
};

enum class NotificationType {
  Started,
  Stopped,
  Rerouted,
  InterruptionBegan,
  InterruptionEnded,
  Unlocked
};

using DataCallback = void (*)(void* userData, void* output, uint32_t frameCount);
using NotificationCallback = void (*)(void* userData, NotificationType type);

struct CallbackContext {
  DataCallback dataCallback = nullptr;
  NotificationCallback notificationCallback = nullptr;
  void* userData = nullptr;
};

struct DeviceConfig {
  uint32_t sampleRate = 0;
  uint32_t channels = 0;
  bool shared = true;
  bool noFixedSizedCallback = true;
  bool noAutoConvertSRC = true;
  CallbackContext* callbackContext = nullptr;
};

struct DeviceState {
  uint32_t callbackSampleRate = 0;
  DeviceFormat callbackFormat = DeviceFormat::Unknown;
  uint32_t callbackChannels = 0;
  uint32_t internalSampleRate = 0;
  DeviceFormat internalFormat = DeviceFormat::Unknown;
  uint32_t internalChannels = 0;
  uint32_t internalPeriodSizeFrames = 0;
  uint32_t internalPeriods = 0;
  uint32_t bufferSizeFrames = 0;
  bool conversionInfoAvailable = false;
  bool sampleFormatConverted = false;
  bool sampleRateConverted = false;
  bool channelLayoutConverted = false;
  char deviceName[256] = {};
};

struct Api {
  void* userData = nullptr;
  void* (*createDevice)(void* userData) = nullptr;
  void (*destroyDevice)(void* userData, void* device) = nullptr;
  int (*initializeDevice)(void* userData, void* device, const DeviceConfig* config, DeviceState* state) = nullptr;
  int (*readDeviceState)(void* userData, void* device, DeviceState* state) = nullptr;
  int (*startDevice)(void* userData, void* device) = nullptr;
  int (*stopDevice)(void* userData, void* device) = nullptr;
  void (*uninitializeDevice)(void* userData, void* device) = nullptr;
};

const Api& realApi();

}  // namespace twilight::audio::miniaudio_backend_detail
