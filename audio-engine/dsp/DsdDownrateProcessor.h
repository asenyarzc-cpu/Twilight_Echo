#pragma once

#include "../decoder/DsdReader.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace twilight::audio {

struct DsdDownrateConfig {
  int sourceSampleRate = 0;
  int targetSampleRate = 0;
  int channelCount = 0;
  DsdBitOrder inputBitOrder = DsdBitOrder::MsbFirst;
  DsdBitOrder outputBitOrder = DsdBitOrder::MsbFirst;
};

class DsdDownrateProcessor {
 public:
  static constexpr int kMaxChannels = 8;
  static constexpr size_t kFirTapCount = 63;

  bool configure(const DsdDownrateConfig& config, std::string* error);
  void reset();
  size_t process(
      const uint8_t* interleavedInput,
      size_t inputByteFrames,
      uint8_t* interleavedOutput,
      size_t outputByteFrameCapacity);

  bool configured() const { return configured_; }
  int decimationRatio() const { return ratio_; }
  const DsdDownrateConfig& config() const { return config_; }
  size_t maximumOutputByteFrames(size_t inputByteFrames) const;

 private:
  struct ChannelState {
    std::array<double, kFirTapCount> history{};
    size_t historyIndex = 0;
    int decimationPhase = 0;
    double quantizationError = 0.0;
    uint8_t pendingByte = 0;
    int pendingBits = 0;
  };

  DsdDownrateConfig config_;
  bool configured_ = false;
  int ratio_ = 0;
  std::array<double, kFirTapCount> taps_{};
  std::vector<ChannelState> channels_;
};

}  // namespace twilight::audio
