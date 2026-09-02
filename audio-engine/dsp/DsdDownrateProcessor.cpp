#include "DsdDownrateProcessor.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace twilight::audio {
namespace {

bool isPowerOfTwo(int value) {
  return value > 0 && (value & (value - 1)) == 0;
}

bool isSupportedDsdSampleRate(int sampleRate) {
  for (const int baseRate : {44100, 48000}) {
    for (const int multiplier : {64, 128, 256, 512}) {
      if (sampleRate == baseRate * multiplier) return true;
    }
  }
  return false;
}

uint8_t bitAt(uint8_t byte, int index, DsdBitOrder order) {
  const int shift = order == DsdBitOrder::MsbFirst ? 7 - index : index;
  return static_cast<uint8_t>((byte >> shift) & 1U);
}

void appendBit(uint8_t bit, DsdBitOrder order, uint8_t* byte, int* count) {
  if (order == DsdBitOrder::MsbFirst) {
    *byte = static_cast<uint8_t>((*byte << 1) | bit);
  } else {
    *byte = static_cast<uint8_t>(*byte | (bit << *count));
  }
  ++*count;
}

}  // namespace

bool DsdDownrateProcessor::configure(const DsdDownrateConfig& config, std::string* error) {
  configured_ = false;
  if (config.channelCount <= 0 || config.channelCount > kMaxChannels) {
    if (error) *error = "DSD downrate supports 1 to 8 channels";
    return false;
  }
  if (!isSupportedDsdSampleRate(config.sourceSampleRate) ||
      !isSupportedDsdSampleRate(config.targetSampleRate)) {
    if (error) *error = "DSD downrate requires DSD64 through DSD512 in a 44.1 or 48 kHz family";
    return false;
  }
  if (config.sourceSampleRate <= config.targetSampleRate ||
      config.sourceSampleRate % config.targetSampleRate != 0) {
    if (error) *error = "DSD downrate target must be lower than the source rate";
    return false;
  }
  const int ratio = config.sourceSampleRate / config.targetSampleRate;
  if (!isPowerOfTwo(ratio) || ratio > 8) {
    if (error) *error = "DSD downrate ratio must be x2, x4 or x8";
    return false;
  }

  const double cutoff = 0.45 / static_cast<double>(ratio);
  double sum = 0.0;
  const int midpoint = static_cast<int>(kFirTapCount / 2);
  for (size_t index = 0; index < kFirTapCount; ++index) {
    const int offset = static_cast<int>(index) - midpoint;
    const double sinc = offset == 0
                            ? 2.0 * cutoff
                            : std::sin(2.0 * std::numbers::pi * cutoff * offset) /
                                  (std::numbers::pi * offset);
    const double window =
        0.54 - 0.46 * std::cos(2.0 * std::numbers::pi * index / (kFirTapCount - 1));
    taps_[index] = sinc * window;
    sum += taps_[index];
  }
  for (double& tap : taps_) tap /= sum;

  config_ = config;
  ratio_ = ratio;
  channels_.assign(static_cast<size_t>(config.channelCount), ChannelState{});
  configured_ = true;
  return true;
}

void DsdDownrateProcessor::reset() {
  for (ChannelState& state : channels_) state = ChannelState{};
}

size_t DsdDownrateProcessor::maximumOutputByteFrames(size_t inputByteFrames) const {
  if (!configured_) return 0;
  return (inputByteFrames + static_cast<size_t>(ratio_) - 1) / static_cast<size_t>(ratio_);
}

size_t DsdDownrateProcessor::process(
    const uint8_t* interleavedInput,
    size_t inputByteFrames,
    uint8_t* interleavedOutput,
    size_t outputByteFrameCapacity) {
  if (!configured_ || !interleavedInput || !interleavedOutput || inputByteFrames == 0) return 0;
  const size_t channelCount = static_cast<size_t>(config_.channelCount);
  size_t writtenFrames = 0;

  for (size_t inputFrame = 0; inputFrame < inputByteFrames; ++inputFrame) {
    for (int bitIndex = 0; bitIndex < 8; ++bitIndex) {
      bool outputBitReady = false;
      bool outputByteReady = false;
      for (size_t channel = 0; channel < channelCount; ++channel) {
        ChannelState& state = channels_[channel];
        const uint8_t sourceByte = interleavedInput[inputFrame * channelCount + channel];
        const double sample = bitAt(sourceByte, bitIndex, config_.inputBitOrder) ? 1.0 : -1.0;
        state.history[state.historyIndex] = sample;
        state.historyIndex = (state.historyIndex + 1) % kFirTapCount;
        ++state.decimationPhase;
        if (state.decimationPhase != ratio_) continue;
        state.decimationPhase = 0;

        double filtered = 0.0;
        size_t historyIndex = state.historyIndex;
        for (size_t tap = 0; tap < kFirTapCount; ++tap) {
          historyIndex = historyIndex == 0 ? kFirTapCount - 1 : historyIndex - 1;
          filtered += taps_[tap] * state.history[historyIndex];
        }
        const double shaped = std::clamp(filtered + state.quantizationError, -2.0, 2.0);
        const double quantized = shaped >= 0.0 ? 1.0 : -1.0;
        state.quantizationError = std::clamp(shaped - quantized, -1.5, 1.5);
        appendBit(
            quantized > 0.0 ? 1U : 0U,
            config_.outputBitOrder,
            &state.pendingByte,
            &state.pendingBits);
        outputBitReady = true;
        if (state.pendingBits == 8) outputByteReady = true;
      }
      if (!outputBitReady || !outputByteReady) continue;
      if (writtenFrames >= outputByteFrameCapacity) return writtenFrames;
      for (size_t channel = 0; channel < channelCount; ++channel) {
        ChannelState& state = channels_[channel];
        interleavedOutput[writtenFrames * channelCount + channel] = state.pendingByte;
        state.pendingByte = 0;
        state.pendingBits = 0;
      }
      ++writtenFrames;
    }
  }
  return writtenFrames;
}

}  // namespace twilight::audio
