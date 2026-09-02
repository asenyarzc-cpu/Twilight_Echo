#pragma once

#include "../IAsioHost.h"

#include <Windows.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <type_traits>
#include <vector>

namespace twilight::audio::asio_helper {

constexpr uint32_t kProtocolMagic = 0x48414554u;
constexpr uint32_t kProtocolVersion = 2;
constexpr uint32_t kMaxDevices = 64;
constexpr uint32_t kMaxChannels = 32;
constexpr uint32_t kMaxFrames = 32768;
constexpr uint32_t kMaxBytesPerSample = 4;
constexpr uint32_t kMaxRates = 32;
constexpr uint32_t kMaxFormats = 16;
constexpr uint32_t kMaxBitDepths = 8;
constexpr uint32_t kCallbackRingSize = 64;
constexpr uint32_t kHostEventRingSize = 16;
constexpr uint32_t kMaxIdentityBytes = 512;
constexpr uint32_t kMaxMessageBytes = 512;
constexpr uint32_t kChannelStride = kMaxFrames * kMaxBytesPerSample;
constexpr uint32_t kBufferBytes = kMaxChannels * kChannelStride;

enum class HelperState : int32_t {
  Initializing = 0,
  Ready = 1,
  Failed = 2,
  Stopping = 3,
  Stopped = 4
};

enum class Command : int32_t {
  None = 0,
  EnumerateDevices = 1,
  GetDiagnostics = 2,
  ProbeDevice = 3,
  Open = 4,
  CreateBuffers = 5,
  Start = 6,
  Stop = 7,
  Close = 8,
  Shutdown = 9
};

enum class FailureReason : int32_t {
  None = 0,
  LaunchFailed = 1,
  ProtocolError = 2,
  ControlTimeout = 3,
  ProcessExited = 4,
  CallbackStalled = 5,
  DeviceRejected = 6,
  FormatRestoreFailed = 7,
  CommandFailed = 8
};

struct AudioFormatRecord {
  int32_t sampleRate = 0;
  int32_t channelCount = 0;
  int32_t bitDepth = 0;
  int32_t sampleFormat = static_cast<int32_t>(AudioSampleFormat::Float32Interleaved);
};

struct ChannelFormatRecord {
  int32_t logicalFormat = static_cast<int32_t>(AudioSampleFormat::Float32Interleaved);
  uint8_t containerBits = 32;
  uint8_t validBits = 32;
  uint8_t littleEndian = 1;
  uint8_t validBitsAreMostSignificant = 0;
  uint8_t dsdPacking = static_cast<uint8_t>(AsioDsdPacking::None);
  uint8_t reserved[3]{};
};

struct DeviceRecord {
  char id[kMaxIdentityBytes]{};
  char name[kMaxIdentityBytes]{};
  char driverName[kMaxIdentityBytes]{};
  int32_t driverVersion = 0;
  int32_t outputChannels = 0;
  int32_t supportedSampleRates[kMaxRates]{};
  uint32_t supportedSampleRateCount = 0;
  int32_t bitDepths[kMaxBitDepths]{};
  uint32_t bitDepthCount = 0;
  int32_t sampleFormats[kMaxFormats]{};
  uint32_t sampleFormatCount = 0;
  int32_t dopCarrierSampleRates[kMaxRates]{};
  uint32_t dopCarrierSampleRateCount = 0;
  int32_t dopCarrierSampleFormats[kMaxFormats]{};
  uint32_t dopCarrierSampleFormatCount = 0;
  int32_t nativeDsdSampleRates[kMaxRates]{};
  uint32_t nativeDsdSampleRateCount = 0;
  int32_t nativeDsdSampleFormats[kMaxFormats]{};
  uint32_t nativeDsdSampleFormatCount = 0;
  int32_t defaultSampleRate = 0;
  int32_t defaultBitDepth = 0;
  int32_t defaultSampleFormat = static_cast<int32_t>(AudioSampleFormat::Float32Interleaved);
  int32_t minBufferSize = 0;
  int32_t maxBufferSize = 0;
  int32_t bufferGranularity = 0;
  int32_t preferredBufferSize = 0;
  int32_t outputLatencyFrames = 0;
  uint64_t capabilityVersion = 0;
  uint8_t dopCapable = 0;
  uint8_t nativeDsdCapable = 0;
  uint8_t isDefault = 0;
  uint8_t capabilityProbed = 0;
};

struct DiagnosticsRecord {
  char processArchitecture[32]{};
  int32_t registeredDriverCount32 = 0;
  int32_t registeredDriverCount64 = 0;
  int32_t loadableDriverCount64 = 0;
  uint8_t buildEnabled = 0;
  uint8_t environmentDisabled = 0;
  uint8_t reserved[2]{};
};

struct Request {
  int32_t command = static_cast<int32_t>(Command::None);
  char deviceId[kMaxIdentityBytes]{};
  AudioFormatRecord format;
  int32_t bufferSizeFrames = 0;
  int32_t sampleFormatMappingReported = -1;
  int32_t sampleFormatMappingInterpreted = -1;
  int32_t nativeDsdControlOrder = 0;
  int32_t dsdMinimumBufferFrames = 0;
  int32_t dsdCadenceConfirmCallbacks = 2;
};

struct Response {
  int32_t command = static_cast<int32_t>(Command::None);
  int32_t failureReason = static_cast<int32_t>(FailureReason::None);
  uint8_t ok = 0;
  uint8_t reserved[3]{};
  char message[kMaxMessageBytes]{};
  DiagnosticsRecord diagnostics;
  DeviceRecord devices[kMaxDevices]{};
  uint32_t deviceCount = 0;
  DeviceRecord device;
  AudioFormatRecord actualFormat;
  int32_t bufferSizeFrames = 0;
  int32_t latencyFrames = 0;
  char driverName[kMaxIdentityBytes]{};
  int32_t driverVersion = 0;
  char nativeDsdNegotiation[kMaxMessageBytes]{};
  int32_t openFailureKind = static_cast<int32_t>(AsioOpenFailureKind::None);
  ChannelFormatRecord channelFormats[kMaxChannels]{};
  uint32_t channelCount = 0;
  uint8_t formatRestored = 1;
  uint8_t reserved2[3]{};
};

struct alignas(64) RenderBuffer {
  volatile int32_t generation = 0;
  volatile int32_t consumedGeneration = 0;
  uint32_t committedFrames = 0;
  uint32_t channelBytes[kMaxChannels]{};
  uint8_t data[kBufferBytes]{};
};

struct CallbackRecord {
  int32_t bufferIndex = 0;
  uint32_t sequence = 0;
};

struct HostEventRecord {
  int32_t event = static_cast<int32_t>(AsioHostEvent::BufferFailure);
  uint32_t sequence = 0;
  char message[kMaxMessageBytes]{};
};

struct alignas(64) SharedMemory {
  uint32_t magic = kProtocolMagic;
  uint32_t version = kProtocolVersion;
  uint32_t structureBytes = 0;
  uint32_t reserved = 0;
  volatile int32_t helperState = static_cast<int32_t>(HelperState::Initializing);
  volatile int32_t helperHeartbeat = 0;
  volatile int32_t requestSequence = 0;
  volatile int32_t responseSequence = 0;
  volatile int32_t failureReason = static_cast<int32_t>(FailureReason::None);
  volatile int32_t callbackWriteSequence = 0;
  volatile int32_t callbackReadSequence = 0;
  volatile int32_t callbackHeartbeat = 0;
  volatile int32_t callbackDropCount = 0;
  volatile int32_t renderUnderrunCount = 0;
  volatile int32_t hostEventWriteSequence = 0;
  volatile int32_t hostEventReadSequence = 0;
  char statusMessage[kMaxMessageBytes]{};
  Request request;
  Response response;
  int32_t activeBufferSizeFrames = 0;
  uint32_t activeChannelCount = 0;
  ChannelFormatRecord activeChannelFormats[kMaxChannels]{};
  CallbackRecord callbacks[kCallbackRingSize]{};
  HostEventRecord hostEvents[kHostEventRingSize]{};
  RenderBuffer buffers[2]{};
};

inline LONG readAtomic(const volatile int32_t* value) noexcept {
  return InterlockedCompareExchange(
      reinterpret_cast<volatile LONG*>(const_cast<int32_t*>(value)), 0, 0);
}

inline LONG exchangeAtomic(volatile int32_t* value, LONG next) noexcept {
  return InterlockedExchange(reinterpret_cast<volatile LONG*>(value), next);
}

inline LONG incrementAtomic(volatile int32_t* value) noexcept {
  return InterlockedIncrement(reinterpret_cast<volatile LONG*>(value));
}

inline LONG compareExchangeAtomic(volatile int32_t* value, LONG next, LONG expected) noexcept {
  return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(value), next, expected);
}

