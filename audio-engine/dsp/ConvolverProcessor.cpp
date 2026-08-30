#include "ConvolverProcessor.h"

#include "ConvolverProcessorUtils.h"
#include "KissFftAdapter.h"
#include "../core/Utf8Path.h"

#if defined(TAE_HAS_FFMPEG)
#include "../decoder/FFmpegDecoder.h"
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>

namespace twilight::audio {
namespace {

constexpr uint16_t kWavePcm = 0x0001;
constexpr uint16_t kWaveFloat = 0x0003;
constexpr uint16_t kWaveExtensible = 0xfffe;
constexpr std::array<unsigned char, 16> kWaveSubFormatPcm = {
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
constexpr std::array<unsigned char, 16> kWaveSubFormatFloat = {
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
constexpr uint64_t kConvolverRealtimeBypassOverrunThreshold = 3;
constexpr const char* kConvolverRealtimeBypassReason = "convolver process exceeded realtime budget";
// First re-arm waits 500 ms, then 1 s, 2 s, ... Anything that keeps missing its budget this
// many times stays bypassed until the user changes the configuration.
constexpr std::chrono::milliseconds kConvolverRearmBaseCooldown{500};
constexpr uint32_t kConvolverMaxBypassGenerations = 5;
constexpr uint64_t kMaxImpulseFrames = 16ULL * 1024ULL * 1024ULL;
constexpr uint64_t kMaxImpulseSamples = kMaxImpulseFrames * 8ULL;

uint16_t readU16(const std::array<unsigned char, 2>& bytes) {
  return static_cast<uint16_t>(bytes[0] | (bytes[1] << 8));
}

uint32_t readU32(const std::array<unsigned char, 4>& bytes) {
  return static_cast<uint32_t>(bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24));
}

bool bytesEqual(const unsigned char* data, const std::array<unsigned char, 16>& expected) {
  return std::equal(expected.begin(), expected.end(), data);
}

float pcmToFloat(const unsigned char* data, uint16_t bitsPerSample, uint16_t formatTag) {
  if (formatTag == kWaveFloat && bitsPerSample == 32) {
    float value = 0.0f;
    std::memcpy(&value, data, sizeof(float));
    return std::isfinite(value) ? std::clamp(value, -8.0f, 8.0f) : 0.0f;
  }
  if (bitsPerSample == 16) {
    int16_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return static_cast<float>(value) / 32768.0f;
  }
  if (bitsPerSample == 24) {
    int32_t value = static_cast<int32_t>(data[0] | (data[1] << 8) | (data[2] << 16));
    if ((value & 0x00800000) != 0) value |= static_cast<int32_t>(0xff000000);
    return static_cast<float>(value) / 8388608.0f;
  }
  if (bitsPerSample == 32) {
    int32_t value = 0;
    std::memcpy(&value, data, sizeof(value));
    return static_cast<float>(static_cast<double>(value) / 2147483648.0);
  }
  return 0.0f;
}

std::string mappingModeFor(int irChannels, int outputChannels) {
  if (irChannels == 1) return "mono-to-all";
  if (irChannels == 2 && outputChannels == 2) return "stereo";
  if (irChannels == 2) return outputChannels == 1 ? "stereo-left" : "stereo-repeat";
  return "front-left-right";
}

bool hasRoutingMatrix(const DspConfig& config, int channels) {
  return channels > 0 && config.convolverMatrix.size() == static_cast<size_t>(channels * channels);
}

bool hasMonoToManyMatrix(const DspConfig& config, int channels) {
  return channels > 0 && config.convolverMatrix.size() == static_cast<size_t>(channels);
}

}  // namespace

struct ConvolverProcessor::FftChannel {
  using Complex = KissFftAdapter::Complex;

  uint32_t partitionSize = 0;
  size_t fftSize = 0;
  size_t currentIndex = 0;
  std::vector<std::vector<Complex>> impulsePartitions;
  std::vector<std::vector<Complex>> inputHistory;
  std::vector<float> inputBlock;
  std::vector<float> outputBlock;
  std::vector<float> overlap;
  std::vector<float> paddedScratch;
  std::vector<Complex> spectrumScratch;
  size_t inputPos = 0;

