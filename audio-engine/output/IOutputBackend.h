#pragma once

#include "../core/AudioTypes.h"

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace twilight::audio {

using RenderCallback = std::function<size_t(float* interleaved, size_t frameCount)>;
using TypedRenderCallback = std::function<size_t(PcmBlock& block)>;

enum class OutputBackendEvent {
  DeviceInvalidated,
  RenderError
};

using OutputEventCallback = std::function<void(OutputBackendEvent event, const std::string& message)>;

enum class DopRuntimeFactState {
  Unsupported,
  Candidate,
  Unproven,
  Mismatch,
  Proven
};

struct DopRuntimeFacts {
  DopRuntimeFactState state = DopRuntimeFactState::Unsupported;
  AudioFormat candidateFormat;
  AudioFormat actualFormat;
  bool explicitlyCapable = false;
  std::string reason;
};

enum class NativeDsdRuntimeFactState {
  Unsupported,
  Candidate,
  Unproven,
  Mismatch,
  Proven
};

struct NativeDsdRuntimeFacts {
  NativeDsdRuntimeFactState state = NativeDsdRuntimeFactState::Unsupported;
  int requestedDsdRate = 0;
  int actualDsdRate = 0;
  int channelCount = 0;
  bool explicitlyCapable = false;
  std::vector<int> advertisedSampleRates;
  std::string reason;
};

inline NativeDsdRuntimeFacts unsupportedNativeDsdRuntimeFacts(const std::string& reason) {
  NativeDsdRuntimeFacts facts;
  facts.reason = reason;
  return facts;
}

inline bool hasConcreteAudioFormat(const AudioFormat& format) {
  return format.sampleRate > 0 && format.channelCount > 0 && effectivePcmBitDepth(format) > 0;
}

inline bool isDopCarrierSampleFormat(AudioSampleFormat format) {
  return format == AudioSampleFormat::Int24Interleaved || format == AudioSampleFormat::Int24In32Interleaved;
}

inline bool isDopCarrierFormat(const AudioFormat& format) {
  return format.sampleRate > 0 && format.channelCount > 0 &&
         (format.sampleRate == 176400 || format.sampleRate == 192000 || format.sampleRate == 352800 ||
          format.sampleRate == 384000 || format.sampleRate == 705600 || format.sampleRate == 768000 ||
          format.sampleRate == 1411200 || format.sampleRate == 1536000) &&
         effectivePcmBitDepth(format) == 24 && isDopCarrierSampleFormat(format.sampleFormat);
}

class IOutputBackend {
 public:
  virtual ~IOutputBackend() = default;

  virtual const char* id() const = 0;
  virtual bool open(const std::string& deviceId, const AudioFormat& requestedFormat, std::string* error) = 0;
  virtual bool setOutputConfig(const OutputConfig& config, std::string* error) = 0;
  virtual bool start(RenderCallback callback, OutputEventCallback eventCallback, std::string* error) = 0;
  virtual bool startTyped(
      TypedRenderCallback callback,
      RenderCallback fallbackCallback,
      OutputEventCallback eventCallback,
      std::string* error) {
    (void)callback;
    return start(std::move(fallbackCallback), std::move(eventCallback), error);
  }
  virtual void stop() = 0;
  virtual void close() = 0;

  virtual AudioFormat outputFormat() const = 0;
  virtual OutputInfo outputInfo() const = 0;
  virtual DopRuntimeFacts dopRuntimeFacts() const = 0;
  virtual NativeDsdRuntimeFacts nativeDsdRuntimeFacts() const = 0;
  virtual std::string deviceName() const = 0;
};

}  // namespace twilight::audio