inline void copyText(char* target, size_t capacity, const std::string& value) {
  if (!target || capacity == 0) return;
  std::memset(target, 0, capacity);
  const size_t count = std::min(value.size(), capacity - 1);
  if (count > 0) std::memcpy(target, value.data(), count);
}

template <size_t Size>
inline std::string readText(const char (&value)[Size]) {
  return std::string(value, strnlen(value, Size));
}

inline const char* failureReasonCode(FailureReason reason) noexcept {
  switch (reason) {
    case FailureReason::LaunchFailed:
      return "asio_helper_launch_failed";
    case FailureReason::ProtocolError:
      return "asio_helper_protocol_error";
    case FailureReason::ControlTimeout:
      return "asio_helper_control_timeout";
    case FailureReason::ProcessExited:
      return "asio_helper_process_exited";
    case FailureReason::CallbackStalled:
      return "asio_helper_callback_stalled";
    case FailureReason::DeviceRejected:
      return "asio_helper_device_rejected";
    case FailureReason::FormatRestoreFailed:
      return "asio_helper_format_restore_failed";
    case FailureReason::CommandFailed:
      return "asio_helper_command_failed";
    case FailureReason::None:
    default:
      return "";
  }
}

inline std::string failureMessage(FailureReason reason, const std::string& detail) {
  const std::string code = failureReasonCode(reason);
  if (code.empty()) return detail;
  return detail.empty() ? code : code + ": " + detail;
}