  void configure(const std::vector<float>& impulse, uint32_t requestedPartitionSize) {
    partitionSize = std::max<uint32_t>(1, requestedPartitionSize);
    fftSize = static_cast<size_t>(partitionSize) * 2;
    const size_t partitionCount =
        std::max<size_t>(1, (impulse.size() + static_cast<size_t>(partitionSize) - 1) / partitionSize);

    impulsePartitions.assign(partitionCount, std::vector<Complex>(fftSize));
    inputHistory.assign(partitionCount, std::vector<Complex>(fftSize));
    paddedScratch.assign(fftSize, 0.0f);
    spectrumScratch.assign(fftSize, Complex{});
    for (size_t partition = 0; partition < partitionCount; ++partition) {
      const size_t offset = partition * static_cast<size_t>(partitionSize);
      convolver::writeImpulsePartitionToPaddedScratch(impulse, offset, paddedScratch, partitionSize, fftSize);
      KissFftAdapter::forward(paddedScratch, &impulsePartitions[partition]);
    }

    inputBlock.assign(partitionSize, 0.0f);
    outputBlock.assign(partitionSize, 0.0f);
    overlap.assign(partitionSize, 0.0f);
    inputPos = 0;
    currentIndex = 0;
  }

  void reset() {
    for (auto& block : inputHistory) std::fill(block.begin(), block.end(), Complex{});
    std::fill(inputBlock.begin(), inputBlock.end(), 0.0f);
    std::fill(outputBlock.begin(), outputBlock.end(), 0.0f);
    std::fill(overlap.begin(), overlap.end(), 0.0f);
    inputPos = 0;
    currentIndex = 0;
  }

  uint64_t memoryBytes() const {
    uint64_t total = sizeof(*this);
    total += static_cast<uint64_t>(inputBlock.capacity() + outputBlock.capacity() + overlap.capacity() + paddedScratch.capacity()) *
             sizeof(float);
    total += static_cast<uint64_t>(spectrumScratch.capacity()) * sizeof(Complex);
    for (const auto& partition : impulsePartitions) total += static_cast<uint64_t>(partition.capacity()) * sizeof(Complex);
    for (const auto& history : inputHistory) total += static_cast<uint64_t>(history.capacity()) * sizeof(Complex);
    return total;
  }

  float process(float input) {
    if (partitionSize == 0 || impulsePartitions.empty()) return input;
    const float output = outputBlock[inputPos];
    inputBlock[inputPos] = input;
    ++inputPos;
    if (inputPos >= partitionSize) {
      computeNextBlock();
      inputPos = 0;
    }
    return std::isfinite(output) ? output : 0.0f;
  }

