#pragma once

#if !defined(_WIN32) || !defined(_WIN64)
#error "Twilight Echo ASIO ABI is supported only on Windows x64"
#endif

#include <Unknwn.h>

#include <cstdint>

namespace twilight::audio::asio_abi {

using AsioBool = int32_t;
using AsioError = int32_t;
using AsioSampleRate = double;
using AsioSamples = int64_t;
using AsioTimeStamp = int64_t;
using AsioSampleType = int32_t;
using AsioIoFormatType = int32_t;

inline constexpr AsioError kAsioOk = 0;
inline constexpr AsioError kAsioSuccess = static_cast<AsioError>(0x3f4847a0U);
inline constexpr AsioBool kAsioFalse = 0;
inline constexpr AsioBool kAsioTrue = 1;
inline constexpr int32_t kAsioAbiContractVersion = 2;

constexpr bool asioBoolIsTrue(AsioBool value) {
  return value != kAsioFalse;
}

constexpr bool asioErrorIsSuccess(AsioError value) {
  return value == kAsioOk || value == kAsioSuccess;
}

inline constexpr AsioSampleType kAsioSampleInt16Lsb = 16;
inline constexpr AsioSampleType kAsioSampleInt24Lsb = 17;
inline constexpr AsioSampleType kAsioSampleInt32Lsb = 18;
inline constexpr AsioSampleType kAsioSampleFloat32Lsb = 19;
inline constexpr AsioSampleType kAsioSampleInt32Lsb24 = 27;
inline constexpr AsioSampleType kAsioSampleDsdInt8Lsb1 = 32;
inline constexpr AsioSampleType kAsioSampleDsdInt8Msb1 = 33;
inline constexpr AsioSampleType kAsioSampleDsdInt8Ner8 = 40;

// The SDK's contract for kAsioCanDoIoFormat / kAsioSetIoFormat: the caller fills
// in the requested type, and a driver that cannot honor it rewrites that field
// to Invalid. Return codes vary between drivers, so the rewritten field is the
// only unambiguous refusal.
inline constexpr AsioIoFormatType kAsioIoFormatInvalid = -1;
inline constexpr AsioIoFormatType kAsioIoFormatPcm = 0;
inline constexpr AsioIoFormatType kAsioIoFormatDsd = 1;

inline constexpr int32_t kSelectorSupported = 1;
inline constexpr int32_t kSelectorEngineVersion = 2;
inline constexpr int32_t kSelectorResetRequest = 3;
inline constexpr int32_t kSelectorBufferSizeChange = 4;
inline constexpr int32_t kSelectorResyncRequest = 5;
inline constexpr int32_t kSelectorLatenciesChanged = 6;
inline constexpr int32_t kSelectorSupportsTimeInfo = 7;
inline constexpr int32_t kSelectorSupportsTimeCode = 8;
inline constexpr int32_t kSelectorOverload = 9;

inline constexpr int32_t kFutureSetIoFormat = 0x23111961;
inline constexpr int32_t kFutureGetIoFormat = 0x23111983;
inline constexpr int32_t kFutureCanDoIoFormat = 0x23112004;

struct AsioBufferInfo {
  AsioBool isInput;
  int32_t channelNum;
  void* buffers[2];
};

struct AsioClockSource {
  int32_t index;
  int32_t associatedChannel;
  int32_t associatedGroup;
  AsioBool isCurrentSource;
  char name[32];
};

struct AsioChannelInfo {
  int32_t channel;
  AsioBool isInput;
  AsioBool isActive;
  int32_t channelGroup;
  AsioSampleType type;
  char name[32];
};

struct AsioIoFormat {
  AsioIoFormatType formatType;
  uint8_t reserved[508];
};

struct AsioTimeInfo {
  double speed;
  AsioSamples samplePosition;
  AsioTimeStamp systemTime;
  uint32_t flags;
  char reserved[12];
};

struct AsioTimeCode {
  double speed;
  AsioSamples timeCodeSamples;
  uint32_t flags;
  char future[64];
};

struct AsioTime {
  int32_t reserved[4];
  AsioTimeInfo timeInfo;
  AsioTimeCode timeCode;
};

using AsioBufferSwitch = void (*)(int32_t bufferIndex, AsioBool processNow);
using AsioSampleRateDidChange = void (*)(AsioSampleRate sampleRate);
using AsioMessage = int32_t (*)(int32_t selector, int32_t value, void* message, double* option);
using AsioBufferSwitchTimeInfo = AsioTime* (*)(AsioTime* parameters, int32_t bufferIndex, AsioBool processNow);

struct AsioCallbacks {
  AsioBufferSwitch bufferSwitch;
  AsioSampleRateDidChange sampleRateDidChange;
  AsioMessage asioMessage;
  AsioBufferSwitchTimeInfo bufferSwitchTimeInfo;
};

class AsioDriver : public IUnknown {
 public:
  virtual AsioBool init(void* systemReference) = 0;
  virtual void getDriverName(char* name) = 0;
  virtual int32_t getDriverVersion() = 0;
  virtual void getErrorMessage(char* message) = 0;
  virtual AsioError start() = 0;
  virtual AsioError stop() = 0;
  virtual AsioError getChannels(int32_t* inputChannels, int32_t* outputChannels) = 0;
  virtual AsioError getLatencies(int32_t* inputLatency, int32_t* outputLatency) = 0;
  virtual AsioError getBufferSize(
      int32_t* minimum,
      int32_t* maximum,
      int32_t* preferred,
      int32_t* granularity) = 0;
  virtual AsioError canSampleRate(AsioSampleRate sampleRate) = 0;
  virtual AsioError getSampleRate(AsioSampleRate* sampleRate) = 0;
  virtual AsioError setSampleRate(AsioSampleRate sampleRate) = 0;
  virtual AsioError getClockSources(AsioClockSource* clocks, int32_t* count) = 0;
  virtual AsioError setClockSource(int32_t reference) = 0;
  virtual AsioError getSamplePosition(AsioSamples* samplePosition, AsioTimeStamp* systemTime) = 0;
  virtual AsioError getChannelInfo(AsioChannelInfo* channelInfo) = 0;
  virtual AsioError createBuffers(
      AsioBufferInfo* bufferInfos,
      int32_t count,
      int32_t bufferSize,
      AsioCallbacks* callbacks) = 0;
  virtual AsioError disposeBuffers() = 0;
  virtual AsioError controlPanel() = 0;
  virtual AsioError future(int32_t selector, void* option) = 0;
  virtual AsioError outputReady() = 0;
};

}  // namespace twilight::audio::asio_abi