inline AudioFormatRecord encodeAudioFormat(const AudioFormat& format) {
  return {
      .sampleRate = format.sampleRate,
      .channelCount = format.channelCount,
      .bitDepth = format.bitDepth,
      .sampleFormat = static_cast<int32_t>(format.sampleFormat)};
}

inline bool validSampleFormat(int32_t value) noexcept {
  return value >= static_cast<int32_t>(AudioSampleFormat::Float32Interleaved) &&
         value <= static_cast<int32_t>(AudioSampleFormat::DsdInt8Ner8);
}

inline AudioFormat decodeAudioFormat(const AudioFormatRecord& record) {
  AudioFormat format;
  format.sampleRate = record.sampleRate;
  format.channelCount = record.channelCount;
  format.bitDepth = record.bitDepth;
  if (validSampleFormat(record.sampleFormat)) {
    format.sampleFormat = static_cast<AudioSampleFormat>(record.sampleFormat);
  }
  return format;
}

inline ChannelFormatRecord encodeChannelFormat(const AsioChannelFormat& format) {
  ChannelFormatRecord record;
  record.logicalFormat = static_cast<int32_t>(format.logicalFormat);
  record.containerBits = format.containerBits;
  record.validBits = format.validBits;
  record.littleEndian = format.littleEndian ? 1 : 0;
  record.validBitsAreMostSignificant = format.validBitsAreMostSignificant ? 1 : 0;
  record.dsdPacking = static_cast<uint8_t>(format.dsdPacking);
  return record;
}

inline AsioChannelFormat decodeChannelFormat(const ChannelFormatRecord& record) {
  AsioChannelFormat format;
  if (validSampleFormat(record.logicalFormat)) {
    format.logicalFormat = static_cast<AudioSampleFormat>(record.logicalFormat);
  }
  format.containerBits = record.containerBits;
  format.validBits = record.validBits;
  format.littleEndian = record.littleEndian != 0;
  format.validBitsAreMostSignificant = record.validBitsAreMostSignificant != 0;
  if (record.dsdPacking <= static_cast<uint8_t>(AsioDsdPacking::Ner8)) {
    format.dsdPacking = static_cast<AsioDsdPacking>(record.dsdPacking);
  }
  return format;
}

