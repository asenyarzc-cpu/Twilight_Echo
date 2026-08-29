#include "WasapiFormatNegotiator.h"

#if defined(_WIN32) && defined(TAE_ENABLE_WASAPI)
#include "WasapiCommon.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <sstream>
#include <set>
#include <tuple>
#include <utility>

#include <ksmedia.h>
#include <mmreg.h>

namespace twilight::audio {
namespace {

constexpr std::array<int, 12> kSupportedSampleRates = {
    44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000};

constexpr int kDsd64SampleRate = 2822400;
constexpr int kDsd64x48SampleRate = 3072000;
constexpr int kDsd128SampleRate = 5644800;
constexpr int kDsd128x48SampleRate = 6144000;
constexpr int kDsd256SampleRate = 11289600;
constexpr int kDsd256x48SampleRate = 12288000;
constexpr int kDsd512SampleRate = 22579200;
constexpr int kDsd512x48SampleRate = 24576000;
constexpr std::array<int, 8> kDopCarrierSampleRates = {176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000};

const GUID kPcmSubFormat = {
    0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

const GUID kFloatSubFormat = {
    0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

int normalizeBitDepth(int bitDepth) {
  if (bitDepth <= 16) return 16;
  if (bitDepth <= 24) return 24;
  return 32;
}

std::array<int, 3> bitDepthPriority(int sourceBitDepth) {
  switch (normalizeBitDepth(sourceBitDepth)) {
    case 16:
      return {16, 24, 32};
    case 24:
      return {24, 32, 16};
    case 32:
    default:
      return {32, 24, 16};
  }
}

bool isDsdRate(int sampleRate) {
  return sampleRate == kDsd64SampleRate || sampleRate == kDsd64x48SampleRate ||
         sampleRate == kDsd128SampleRate || sampleRate == kDsd128x48SampleRate ||
         sampleRate == kDsd256SampleRate || sampleRate == kDsd256x48SampleRate ||
         sampleRate == kDsd512SampleRate || sampleRate == kDsd512x48SampleRate;
}

bool looksLikeDsdRate(int sampleRate) {
  return sampleRate >= 2500000;
}

bool isDopCarrierRate(int sampleRate) {
  return std::find(kDopCarrierSampleRates.begin(), kDopCarrierSampleRates.end(), sampleRate) !=
         kDopCarrierSampleRates.end();
}

int dopCarrierRateForSource(const AudioFormat& sourceFormat) {
  if (sourceFormat.sampleRate == kDsd64SampleRate) return 176400;
  if (sourceFormat.sampleRate == kDsd64x48SampleRate) return 192000;
  if (sourceFormat.sampleRate == kDsd128SampleRate) return 352800;
  if (sourceFormat.sampleRate == kDsd128x48SampleRate) return 384000;
  if (sourceFormat.sampleRate == kDsd256SampleRate) return 705600;
  if (sourceFormat.sampleRate == kDsd256x48SampleRate) return 768000;
  if (sourceFormat.sampleRate == kDsd512SampleRate) return 1411200;
  if (sourceFormat.sampleRate == kDsd512x48SampleRate) return 1536000;
  if (isDopCarrierFormat(sourceFormat)) return sourceFormat.sampleRate;
  return 0;
}

AudioFormat defaultDopCandidate(const AudioFormat& sourceFormat) {
  if (isDopCarrierFormat(sourceFormat)) return sourceFormat;

  AudioFormat candidate;
  candidate.sampleRate = dopCarrierRateForSource(sourceFormat);
  candidate.channelCount = sourceFormat.channelCount;
  candidate.bitDepth = 24;
  candidate.sampleFormat = AudioSampleFormat::Int24Interleaved;
  return candidate.sampleRate > 0 ? candidate : AudioFormat{};
}

bool wantsDopCarrier(const AudioFormat& sourceFormat) {
  return looksLikeDsdRate(sourceFormat.sampleRate) || isDopCarrierFormat(sourceFormat);
}

int sampleRateFamily(int sampleRate) {
  if (sampleRate > 0 && sampleRate % 44100 == 0) return 44100;
  if (sampleRate > 0 && sampleRate % 48000 == 0) return 48000;
  return 0;
}

std::vector<int> sampleRatePriority(int sourceSampleRate) {
  std::vector<int> result;
  auto append = [&](int sampleRate) {
    if (sampleRate > 0 && std::find(result.begin(), result.end(), sampleRate) == result.end()) {
      result.push_back(sampleRate);
    }
  };

  append(sourceSampleRate);

  const int family = sampleRateFamily(sourceSampleRate);
  if (family != 0) {
    for (int sampleRate : kSupportedSampleRates) {
      if (sampleRateFamily(sampleRate) == family && sampleRate > sourceSampleRate) append(sampleRate);
    }
    for (auto it = kSupportedSampleRates.rbegin(); it != kSupportedSampleRates.rend(); ++it) {
      if (sampleRateFamily(*it) == family && *it < sourceSampleRate) append(*it);
    }
  }

  std::vector<int> remaining(kSupportedSampleRates.begin(), kSupportedSampleRates.end());
  std::sort(remaining.begin(), remaining.end(), [&](int left, int right) {
    const int leftDistance = std::abs(left - sourceSampleRate);
    const int rightDistance = std::abs(right - sourceSampleRate);
    if (leftDistance != rightDistance) return leftDistance < rightDistance;
    return left > right;
  });
  for (int sampleRate : remaining) append(sampleRate);

  return result;
}

std::string formatSummary(const AudioFormat& format) {
  return std::to_string(format.sampleRate) + "Hz " + std::to_string(format.channelCount) + "ch " +
         sampleFormatToString(format.sampleFormat) + " " + std::to_string(format.bitDepth) + "bit";
}

std::string hresultSuffix(HRESULT hr) {
  std::ostringstream stream;
  stream << "0x" << std::hex << std::uppercase << static_cast<unsigned long>(hr);
  return stream.str();
}

void appendReason(std::vector<std::string>* reasons, std::string reason) {
  if (!reasons) return;
  if (std::find(reasons->begin(), reasons->end(), reason) == reasons->end()) {
    reasons->push_back(std::move(reason));
  }
}

struct FormatVariant {
  int bitDepth = 0;
  int containerBits = 0;
  AudioSampleFormat sampleFormat = AudioSampleFormat::Int16Interleaved;
  bool ieeeFloat = false;
};

std::vector<FormatVariant> formatVariants(int bitDepth, AudioSampleFormat preferredFormat) {
  if (bitDepth == 16) {
    return {{16, 16, AudioSampleFormat::Int16Interleaved}};
  }
  if (bitDepth == 24) {
    return {
        {24, 24, AudioSampleFormat::Int24Interleaved},
        {24, 32, AudioSampleFormat::Int24In32Interleaved},
    };
  }
  if (preferredFormat == AudioSampleFormat::Float32Interleaved) {
    return {
        {32, 32, AudioSampleFormat::Float32Interleaved, true},
        {32, 32, AudioSampleFormat::Int32Interleaved, false},
    };
  }
  return {
      {32, 32, AudioSampleFormat::Int32Interleaved, false},
      {32, 32, AudioSampleFormat::Float32Interleaved, true},
  };
}

std::vector<FormatVariant> dopCarrierFormatVariants(AudioSampleFormat preferredFormat) {
  std::vector<FormatVariant> variants;
  auto append = [&](FormatVariant variant) {
    const auto duplicate = std::find_if(variants.begin(), variants.end(), [&](const FormatVariant& existing) {
      return existing.containerBits == variant.containerBits && existing.sampleFormat == variant.sampleFormat;
    });
    if (duplicate == variants.end()) variants.push_back(variant);
  };

  if (preferredFormat == AudioSampleFormat::Int24In32Interleaved) {
    append({24, 32, AudioSampleFormat::Int24In32Interleaved});
    append({24, 24, AudioSampleFormat::Int24Interleaved});
  } else {
    append({24, 24, AudioSampleFormat::Int24Interleaved});
    append({24, 32, AudioSampleFormat::Int24In32Interleaved});
  }
  return variants;
}

std::vector<uint8_t> makeWaveFormatBytes(int sampleRate, int channelCount, const FormatVariant& variant) {
  WAVEFORMATEXTENSIBLE format{};
  format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  format.Format.nChannels = static_cast<WORD>(std::max(1, channelCount));
  format.Format.nSamplesPerSec = static_cast<DWORD>(sampleRate);
  format.Format.wBitsPerSample = static_cast<WORD>(variant.containerBits);
  format.Format.nBlockAlign = static_cast<WORD>(format.Format.nChannels * (format.Format.wBitsPerSample / 8));
  format.Format.nAvgBytesPerSec = format.Format.nSamplesPerSec * format.Format.nBlockAlign;
  format.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  format.Samples.wValidBitsPerSample = static_cast<WORD>(variant.bitDepth);
  format.dwChannelMask = wasapi::defaultChannelMask(channelCount);
  format.SubFormat = variant.ieeeFloat ? kFloatSubFormat : kPcmSubFormat;

  std::vector<uint8_t> bytes(sizeof(WAVEFORMATEXTENSIBLE));
  std::memcpy(bytes.data(), &format, sizeof(format));
  return bytes;
}

}  // namespace

struct WasapiFormatNegotiator::Candidate {
  AudioFormat outputFormat;
  std::vector<uint8_t> waveFormatBytes;
  bool dopCarrier = false;
};

WasapiFormatNegotiator::WasapiFormatNegotiator(IAudioClient* audioClient) : audioClient_(audioClient) {}

bool WasapiFormatNegotiator::negotiate(const AudioFormat& sourceFormat, std::string* error) {
  lastFailureReason_.clear();
  outputInfo_ = {};
  outputFormat_ = {};
  dopRuntimeFacts_ = {};
  waveFormatBytes_.clear();

  if (!audioClient_) {
    lastFailureReason_ = "WASAPI 独占格式协商失败：音频客户端尚未初始化";
    if (wantsDopCarrier(sourceFormat)) {
      dopRuntimeFacts_.state = DopRuntimeFactState::Unproven;
      dopRuntimeFacts_.candidateFormat = defaultDopCandidate(sourceFormat);
      dopRuntimeFacts_.reason = lastFailureReason_;
    }
    if (error) *error = lastFailureReason_;
    return false;
  }
  if (sourceFormat.sampleRate <= 0 || sourceFormat.channelCount <= 0) {
    lastFailureReason_ = "WASAPI 独占格式协商失败：源音频格式无效";
    if (wantsDopCarrier(sourceFormat)) {
      dopRuntimeFacts_.state = DopRuntimeFactState::Unproven;
      dopRuntimeFacts_.candidateFormat = defaultDopCandidate(sourceFormat);
      dopRuntimeFacts_.reason = lastFailureReason_;
    }
    if (error) *error = lastFailureReason_;
    return false;
  }

  const std::vector<Candidate> candidates = buildCandidates(sourceFormat);
  for (const Candidate& candidate : candidates) {
    if (supportResult(candidate) != S_OK) continue;

    outputFormat_ = candidate.outputFormat;
    waveFormatBytes_ = candidate.waveFormatBytes;
    outputInfo_.exclusive = true;
    outputInfo_.accessMode = "exclusive";
    outputInfo_.supportsOutputPerfect = true;
    outputInfo_.sourceExact = false;
    outputInfo_.outputPerfect = false;
    outputInfo_.pcmPassthrough = false;
    outputInfo_.resampled = !sameSourceFormat(sourceFormat, outputFormat_);
    if (candidate.dopCarrier) {
      outputInfo_.perfectReasonCode = "dsd_dop";
      outputInfo_.perfectReason = "WASAPI 独占输出格式已协商为 DoP carrier（未启用 Native DSD）";
      outputInfo_.driverDopCapable = true;
      outputInfo_.driverDopCarrierSampleRates = {outputFormat_.sampleRate};
      outputInfo_.driverDopCarrierFormats = {sampleFormatToString(outputFormat_.sampleFormat)};
    } else {
      outputInfo_.perfectReasonCode = outputInfo_.resampled ? "pcm_converted" : "";
      outputInfo_.perfectReason = outputInfo_.resampled ? "WASAPI 独占输出格式已协商为设备支持格式" : "";
    }
    outputInfo_.outputSampleRate = outputFormat_.sampleRate;
    outputInfo_.outputBitDepth = outputFormat_.bitDepth;
    outputInfo_.backend = "wasapi-exclusive";
    outputInfo_.actualBackend = "wasapi-exclusive";
    outputInfo_.devicePathKind = "default";
    outputInfo_.deviceName.clear();
    outputInfo_.actualDeviceName.clear();
    outputInfo_.actualOutputFormat = sampleFormatToString(outputFormat_.sampleFormat);
    outputInfo_.actualSampleRate = outputFormat_.sampleRate;
    outputInfo_.actualBitDepth = outputFormat_.bitDepth;
    outputInfo_.actualChannels = outputFormat_.channelCount;
    if (candidate.dopCarrier) {
      dopRuntimeFacts_.state = DopRuntimeFactState::Proven;
      dopRuntimeFacts_.candidateFormat = outputFormat_;
      dopRuntimeFacts_.actualFormat = outputFormat_;
      dopRuntimeFacts_.explicitlyCapable = true;
      dopRuntimeFacts_.reason = "WASAPI exclusive accepted an exact DoP carrier format";
    }
    return true;
  }

  lastFailureReason_ = buildFailureReason(sourceFormat, candidates);
  outputInfo_.exclusive = true;
  outputInfo_.accessMode = "exclusive";
  outputInfo_.supportsOutputPerfect = false;
  outputInfo_.backend = "wasapi-exclusive";
  outputInfo_.actualBackend = "wasapi-exclusive";
  outputInfo_.devicePathKind = "default";
  outputInfo_.perfectReasonCode = "backend_not_output_perfect";
  outputInfo_.capabilityReason = lastFailureReason_;
  outputInfo_.perfectReason = lastFailureReason_;
  if (wantsDopCarrier(sourceFormat)) {
    dopRuntimeFacts_.state = DopRuntimeFactState::Unproven;
    dopRuntimeFacts_.candidateFormat = defaultDopCandidate(sourceFormat);
    dopRuntimeFacts_.reason = lastFailureReason_;
  }
  if (error) *error = lastFailureReason_;
  return false;
}

const AudioFormat& WasapiFormatNegotiator::outputFormat() const {
  return outputFormat_;
}

const OutputInfo& WasapiFormatNegotiator::outputInfo() const {
  return outputInfo_;
}

const DopRuntimeFacts& WasapiFormatNegotiator::dopRuntimeFacts() const {
  return dopRuntimeFacts_;
}

const std::string& WasapiFormatNegotiator::lastFailureReason() const {
  return lastFailureReason_;
}

const WAVEFORMATEX* WasapiFormatNegotiator::waveFormat() const {
  return reinterpret_cast<const WAVEFORMATEX*>(waveFormatBytes_.data());
}

size_t WasapiFormatNegotiator::waveFormatSize() const {
  return waveFormatBytes_.size();
}

std::vector<WasapiFormatNegotiator::Candidate> WasapiFormatNegotiator::buildCandidates(
    const AudioFormat& sourceFormat) const {
  std::vector<Candidate> candidates;
  std::set<std::tuple<int, int, AudioSampleFormat>> seen;

  if (wantsDopCarrier(sourceFormat)) {
    const int carrierRate = dopCarrierRateForSource(sourceFormat);
    if (carrierRate <= 0) return candidates;

    for (const FormatVariant& variant : dopCarrierFormatVariants(sourceFormat.sampleFormat)) {
      const auto key = std::make_tuple(carrierRate, variant.containerBits, variant.sampleFormat);
      if (!seen.insert(key).second) continue;

      Candidate candidate;
      candidate.outputFormat.sampleRate = carrierRate;
      candidate.outputFormat.channelCount = sourceFormat.channelCount;
      candidate.outputFormat.bitDepth = 24;
      candidate.outputFormat.sampleFormat = variant.sampleFormat;
      candidate.waveFormatBytes = makeWaveFormatBytes(carrierRate, sourceFormat.channelCount, variant);
      candidate.dopCarrier = true;
      candidates.push_back(std::move(candidate));
    }
    return candidates;
  }

  for (int sampleRate : sampleRatePriority(sourceFormat.sampleRate)) {
    for (int bitDepth : bitDepthPriority(sourceFormat.bitDepth)) {
      for (const FormatVariant& variant : formatVariants(bitDepth, sourceFormat.sampleFormat)) {
        const auto key = std::make_tuple(sampleRate, variant.containerBits, variant.sampleFormat);
        if (!seen.insert(key).second) continue;

        Candidate candidate;
        candidate.outputFormat.sampleRate = sampleRate;
        candidate.outputFormat.channelCount = sourceFormat.channelCount;
        candidate.outputFormat.bitDepth = variant.bitDepth;
        candidate.outputFormat.sampleFormat = variant.sampleFormat;
        candidate.waveFormatBytes = makeWaveFormatBytes(sampleRate, sourceFormat.channelCount, variant);
        candidates.push_back(std::move(candidate));
      }
    }
  }

  return candidates;
}

HRESULT WasapiFormatNegotiator::supportResult(const Candidate& candidate) const {
  const auto* format = reinterpret_cast<const WAVEFORMATEX*>(candidate.waveFormatBytes.data());
  return audioClient_->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, format, nullptr);
}

std::string WasapiFormatNegotiator::buildFailureReason(
    const AudioFormat& sourceFormat,
    const std::vector<Candidate>& candidates) const {
  std::vector<std::string> reasons;
  HRESULT firstFailure = E_FAIL;
  bool sawFailure = false;
  bool acceptedSourceRate = false;
  bool acceptedSourceBitDepth = false;
  bool acceptedSourceSampleFormat = false;
  bool acceptedSourceChannelCount = false;
  bool testedSourceRate = false;
  bool testedSourceBitDepth = false;
  bool testedSourceSampleFormat = false;

  const bool dopCarrierRequested = wantsDopCarrier(sourceFormat);
  const int expectedDopCarrierRate = dopCarrierRateForSource(sourceFormat);
  if (dopCarrierRequested && expectedDopCarrierRate <= 0) {
    return "WASAPI 独占 DoP carrier 协商失败：" + formatSummary(sourceFormat) +
           "；source sample rate " + std::to_string(sourceFormat.sampleRate) +
           "Hz 暂无可用 DoP carrier（本阶段协商 DSD64/DSD128/DSD256/DSD512 -> 176400/192000/352800/384000/705600/768000/1411200/1536000Hz，24-bit int24/int24-in32；未启用 Native DSD）";
  }

  const int sourceBitDepth = dopCarrierRequested ? 24 : normalizeBitDepth(sourceFormat.bitDepth);
  for (const Candidate& candidate : candidates) {
    const HRESULT hr = supportResult(candidate);
    if (hr != S_OK && !sawFailure) {
      firstFailure = hr;
      sawFailure = true;
    }

    const bool sameRate = candidate.outputFormat.sampleRate ==
                          (dopCarrierRequested ? expectedDopCarrierRate : sourceFormat.sampleRate);
    const bool sameBitDepth = candidate.outputFormat.bitDepth == sourceBitDepth;
    const bool sameSampleFormat = dopCarrierRequested ? isDopCarrierSampleFormat(candidate.outputFormat.sampleFormat)
                                                      : candidate.outputFormat.sampleFormat == sourceFormat.sampleFormat;
    const bool sameChannels = candidate.outputFormat.channelCount == sourceFormat.channelCount;

    testedSourceRate = testedSourceRate || sameRate;
    testedSourceBitDepth = testedSourceBitDepth || sameBitDepth;
    testedSourceSampleFormat = testedSourceSampleFormat || sameSampleFormat;

    if (hr == S_OK) {
      acceptedSourceRate = acceptedSourceRate || sameRate;
      acceptedSourceBitDepth = acceptedSourceBitDepth || sameBitDepth;
      acceptedSourceSampleFormat = acceptedSourceSampleFormat || sameSampleFormat;
      acceptedSourceChannelCount = acceptedSourceChannelCount || sameChannels;
    }
  }

  if (!testedSourceRate) {
    appendReason(
        &reasons,
        std::string(dopCarrierRequested ? "DoP carrier sample rate " : "sample rate ") +
            std::to_string(dopCarrierRequested ? expectedDopCarrierRate : sourceFormat.sampleRate) +
            "Hz 未进入 WASAPI 候选");
  } else if (!acceptedSourceRate) {
    appendReason(
        &reasons,
        std::string(dopCarrierRequested ? "DoP carrier sample rate " : "sample rate ") +
            std::to_string(dopCarrierRequested ? expectedDopCarrierRate : sourceFormat.sampleRate) + "Hz 被设备拒绝");
  }

  if (!acceptedSourceChannelCount) {
    appendReason(&reasons, "channel count " + std::to_string(sourceFormat.channelCount) + "ch 被设备拒绝");
  }

  if (!testedSourceBitDepth) {
    appendReason(
        &reasons,
        std::string(dopCarrierRequested ? "DoP carrier bit depth " : "bit depth ") +
            std::to_string(dopCarrierRequested ? 24 : sourceFormat.bitDepth) + "bit 无可用 PCM 变体");
  } else if (!acceptedSourceBitDepth) {
    appendReason(
        &reasons,
        std::string(dopCarrierRequested ? "DoP carrier bit depth " : "bit depth ") +
            std::to_string(dopCarrierRequested ? 24 : sourceFormat.bitDepth) + "bit 被设备拒绝");
  }

  if (!testedSourceSampleFormat) {
    appendReason(
        &reasons,
        dopCarrierRequested ? "DoP carrier sample format int24/int24-in32 未进入 WASAPI 候选"
                            : "sample format " + sampleFormatToString(sourceFormat.sampleFormat) + " 无可用 PCM 变体");
  } else if (!acceptedSourceSampleFormat) {
    appendReason(
        &reasons,
        dopCarrierRequested ? "DoP carrier sample format int24/int24-in32 被设备拒绝"
                            : "sample format " + sampleFormatToString(sourceFormat.sampleFormat) + " 被设备拒绝");
  }

  if (reasons.empty()) {
    appendReason(&reasons, "exclusive format open/init failure");
  }

  std::string message = dopCarrierRequested
                            ? "WASAPI 独占 DoP carrier 协商失败：" + formatSummary(sourceFormat) +
                                  " -> " + std::to_string(expectedDopCarrierRate) +
                                  "Hz 24bit int24/int24-in32；"
                            : "WASAPI 独占格式协商失败：" + formatSummary(sourceFormat) + "；";
  for (size_t i = 0; i < reasons.size(); ++i) {
    if (i > 0) message += "，";
    message += reasons[i];
  }
  if (sawFailure) {
    message += "；首个 IsFormatSupported 错误码 " + hresultSuffix(firstFailure);
  }
  if (dopCarrierRequested) {
    message += "；未尝试 Native DSD";
  }
  return message;
}

bool WasapiFormatNegotiator::sameSourceFormat(const AudioFormat& sourceFormat, const AudioFormat& outputFormat) const {
  // A DoP carrier request is the pipeline's deliberate transport decision for a
  // DSD source, not a conversion: this negotiator only ever accepts candidates
  // at the carrier rate derived from the source, so an accepted candidate is by
  // definition not a resample. Reporting it as one failed the pipeline's DoP
  // passthrough proof on every WASAPI exclusive session even while the rendered
  // markers proved the frames left untouched.
  if (wantsDopCarrier(sourceFormat)) {
    const int expectedCarrierRate = dopCarrierRateForSource(sourceFormat);
    return expectedCarrierRate > 0 && expectedCarrierRate == outputFormat.sampleRate &&
           sourceFormat.channelCount == outputFormat.channelCount &&
           effectivePcmBitDepth(outputFormat) == 24 && isDopCarrierSampleFormat(outputFormat.sampleFormat);
  }
  // int24 -> int24-in-32 only widens the container; every significant bit
  // survives, so negotiating it is not a conversion of the source.
  return sourceFormat.sampleRate == outputFormat.sampleRate &&
         sourceFormat.channelCount == outputFormat.channelCount &&
         normalizeBitDepth(sourceFormat.bitDepth) == outputFormat.bitDepth &&
         (sourceFormat.sampleFormat == outputFormat.sampleFormat ||
          sampleFormatsSameIntegerPayload(sourceFormat.sampleFormat, outputFormat.sampleFormat));
}

}  // namespace twilight::audio

#endif