  void computeNextBlock() {
    const size_t partitionCount = impulsePartitions.size();
    currentIndex = (currentIndex + partitionCount - 1) % partitionCount;

    convolver::writeInputBlockToPaddedScratch(inputBlock, paddedScratch, partitionSize, fftSize);
    KissFftAdapter::forward(paddedScratch, &inputHistory[currentIndex]);

    convolver::writePartitionedSpectrumProduct(
        inputHistory,
        impulsePartitions,
        currentIndex,
        fftSize,
        spectrumScratch);

    KissFftAdapter::inverse(&spectrumScratch);
    for (size_t i = 0; i < partitionSize; ++i) {
      outputBlock[i] = static_cast<float>(std::clamp(
          static_cast<double>(spectrumScratch[i].real()) + static_cast<double>(overlap[i]), -8.0, 8.0));
      overlap[i] = spectrumScratch[i + partitionSize].real();
    }
  }
};

ConvolverProcessor::ConvolverProcessor() = default;

ConvolverProcessor::~ConvolverProcessor() = default;

void ConvolverProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuild();
}

void ConvolverProcessor::prepare(const AudioFormat& format) {
  const bool formatChanged = format.sampleRate != format_.sampleRate || format.channelCount != format_.channelCount;
  format_ = format;
  if (formatChanged) reset();
  rebuild();
}

void ConvolverProcessor::setTrackContext(const DspTrackContext&) {
}

void ConvolverProcessor::process(float* samples, size_t frameCount) {
  if (!samples || frameCount == 0) return;
  // A realtime bypass is a temporary retreat, not a permanent one: give it another go once
  // the backoff elapses so a single scheduling hiccup does not mute convolution for the
  // rest of this graph generation.
  if (!active_ && !shouldRearmAfterBypass()) return;
  const auto started = std::chrono::steady_clock::now();
  const int channels = std::clamp(format_.channelCount, 1, 8);
  const bool routed = hasRoutingMatrix(config_, channels);
  const bool monoToMany = hasMonoToManyMatrix(config_, channels);
  for (size_t frame = 0; frame < frameCount; ++frame) {
    float* current = samples + frame * static_cast<size_t>(channels);
    for (int output = 0; output < channels; ++output) {
      double input = 0.0;
      if (routed) {
        for (int inputChannel = 0; inputChannel < channels; ++inputChannel) {
          input += config_.convolverMatrix[static_cast<size_t>(output * channels + inputChannel)] * current[inputChannel];
        }
      } else if (monoToMany) {
        input = config_.convolverMatrix[static_cast<size_t>(output)] * current[0];
      } else {
        input = current[output];
      }
      routedInput_[static_cast<size_t>(output)] = static_cast<float>(std::clamp(input, -8.0, 8.0));
    }
    for (int output = 0; output < channels; ++output) {
      wetOutput_[static_cast<size_t>(output)] = channels_[static_cast<size_t>(output)]->process(
          routedInput_[static_cast<size_t>(output)]);
    }
    const size_t delayRingFrames = wetDelayFrames_ + 1;
    for (int channel = 0; channel < channels; ++channel) {
      const size_t channelIndex = static_cast<size_t>(channel);
      float wet = wetOutput_[channelIndex];
      if (!wetDelayBuffer_.empty()) {
        wetDelayBuffer_[wetDelayWriteFrame_ * static_cast<size_t>(channels) + channelIndex] = wet;
        const size_t readFrame =
            (wetDelayWriteFrame_ + delayRingFrames - wetDelayFrames_) % delayRingFrames;
        wet = wetDelayBuffer_[readFrame * static_cast<size_t>(channels) + channelIndex];
      }
      current[channel] = static_cast<float>(std::clamp(
          static_cast<double>(current[channel]) * config_.convolverDry +
              static_cast<double>(wet) * config_.convolverWet * wetGain_,
          -8.0,
          8.0));
    }
    wetDelayWriteFrame_ = (wetDelayWriteFrame_ + 1) % delayRingFrames;
  }
  const auto elapsed = std::chrono::steady_clock::now() - started;
  const double elapsedMs = std::chrono::duration<double, std::milli>(elapsed).count();
  const double blockMs =
      format_.sampleRate > 0 ? static_cast<double>(frameCount) * 1000.0 / static_cast<double>(format_.sampleRate) : 0.0;
  const double budgetMs = std::max(2.0, blockMs * 0.5);
  info_.lastProcessMs = elapsedMs;
  info_.maxProcessMs = std::max(info_.maxProcessMs, elapsedMs);
  if (realtimeState_) {
    realtimeState_->lastProcessMs.store(elapsedMs, std::memory_order_relaxed);
    double previousMax = realtimeState_->maxProcessMs.load(std::memory_order_relaxed);
    while (elapsedMs > previousMax &&
           !realtimeState_->maxProcessMs.compare_exchange_weak(
               previousMax, elapsedMs, std::memory_order_relaxed, std::memory_order_relaxed)) {
    }
  }
  if (elapsedMs > budgetMs) {
    info_.overrunCount += 1;
    if (realtimeState_) realtimeState_->overrunCount.fetch_add(1, std::memory_order_relaxed);
    consecutiveOverruns_ += 1;
    if (consecutiveOverruns_ >= kConvolverRealtimeBypassOverrunThreshold) {
      bypassRealtime();
    }
    return;
  }
  consecutiveOverruns_ = 0;
}

void ConvolverProcessor::reset() {
  for (auto& channel : channels_) {
    if (channel) channel->reset();
  }
  std::fill(wetDelayBuffer_.begin(), wetDelayBuffer_.end(), 0.0f);
  wetDelayWriteFrame_ = 0;
  consecutiveOverruns_ = 0;
}

bool ConvolverProcessor::isActive() const {
  return active_;
}

bool ConvolverProcessor::loadImpulseResponse(const std::string& path, std::string* error) {
  IrData ir;
  if (!readImpulse(path, &ir, error)) {
    info_.lastError = error && !error->empty() ? *error : "无法读取脉冲响应文件";
    return false;
  }

  originalIr_ = std::move(ir);
  irCache_.clear();
  info_ = {};
  consecutiveOverruns_ = 0;
  info_.loaded = true;
  info_.path = path;
  info_.sampleRate = originalIr_->sampleRate;
  info_.channels = originalIr_->channels;
  info_.lengthFrames = originalIr_->frames;
  info_.lengthMs =
      originalIr_->sampleRate > 0
          ? static_cast<double>(originalIr_->frames) * 1000.0 / static_cast<double>(originalIr_->sampleRate)
          : 0.0;
  config_.impulseResponsePath = path;
  config_.convolverEnabled = true;
  rebuild();
  return true;
}

void ConvolverProcessor::unloadImpulseResponse() {
  originalIr_.reset();
  irCache_.clear();
  channels_.clear();
  routedInput_.fill(0.0f);
  wetOutput_.fill(0.0f);
  wetDelayBuffer_.clear();
  wetDelayFrames_ = 0;
  wetDelayWriteFrame_ = 0;
  wetGain_ = 1.0;
  active_ = false;
  info_ = {};
  consecutiveOverruns_ = 0;
  realtimeBypassed_ = false;
  bypassGeneration_ = 0;
  if (realtimeState_) {
    realtimeState_->bypassed.store(false, std::memory_order_release);
    realtimeState_->overrunCount.store(0, std::memory_order_relaxed);
    realtimeState_->bypassCount.store(0, std::memory_order_relaxed);
    realtimeState_->lastProcessMs.store(0.0, std::memory_order_relaxed);
    realtimeState_->maxProcessMs.store(0.0, std::memory_order_relaxed);
  }
  config_.convolverEnabled = false;
  config_.impulseResponsePath.clear();
}

ConvolverInfo ConvolverProcessor::info() const {
  ConvolverInfo copy = info_;
  copy.active = active_;
  if (!realtimeState_) return copy;

  // Fold in what the render clone reported. This instance is not the one that runs on the
  // audio thread, so without the shared state a realtime bypass would never show up here.
  const uint64_t realtimeOverruns = realtimeState_->overrunCount.load(std::memory_order_relaxed);
  copy.overrunCount = std::max(copy.overrunCount, realtimeOverruns);
  copy.bypassCount = realtimeState_->bypassCount.load(std::memory_order_relaxed);
  const double realtimeLast = realtimeState_->lastProcessMs.load(std::memory_order_relaxed);
  if (realtimeLast > 0.0) copy.lastProcessMs = realtimeLast;
  copy.maxProcessMs =
      std::max(copy.maxProcessMs, realtimeState_->maxProcessMs.load(std::memory_order_relaxed));
  if (realtimeState_->bypassed.load(std::memory_order_acquire)) {
    copy.bypassed = true;
    copy.active = false;
    if (copy.lastError.empty()) copy.lastError = kConvolverRealtimeBypassReason;
  }
  return copy;
}

bool ConvolverProcessor::readImpulse(const std::string& path, IrData* out, std::string* error) {
  std::string waveError;
  if (readWaveImpulse(path, out, &waveError)) return true;

#if defined(TAE_HAS_FFMPEG)
  std::string decoderError;
  if (readFfmpegImpulse(path, out, &decoderError)) return true;
  if (error) {
    *error = decoderError.empty() ? waveError : decoderError;
  }
#else
  if (error) {
    *error = waveError.empty() ? "Only WAV impulse responses are available in this native build" : waveError;
  }
#endif
  return false;
}

bool ConvolverProcessor::readFfmpegImpulse(const std::string& path, IrData* out, std::string* error) {
#if defined(TAE_HAS_FFMPEG)
  if (!out) return false;
  FFmpegDecoder decoder;
  if (!decoder.open(path, error)) return false;

  AudioFormat format = decoder.streamInfo().decodedFormat;
  if (format.sampleRate <= 0 || format.channelCount <= 0 || format.channelCount > 8) {
    if (error) *error = "Impulse response must have between one and eight channels";
    return false;
  }
  format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  format.bitDepth = 32;
  if (!decoder.setOutputFormat(format, error)) return false;

  constexpr size_t kDecodeBlockFrames = 4096;
  const size_t channels = static_cast<size_t>(format.channelCount);
  std::vector<float> scratch(kDecodeBlockFrames * channels, 0.0f);
  std::vector<float> interleaved;
  while (!decoder.eof()) {
    std::string decodeError;
    const size_t frames = decoder.readFrames(scratch.data(), kDecodeBlockFrames, &decodeError);
    if (frames == 0) {
      if (!decodeError.empty() && error) *error = decodeError;
      break;
    }
    const uint64_t nextSamples = static_cast<uint64_t>(interleaved.size()) + frames * channels;
    if (nextSamples > kMaxImpulseSamples) {
      if (error) *error = "Impulse response exceeds the managed runtime size limit";
      return false;
    }
    interleaved.insert(interleaved.end(), scratch.begin(), scratch.begin() + static_cast<std::ptrdiff_t>(frames * channels));
  }
  if (interleaved.empty() || interleaved.size() % channels != 0) {
    if (error && error->empty()) *error = "Impulse response contains no decoded audio";
    return false;
  }

  const uint64_t frames = static_cast<uint64_t>(interleaved.size() / channels);
  if (frames > kMaxImpulseFrames) {
    if (error) *error = "Impulse response exceeds the managed runtime frame limit";
    return false;
  }
  IrData ir;
  ir.sampleRate = format.sampleRate;
  ir.channels = format.channelCount;
  ir.frames = frames;
  ir.samples.assign(channels, std::vector<float>(static_cast<size_t>(frames), 0.0f));
  for (size_t frame = 0; frame < static_cast<size_t>(frames); ++frame) {
    for (size_t channel = 0; channel < channels; ++channel) {
      ir.samples[channel][frame] = std::clamp(interleaved[frame * channels + channel], -8.0f, 8.0f);
    }
  }
  *out = std::move(ir);
  return true;
#else
  (void)path;
  (void)out;
  if (error) *error = "FFmpeg impulse-response decoding is not enabled in this native build";
  return false;
#endif
}

bool ConvolverProcessor::readWaveImpulse(const std::string& path, IrData* out, std::string* error) {
  if (!out) return false;
  std::ifstream file(utf8Path(path), std::ios::binary);
  if (!file) {
    if (error) *error = "无法打开脉冲响应文件";
    return false;
  }

  char riff[4] = {};
  std::array<unsigned char, 4> chunkSize{};
  char wave[4] = {};
  file.read(riff, 4);
  file.read(reinterpret_cast<char*>(chunkSize.data()), 4);
  file.read(wave, 4);
  if (std::strncmp(riff, "RIFF", 4) != 0 || std::strncmp(wave, "WAVE", 4) != 0) {
    if (error) *error = "脉冲响应文件不是有效的 WAV";
    return false;
  }

  uint16_t formatTag = 0;
  uint16_t channels = 0;
  uint32_t sampleRate = 0;
  uint16_t blockAlign = 0;
  uint16_t bitsPerSample = 0;
  std::vector<unsigned char> audioData;

  while (file) {
    char id[4] = {};
    std::array<unsigned char, 4> sizeBytes{};
    file.read(id, 4);
    file.read(reinterpret_cast<char*>(sizeBytes.data()), 4);
    if (!file) break;
    const uint32_t size = readU32(sizeBytes);

    if (std::strncmp(id, "fmt ", 4) == 0) {
      std::vector<unsigned char> fmt(size);
      file.read(reinterpret_cast<char*>(fmt.data()), static_cast<std::streamsize>(fmt.size()));
      if (fmt.size() < 16) {
        if (error) *error = "WAV 格式块不完整";
        return false;
      }
      formatTag = static_cast<uint16_t>(fmt[0] | (fmt[1] << 8));
      channels = static_cast<uint16_t>(fmt[2] | (fmt[3] << 8));
      sampleRate = static_cast<uint32_t>(fmt[4] | (fmt[5] << 8) | (fmt[6] << 16) | (fmt[7] << 24));
      blockAlign = static_cast<uint16_t>(fmt[12] | (fmt[13] << 8));
      bitsPerSample = static_cast<uint16_t>(fmt[14] | (fmt[15] << 8));
      if (formatTag == kWaveExtensible && fmt.size() >= 40) {
        const uint16_t cbSize = static_cast<uint16_t>(fmt[16] | (fmt[17] << 8));
        const unsigned char* subFormat = fmt.data() + 24;
        if (cbSize >= 22 && bytesEqual(subFormat, kWaveSubFormatPcm)) {
          formatTag = kWavePcm;
        } else if (cbSize >= 22 && bytesEqual(subFormat, kWaveSubFormatFloat)) {
          formatTag = kWaveFloat;
        }
      }
    } else if (std::strncmp(id, "data", 4) == 0) {
      if (size > kMaxImpulseSamples * sizeof(float)) {
        if (error) *error = "Impulse response exceeds the managed runtime size limit";
        return false;
      }
      audioData.resize(size);
      file.read(reinterpret_cast<char*>(audioData.data()), static_cast<std::streamsize>(audioData.size()));
    } else {
      file.seekg(size, std::ios::cur);
    }
    if ((size & 1U) != 0U) file.seekg(1, std::ios::cur);
  }

  if (channels == 0 || channels > 8 || sampleRate == 0 || blockAlign == 0 || audioData.empty()) {
    if (error) *error = "WAV 脉冲响应缺少音频数据";
    return false;
  }
  if (formatTag != kWavePcm && formatTag != kWaveFloat) {
    if (error) *error = "当前仅支持 PCM 或 Float WAV 脉冲响应";
    return false;
  }

  const size_t frameCount = audioData.size() / blockAlign;
  if (frameCount > kMaxImpulseFrames) {
    if (error) *error = "Impulse response exceeds the managed runtime frame limit";
    return false;
  }
  const size_t bytesPerSample = std::max<size_t>(1, bitsPerSample / 8);
  IrData ir;
  ir.sampleRate = static_cast<int>(sampleRate);
  ir.channels = static_cast<int>(channels);
  ir.frames = static_cast<uint64_t>(frameCount);
  ir.samples.assign(channels, std::vector<float>(frameCount, 0.0f));
  for (size_t frame = 0; frame < frameCount; ++frame) {
    const size_t frameOffset = frame * blockAlign;
    for (uint16_t channel = 0; channel < channels; ++channel) {
      const size_t offset = frameOffset + static_cast<size_t>(channel) * bytesPerSample;
      if (offset + bytesPerSample <= audioData.size()) {
        ir.samples[channel][frame] = pcmToFloat(audioData.data() + offset, bitsPerSample, formatTag);
      }
    }
  }

  *out = std::move(ir);
  return true;
}

ConvolverProcessor::IrData ConvolverProcessor::resampleIr(const IrData& source, int targetSampleRate) {
  if (source.sampleRate <= 0 || targetSampleRate <= 0 || source.sampleRate == targetSampleRate) return source;

  IrData out;
  out.sampleRate = targetSampleRate;
  out.channels = source.channels;
  out.frames = static_cast<uint64_t>(
      std::max<double>(1.0, std::round(static_cast<double>(source.frames) * targetSampleRate / source.sampleRate)));
  out.samples.assign(static_cast<size_t>(out.channels), std::vector<float>(static_cast<size_t>(out.frames), 0.0f));

  for (int channel = 0; channel < out.channels; ++channel) {
    const auto& input = source.samples[static_cast<size_t>(channel)];
    auto& output = out.samples[static_cast<size_t>(channel)];
    for (size_t i = 0; i < output.size(); ++i) {
      const double position = static_cast<double>(i) * source.sampleRate / targetSampleRate;
      const size_t left = std::min(input.size() - 1, static_cast<size_t>(std::floor(position)));
      const size_t right = std::min(input.size() - 1, left + 1);
      const double t = position - static_cast<double>(left);
      output[i] = static_cast<float>((1.0 - t) * input[left] + t * input[right]);
    }
  }
  return out;
}

void ConvolverProcessor::rebuild() {
  active_ = false;
  channels_.clear();
  wetDelayBuffer_.clear();
  wetDelayFrames_ = 0;
  wetDelayWriteFrame_ = 0;
  wetGain_ = 1.0;
  if (!config_.enabled || !config_.convolverEnabled || !originalIr_ || format_.sampleRate <= 0 ||
      format_.channelCount <= 0 || format_.channelCount > 8) {
    info_.active = false;
    return;
  }

  std::string error;
  if (!prepareRuntimeIr(&error)) {
    info_.lastError = error;
    info_.active = false;
    return;
  }
  info_.active = active_;
}

void ConvolverProcessor::bypassRealtime() {
  active_ = false;
  realtimeBypassed_ = true;
  info_.active = false;
  info_.bypassed = true;
  // No std::string assignment here: this runs on the audio thread and the old
  // info_.lastError write allocated. info() reconstitutes the reason from the shared flag.
  if (bypassGeneration_ < kConvolverMaxBypassGenerations) ++bypassGeneration_;
  lastBypassAt_ = std::chrono::steady_clock::now();
  if (realtimeState_) {
    realtimeState_->bypassed.store(true, std::memory_order_release);
    realtimeState_->bypassCount.fetch_add(1, std::memory_order_relaxed);
    realtimeState_->lastBypassTicks.store(
        std::chrono::steady_clock::now().time_since_epoch().count(), std::memory_order_relaxed);
  }
}

bool ConvolverProcessor::shouldRearmAfterBypass() {
  if (!realtimeBypassed_) return false;
  if (channels_.empty()) return false;
  if (bypassGeneration_ >= kConvolverMaxBypassGenerations) return false;

  const auto cooldown = kConvolverRearmBaseCooldown * (1u << (bypassGeneration_ - 1));
  const auto elapsed = std::chrono::steady_clock::now() - lastBypassAt_;
  if (elapsed < cooldown) return false;

  // Re-arm. Filter state is stale after the gap, so clear it -- FftChannel::reset() only
  // fills existing buffers and never allocates, so this is realtime-safe.
  for (auto& channel : channels_) {
    if (channel) channel->reset();
  }
  std::fill(wetDelayBuffer_.begin(), wetDelayBuffer_.end(), 0.0f);
  wetDelayWriteFrame_ = 0;
  consecutiveOverruns_ = 0;
  realtimeBypassed_ = false;
  active_ = true;
  info_.active = true;
  info_.bypassed = false;
  if (realtimeState_) realtimeState_->bypassed.store(false, std::memory_order_release);
  return true;
}

void ConvolverProcessor::setRealtimeState(std::shared_ptr<ConvolverRealtimeState> state) {
  if (!state) return;
  realtimeState_ = std::move(state);
}

bool ConvolverProcessor::prepareRuntimeIr(std::string* error) {
  if (!originalIr_) {
    if (error) *error = "尚未加载脉冲响应";
    return false;
  }

  const bool needsResample = originalIr_->sampleRate != format_.sampleRate;
  auto cached = irCache_.find(format_.sampleRate);
  if (cached == irCache_.end()) {
    cached = irCache_.emplace(format_.sampleRate, needsResample ? resampleIr(*originalIr_, format_.sampleRate) : *originalIr_).first;
  }

  const IrData& ir = cached->second;
  if (ir.samples.empty() || ir.frames == 0) {
    if (error) *error = "脉冲响应没有可用采样";
    return false;
  }

  updateInfoFromRuntime(ir, needsResample);
  const int outputChannels = format_.channelCount;
  if (!config_.convolverMatrix.empty() && !hasRoutingMatrix(config_, outputChannels) &&
      !hasMonoToManyMatrix(config_, outputChannels)) {
    if (error) *error = "Convolution routing must be a 1xN or NxN matrix for the active channel layout";
    return false;
  }
  const uint32_t partitionSize = choosePartitionSize(ir);
  channels_.clear();
  channels_.reserve(static_cast<size_t>(format_.channelCount));
  for (int channel = 0; channel < format_.channelCount; ++channel) {
    auto fftChannel = std::make_unique<FftChannel>();
    fftChannel->configure(impulseForOutputChannel(ir, channel), partitionSize);
    channels_.push_back(std::move(fftChannel));
  }
  wetGain_ = std::pow(10.0, std::clamp(config_.convolverGainDb, -60.0, 24.0) / 20.0);
  if (config_.convolverPolarityInverted) wetGain_ = -wetGain_;
  wetDelayFrames_ = static_cast<size_t>(std::round(
      std::clamp(config_.convolverDelayMs, 0.0, 250.0) * static_cast<double>(format_.sampleRate) / 1000.0));
  const size_t delayRingFrames = wetDelayFrames_ + 1;
  wetDelayBuffer_.assign(delayRingFrames * static_cast<size_t>(format_.channelCount), 0.0f);
  wetDelayWriteFrame_ = 0;
  info_.partitionSize = partitionSize;
  info_.latencyFrames = partitionSize + static_cast<uint32_t>(wetDelayFrames_);
  info_.tailFrames = ir.frames + partitionSize + wetDelayFrames_;
  info_.memoryBytes = 0;
  for (const auto& channel : channels_) {
    if (channel) info_.memoryBytes += channel->memoryBytes();
  }
  info_.memoryBytes += static_cast<uint64_t>(wetDelayBuffer_.capacity()) * sizeof(float);
  if (hasRoutingMatrix(config_, outputChannels)) {
    info_.channelMappingMode = "matrix-nxn";
  } else if (hasMonoToManyMatrix(config_, outputChannels)) {
    info_.channelMappingMode = "matrix-1xn";
  }
  active_ = true;
  info_.active = true;
  info_.bypassed = false;
  consecutiveOverruns_ = 0;
  // A fresh runtime IR is a clean slate: drop the accumulated backoff so a reconfigured
  // convolver is not still serving a penalty earned by the previous setup.
  realtimeBypassed_ = false;
  bypassGeneration_ = 0;
  if (realtimeState_) realtimeState_->bypassed.store(false, std::memory_order_release);
  return true;
}

uint32_t ConvolverProcessor::choosePartitionSize(const IrData& ir) const {
  if (config_.convolverPartitionSize > 0) {
    uint32_t partitionSize = 64;
    const uint32_t requested = std::clamp(config_.convolverPartitionSize, 64U, 8192U);
    while (partitionSize < requested && partitionSize < 8192U) partitionSize *= 2;
    return partitionSize;
  }
  if (ir.sampleRate <= 48000 && ir.frames <= static_cast<uint64_t>(ir.sampleRate / 2)) return 1024;
  if (ir.sampleRate >= 176400 || ir.frames >= static_cast<uint64_t>(ir.sampleRate * 2)) return 4096;
  return 2048;
}

std::vector<float> ConvolverProcessor::impulseForOutputChannel(const IrData& ir, int outputChannel) const {
  if (ir.channels <= 1) return ir.samples.empty() ? std::vector<float>{1.0f} : ir.samples[0];
  const size_t sourceChannel = static_cast<size_t>(std::clamp(outputChannel, 0, ir.channels - 1));
  return ir.samples[std::min(sourceChannel, ir.samples.size() - 1)];
}

void ConvolverProcessor::updateInfoFromRuntime(const IrData& ir, bool resampled) {
  info_.loaded = originalIr_.has_value();
  info_.active = active_;
  info_.irResampled = resampled;
  info_.sampleRate = ir.sampleRate;
  info_.channels = ir.channels;
  info_.lengthFrames = ir.frames;
  info_.lengthMs =
      ir.sampleRate > 0 ? static_cast<double>(ir.frames) * 1000.0 / static_cast<double>(ir.sampleRate) : 0.0;
  info_.channelMappingMode = mappingModeFor(ir.channels, format_.channelCount);
  info_.warning.clear();
  info_.lastError.clear();
  info_.bypassed = false;
  if (ir.channels > 2) {
    info_.warning = "多声道脉冲响应已使用前左和前右声道";
  }
}

}  // namespace twilight::audio