template <typename Value, size_t Size>
inline uint32_t copyVector(const std::vector<Value>& source, Value (&target)[Size]) {
  const size_t count = std::min(source.size(), Size);
  for (size_t index = 0; index < count; ++index) target[index] = source[index];
  return static_cast<uint32_t>(count);
}

template <typename Enum, size_t Size>
inline uint32_t copyEnumVector(const std::vector<Enum>& source, int32_t (&target)[Size]) {
  const size_t count = std::min(source.size(), Size);
  for (size_t index = 0; index < count; ++index) {
    target[index] = static_cast<int32_t>(source[index]);
  }
  return static_cast<uint32_t>(count);
}

inline DeviceRecord encodeDevice(const AsioDeviceInfo& device) {
  DeviceRecord record;
  copyText(record.id, sizeof(record.id), device.id);
  copyText(record.name, sizeof(record.name), device.name);
  copyText(record.driverName, sizeof(record.driverName), device.driverName);
  record.driverVersion = static_cast<int32_t>(device.driverVersion);
  record.outputChannels = device.outputChannels;
  record.supportedSampleRateCount =
      copyVector(device.supportedSampleRates, record.supportedSampleRates);
  record.bitDepthCount = copyVector(device.bitDepths, record.bitDepths);
  record.sampleFormatCount = copyEnumVector(device.sampleFormats, record.sampleFormats);
  record.dopCarrierSampleRateCount =
      copyVector(device.dopCarrierSampleRates, record.dopCarrierSampleRates);
  record.dopCarrierSampleFormatCount =
      copyEnumVector(device.dopCarrierSampleFormats, record.dopCarrierSampleFormats);
  record.nativeDsdSampleRateCount =
      copyVector(device.nativeDsdSampleRates, record.nativeDsdSampleRates);
  record.nativeDsdSampleFormatCount =
      copyEnumVector(device.nativeDsdSampleFormats, record.nativeDsdSampleFormats);
  record.defaultSampleRate = device.defaultSampleRate;
  record.defaultBitDepth = device.defaultBitDepth;
  record.defaultSampleFormat = static_cast<int32_t>(device.defaultSampleFormat);
  record.minBufferSize = static_cast<int32_t>(device.minBufferSize);
  record.maxBufferSize = static_cast<int32_t>(device.maxBufferSize);
  record.bufferGranularity = static_cast<int32_t>(device.bufferGranularity);
  record.preferredBufferSize = static_cast<int32_t>(device.preferredBufferSize);
  record.outputLatencyFrames = static_cast<int32_t>(device.outputLatencyFrames);
  record.capabilityVersion = device.capabilityVersion;
  record.dopCapable = device.dopCapable ? 1 : 0;
  record.nativeDsdCapable = device.nativeDsdCapable ? 1 : 0;
  record.isDefault = device.isDefault ? 1 : 0;
  record.capabilityProbed = device.capabilityProbed ? 1 : 0;
  return record;
}

template <size_t Size>
inline std::vector<int> decodeInts(const int32_t (&values)[Size], uint32_t count) {
  const size_t bounded = std::min<size_t>(count, Size);
  return std::vector<int>(values, values + bounded);
}

template <size_t Size>
inline std::vector<AudioSampleFormat> decodeFormats(
    const int32_t (&values)[Size], uint32_t count) {
  std::vector<AudioSampleFormat> formats;
  const size_t bounded = std::min<size_t>(count, Size);
  formats.reserve(bounded);
  for (size_t index = 0; index < bounded; ++index) {
    if (validSampleFormat(values[index])) {
      formats.push_back(static_cast<AudioSampleFormat>(values[index]));
    }
  }
  return formats;
}

inline AsioDeviceInfo decodeDevice(const DeviceRecord& record) {
  AsioDeviceInfo device;
  device.id = readText(record.id);
  device.name = readText(record.name);
  device.driverName = readText(record.driverName);
  device.driverVersion = record.driverVersion;
  device.outputChannels = record.outputChannels;
  device.supportedSampleRates =
      decodeInts(record.supportedSampleRates, record.supportedSampleRateCount);
  device.bitDepths = decodeInts(record.bitDepths, record.bitDepthCount);
  device.sampleFormats = decodeFormats(record.sampleFormats, record.sampleFormatCount);
  device.dopCarrierSampleRates =
      decodeInts(record.dopCarrierSampleRates, record.dopCarrierSampleRateCount);
  device.dopCarrierSampleFormats =
      decodeFormats(record.dopCarrierSampleFormats, record.dopCarrierSampleFormatCount);
  device.nativeDsdSampleRates =
      decodeInts(record.nativeDsdSampleRates, record.nativeDsdSampleRateCount);
  device.nativeDsdSampleFormats =
      decodeFormats(record.nativeDsdSampleFormats, record.nativeDsdSampleFormatCount);
  device.defaultSampleRate = record.defaultSampleRate;
  device.defaultBitDepth = record.defaultBitDepth;
  if (validSampleFormat(record.defaultSampleFormat)) {
    device.defaultSampleFormat = static_cast<AudioSampleFormat>(record.defaultSampleFormat);
  }
  device.minBufferSize = record.minBufferSize;
  device.maxBufferSize = record.maxBufferSize;
  device.bufferGranularity = record.bufferGranularity;
  device.preferredBufferSize = record.preferredBufferSize;
  device.outputLatencyFrames = record.outputLatencyFrames;
  device.capabilityVersion = record.capabilityVersion;
  device.dopCapable = record.dopCapable != 0;
  device.nativeDsdCapable = record.nativeDsdCapable != 0;
  device.isDefault = record.isDefault != 0;
  device.capabilityProbed = record.capabilityProbed != 0;
  return device;
}

inline DiagnosticsRecord encodeDiagnostics(const AsioHostDiagnostics& diagnostics) {
  DiagnosticsRecord record;
  copyText(record.processArchitecture, sizeof(record.processArchitecture), diagnostics.processArchitecture);
  record.buildEnabled = diagnostics.buildEnabled ? 1 : 0;
  record.environmentDisabled = diagnostics.environmentDisabled ? 1 : 0;
  record.registeredDriverCount32 = diagnostics.registeredDriverCount32;
  record.registeredDriverCount64 = diagnostics.registeredDriverCount64;
  record.loadableDriverCount64 = diagnostics.loadableDriverCount64;
  return record;
}

inline AsioHostDiagnostics decodeDiagnostics(const DiagnosticsRecord& record) {
  AsioHostDiagnostics diagnostics;
  diagnostics.processArchitecture = readText(record.processArchitecture);
  diagnostics.buildEnabled = record.buildEnabled != 0;
  diagnostics.environmentDisabled = record.environmentDisabled != 0;
  diagnostics.registeredDriverCount32 = record.registeredDriverCount32;
  diagnostics.registeredDriverCount64 = record.registeredDriverCount64;
  diagnostics.loadableDriverCount64 = record.loadableDriverCount64;
  return diagnostics;
}

inline uint8_t* channelBuffer(SharedMemory* shared, long channel, long bufferIndex) noexcept {
  if (!shared || channel < 0 || channel >= static_cast<long>(kMaxChannels) || bufferIndex < 0 ||
      bufferIndex > 1) {
    return nullptr;
  }
  return shared->buffers[bufferIndex].data + static_cast<size_t>(channel) * kChannelStride;
}

inline const uint8_t* channelBuffer(
    const SharedMemory* shared, long channel, long bufferIndex) noexcept {
  return channelBuffer(const_cast<SharedMemory*>(shared), channel, bufferIndex);
}

static_assert(std::is_standard_layout_v<AudioFormatRecord>);
static_assert(std::is_standard_layout_v<DeviceRecord>);
static_assert(std::is_standard_layout_v<SharedMemory>);
static_assert(sizeof(int32_t) == sizeof(LONG));

}  // namespace twilight::audio::asio_helper
