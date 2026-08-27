#include "AudioTypes.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>

namespace twilight::audio {
namespace {

constexpr double kUnityVolumeEpsilon = 0.0001;

int bitDepthFromSampleFormat(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::DsdInt8Lsb1:
    case AudioSampleFormat::DsdInt8Msb1:
    case AudioSampleFormat::DsdInt8Ner8:
      return 1;
    case AudioSampleFormat::Int16Interleaved:
      return 16;
    case AudioSampleFormat::Int24Interleaved:
    case AudioSampleFormat::Int24In32Interleaved:
      return 24;
    case AudioSampleFormat::Int32Interleaved:
    case AudioSampleFormat::Float32Interleaved:
    default:
      return 32;
  }
}

bool routingPreservesSemantics(ChannelRoutingMode mode, int sourceChannels, int outputChannels) {
  if (sourceChannels <= 0 || outputChannels <= 0) return false;
  switch (mode) {
    case ChannelRoutingMode::Auto:
      return sourceChannels == outputChannels;
    case ChannelRoutingMode::Stereo:
      return sourceChannels == 2 && outputChannels == 2;
    case ChannelRoutingMode::StereoTo51:
    case ChannelRoutingMode::StereoTo71:
    case ChannelRoutingMode::MonoToStereo:
    case ChannelRoutingMode::MonoToMultichannel:
    default:
      return false;
  }
}

std::string formatSummary(const AudioFormat& format) {
  return sampleFormatToString(format.sampleFormat) + " " + std::to_string(effectivePcmBitDepth(format)) + "bit " +
         std::to_string(format.sampleRate) + "Hz " + std::to_string(format.channelCount) + "ch";
}

std::string processingReason(const PerfectEvaluation& evaluation) {
  if (std::abs(evaluation.volume - 1.0) > kUnityVolumeEpsilon) return "Volume active";
  if (std::abs(evaluation.playbackRate - 1.0) > kUnityVolumeEpsilon) return "Playback rate active";
  if (evaluation.loudnormActive) return "Loudnorm active";
  if (evaluation.replayGainActive) return "ReplayGain active";
  if (evaluation.eqActive) return "EQ active";
  if (evaluation.convolverActive) return "Convolver active";
  if (evaluation.crossfeedActive) return "Crossfeed active";
  if (evaluation.nativeDspActive) return "Native DSP plugin active";
  if (evaluation.crossfadeActive) return "Crossfade active";
  return "Audio processing active";
}

std::string processingReasonCode(const PerfectEvaluation& evaluation) {
  if (std::abs(evaluation.volume - 1.0) > kUnityVolumeEpsilon) return "volume_not_unity";
  if (std::abs(evaluation.playbackRate - 1.0) > kUnityVolumeEpsilon) return "playback_rate_not_unity";
  if (evaluation.loudnormActive) return "loudnorm_active";
  if (evaluation.replayGainActive) return "replaygain_active";
  if (evaluation.eqActive) return "eq_active";
  if (evaluation.convolverActive) return "convolver_active";
  if (evaluation.crossfeedActive) return "crossfeed_active";
  if (evaluation.nativeDspActive) return "native_dsp_active";
  if (evaluation.crossfadeActive) return "crossfade_active";
  return "processing_active";
}

std::string lowerText(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string dsdPcmFallbackReasonCode(const std::string& backendReason) {
  const std::string reason = lowerText(backendReason);
  if (reason.find("output mode forced pcm") != std::string::npos) return "dsd_output_mode_pcm";
  if (reason.find("dop carrier mismatch") != std::string::npos) return "dop_carrier_mismatch";
  // A failed probe means neither DSD route was attempted; reporting it as an
  // unproven DoP passthrough points the user at the transport instead of the
  // unreadable source.
  if (reason.find("dsd probe failed") != std::string::npos) return "dsd_probe_failed";
  if (reason.find("cannot carry dsd") != std::string::npos) return "dsd_backend_cannot_carry";
  if (reason.find("passthrough") != std::string::npos || reason.find("prove") != std::string::npos) {
    return "dop_passthrough_unproven";
  }
  if (reason.find("native dsd") != std::string::npos) return "dsd_source_unsupported";
  return "dsd_converted_to_pcm";
}

bool hasConcreteFormat(const AudioFormat& format) {
  return format.sampleRate > 0 && format.channelCount > 0 &&
         (isDsdSampleFormat(format.sampleFormat) || effectivePcmBitDepth(format) > 0);
}

bool dopCarrierMatchesExpected(const PerfectEvaluation& evaluation) {
  const auto expected =
      dopCarrierFormatForDsd(evaluation.dsdRate, evaluation.sourceFormat.sampleRate, evaluation.sourceFormat.channelCount);
  if (!expected.has_value()) return false;
  if (evaluation.dopCarrierMatched) return true;
  return hasConcreteFormat(evaluation.dopCarrierFormat) &&
         pcmFormatsSemanticallyMatch(evaluation.dopCarrierFormat, *expected) &&
         pcmFormatsSemanticallyMatch(evaluation.outputFormat, evaluation.dopCarrierFormat);
}

std::string dsdPerfectReason(const PerfectEvaluation& evaluation) {
  if (evaluation.dsdMode == DsdMode::Native) {
    if (!evaluation.nativeDsdPassthroughProven) {
      return evaluation.backendPerfectReason.empty() ? "Native DSD backend could not prove passthrough"
                                                     : evaluation.backendPerfectReason;
    }
    return "Native DSD output format mismatch";
  }
  if (evaluation.nativeDsdRequested || evaluation.dsdMode == DsdMode::Unsupported) {
    return "DSD source unsupported";
  }
  if (evaluation.dsdMode == DsdMode::Pcm) {
    return evaluation.backendPerfectReason.empty() ? "DSD converted to PCM" : evaluation.backendPerfectReason;
  }
  if (evaluation.dsdMode == DsdMode::Dop) {
    if (!dopCarrierFormatForDsd(evaluation.dsdRate, evaluation.sourceFormat.sampleRate, evaluation.sourceFormat.channelCount)
             .has_value()) {
      return "DSD source unsupported";
    }
    if (!dopCarrierMatchesExpected(evaluation)) return "DoP carrier mismatch";
    if (!evaluation.dopPassthroughProven || !evaluation.supportsOutputPerfect || evaluation.backendResampled) {
      return "DoP backend could not prove passthrough";
    }
  }
  return "DSD source unsupported";
}

std::string dsdPerfectReasonCode(const PerfectEvaluation& evaluation) {
  if (evaluation.dsdMode == DsdMode::Native) {
    if (!evaluation.nativeDsdPassthroughProven) {
      return evaluation.backendPerfectReasonCode.empty() ? "native_dsd_passthrough_unproven"
                                                         : evaluation.backendPerfectReasonCode;
    }
    return "native_dsd_format_mismatch";
  }
  if (evaluation.nativeDsdRequested || evaluation.dsdMode == DsdMode::Unsupported) {
    return "dsd_source_unsupported";
  }
  if (evaluation.dsdMode == DsdMode::Pcm) {
    return dsdPcmFallbackReasonCode(evaluation.backendPerfectReason);
  }
  if (evaluation.dsdMode == DsdMode::Dop) {
    if (!dopCarrierFormatForDsd(evaluation.dsdRate, evaluation.sourceFormat.sampleRate, evaluation.sourceFormat.channelCount)
             .has_value()) {
      return "dsd_source_unsupported";
    }
    if (!dopCarrierMatchesExpected(evaluation)) return "dop_carrier_mismatch";
    if (!evaluation.dopPassthroughProven || !evaluation.supportsOutputPerfect || evaluation.backendResampled) {
      return "dop_passthrough_unproven";
    }
  }
  return "dsd_source_unsupported";
}

// Significant bits an integer PCM container carries. Formats that share a
// payload width hold identical sample values, so a source in one reaches the
// other untouched regardless of how many bytes the container spends on it.
int integerPayloadBits(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::Int16Interleaved:
      return 16;
    case AudioSampleFormat::Int24Interleaved:
    case AudioSampleFormat::Int24In32Interleaved:
      return 24;
    case AudioSampleFormat::Int32Interleaved:
      return 32;
    default:
      return 0;
  }
}

}  // namespace

std::string channelRoutingModeToString(ChannelRoutingMode mode) {
  switch (mode) {
    case ChannelRoutingMode::Stereo:
      return "stereo";
    case ChannelRoutingMode::StereoTo51:
      return "stereo-to-5.1";
    case ChannelRoutingMode::StereoTo71:
      return "stereo-to-7.1";
    case ChannelRoutingMode::MonoToStereo:
      return "mono-to-stereo";
    case ChannelRoutingMode::MonoToMultichannel:
      return "mono-to-multichannel";
    case ChannelRoutingMode::Auto:
    default:
      return "auto";
  }
}

ChannelRoutingMode parseChannelRoutingMode(const std::string& mode) {
  std::string normalized = mode;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (normalized == "stereo") return ChannelRoutingMode::Stereo;
  if (normalized == "stereo-to-5.1" || normalized == "stereoto51") return ChannelRoutingMode::StereoTo51;
  if (normalized == "stereo-to-7.1" || normalized == "stereoto71") return ChannelRoutingMode::StereoTo71;
  if (normalized == "mono-to-stereo" || normalized == "monotostereo") return ChannelRoutingMode::MonoToStereo;
  if (normalized == "mono-to-multichannel" || normalized == "monotomultichannel") {
    return ChannelRoutingMode::MonoToMultichannel;
  }
  return ChannelRoutingMode::Auto;
}

std::string pcmToDsdModeToString(PcmToDsdMode mode) {
  switch (mode) {
    case PcmToDsdMode::Dsd64:
      return "dsd64";
    case PcmToDsdMode::Dsd128:
      return "dsd128";
    case PcmToDsdMode::Dsd256:
      return "dsd256";
    case PcmToDsdMode::Off:
    default:
      return "off";
  }
}

PcmToDsdMode parsePcmToDsdMode(const std::string& mode) {
  std::string normalized = mode;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (normalized == "dsd64") return PcmToDsdMode::Dsd64;
  if (normalized == "dsd128") return PcmToDsdMode::Dsd128;
  if (normalized == "dsd256") return PcmToDsdMode::Dsd256;
  return PcmToDsdMode::Off;
}

int pcmToDsdModeRateMultiplier(PcmToDsdMode mode) {
  switch (mode) {
    case PcmToDsdMode::Dsd64:
      return 64;
    case PcmToDsdMode::Dsd128:
      return 128;
    case PcmToDsdMode::Dsd256:
      return 256;
    case PcmToDsdMode::Off:
    default:
      return 0;
  }
}

std::string dsdModeToString(DsdMode mode) {
  switch (mode) {
    case DsdMode::Dop:
      return "dop";
    case DsdMode::Native:
      return "native";
    case DsdMode::Unsupported:
      return "unsupported";
    case DsdMode::Pcm:
    default:
      return "pcm";
  }
}

std::string sampleFormatToString(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::DsdInt8Lsb1:
      return "dsd-int8-lsb1";
    case AudioSampleFormat::DsdInt8Msb1:
      return "dsd-int8-msb1";
    case AudioSampleFormat::DsdInt8Ner8:
      return "dsd-int8-ner8";
    case AudioSampleFormat::Int16Interleaved:
      return "int16";
    case AudioSampleFormat::Int24Interleaved:
      return "int24";
    case AudioSampleFormat::Int24In32Interleaved:
      return "int24-in32";
    case AudioSampleFormat::Int32Interleaved:
      return "int32";
    case AudioSampleFormat::Float32Interleaved:
    default:
      return "float32";
  }
}

size_t audioSampleFormatBytes(AudioSampleFormat format) {
  switch (format) {
    case AudioSampleFormat::DsdInt8Lsb1:
    case AudioSampleFormat::DsdInt8Msb1:
    case AudioSampleFormat::DsdInt8Ner8:
      return 1;
    case AudioSampleFormat::Int16Interleaved:
      return 2;
    case AudioSampleFormat::Int24Interleaved:
      return 3;
    case AudioSampleFormat::Int24In32Interleaved:
    case AudioSampleFormat::Int32Interleaved:
    case AudioSampleFormat::Float32Interleaved:
    default:
      return 4;
  }
}

size_t audioFormatBytesPerFrame(const AudioFormat& format) {
  if (format.channelCount <= 0) return 0;
  return audioSampleFormatBytes(format.sampleFormat) * static_cast<size_t>(format.channelCount);
}

int normalizedPcmBitDepth(int bitDepth) {
  if (bitDepth <= 0) return 0;
  if (bitDepth <= 16) return 16;
  if (bitDepth <= 24) return 24;
  return 32;
}

int effectivePcmBitDepth(const AudioFormat& format) {
  if (isDsdSampleFormat(format.sampleFormat)) return 1;
  if (format.sampleFormat == AudioSampleFormat::Int24In32Interleaved) return 24;
  if (format.bitDepth > 0) return normalizedPcmBitDepth(format.bitDepth);
  return bitDepthFromSampleFormat(format.sampleFormat);
}

bool pcmFormatsExactMatch(const AudioFormat& left, const AudioFormat& right) {
  if (isDsdSampleFormat(left.sampleFormat) || isDsdSampleFormat(right.sampleFormat)) return false;
  const int leftBitDepth = effectivePcmBitDepth(left);
  const int rightBitDepth = effectivePcmBitDepth(right);
  return left.sampleRate > 0 && right.sampleRate > 0 && left.sampleRate == right.sampleRate &&
         left.channelCount > 0 && right.channelCount > 0 && left.channelCount == right.channelCount &&
         leftBitDepth > 0 && rightBitDepth > 0 && leftBitDepth == rightBitDepth &&
         left.sampleFormat == right.sampleFormat;
}

bool sampleFormatsSameIntegerPayload(AudioSampleFormat left, AudioSampleFormat right) {
  const int leftPayload = integerPayloadBits(left);
  return leftPayload > 0 && leftPayload == integerPayloadBits(right);
}

bool pcmFormatsSemanticallyMatch(const AudioFormat& left, const AudioFormat& right) {
  if (pcmFormatsExactMatch(left, right)) return true;
  if (!sampleFormatsSameIntegerPayload(left.sampleFormat, right.sampleFormat)) return false;
  return left.sampleRate > 0 && left.sampleRate == right.sampleRate && left.channelCount > 0 &&
         left.channelCount == right.channelCount &&
         effectivePcmBitDepth(left) == effectivePcmBitDepth(right);
}

bool isDsdSampleFormat(AudioSampleFormat format) {
  return format == AudioSampleFormat::DsdInt8Lsb1 || format == AudioSampleFormat::DsdInt8Msb1 ||
         format == AudioSampleFormat::DsdInt8Ner8;
}

bool dsdFormatsExactMatch(const AudioFormat& left, const AudioFormat& right) {
  return left.sampleRate > 0 && right.sampleRate > 0 && left.sampleRate == right.sampleRate &&
         left.channelCount > 0 && right.channelCount > 0 && left.channelCount == right.channelCount &&
         isDsdSampleFormat(left.sampleFormat) && isDsdSampleFormat(right.sampleFormat) &&
         left.sampleFormat == right.sampleFormat;
}

bool nativeDsdFormatsSemanticallyMatch(const AudioFormat& left, const AudioFormat& right) {
  return left.sampleRate > 0 && right.sampleRate > 0 && left.sampleRate == right.sampleRate &&
         left.channelCount > 0 && right.channelCount > 0 && left.channelCount == right.channelCount &&
         isDsdSampleFormat(left.sampleFormat) && isDsdSampleFormat(right.sampleFormat);
}

std::optional<AudioFormat> dopCarrierFormatForDsd(int dsdRate, int sourceSampleRate, int channelCount) {
  if (channelCount <= 0) return std::nullopt;

  AudioFormat carrier;
  carrier.channelCount = channelCount;
  carrier.bitDepth = 24;
  carrier.sampleFormat = AudioSampleFormat::Int24Interleaved;

  const bool is48kFamily = sourceSampleRate > 0 && sourceSampleRate % 48000 == 0;
  const bool is441kFamily = sourceSampleRate <= 0 || sourceSampleRate % 44100 == 0;

  switch (dsdRate) {
    case 64:
      carrier.sampleRate = is48kFamily && !is441kFamily ? 192000 : 176400;
      return carrier;
    case 128:
      carrier.sampleRate = is48kFamily && !is441kFamily ? 384000 : 352800;
      return carrier;
    case 256:
      carrier.sampleRate = is48kFamily && !is441kFamily ? 768000 : 705600;
      return carrier;
    case 512:
      carrier.sampleRate = is48kFamily && !is441kFamily ? 1536000 : 1411200;
      return carrier;
    default:
      return std::nullopt;
  }
}

PerfectResult evaluatePerfect(const PerfectEvaluation& evaluation) {
  PerfectResult result;
  const AudioFormat decodedFormat =
      evaluation.decodedFormat.sampleRate > 0 ? evaluation.decodedFormat : evaluation.sourceFormat;
  const bool dsdFormatMatched = evaluation.sourceDsd && evaluation.dsdMode == DsdMode::Native &&
                                nativeDsdFormatsSemanticallyMatch(decodedFormat, evaluation.outputFormat);
  const bool dopCarrierMatched = evaluation.sourceDsd && evaluation.dsdMode == DsdMode::Dop &&
                                 dopCarrierMatchesExpected(evaluation);
  // DoP arrives as an Int24 carrier while the wire often runs a 24-in-32
  // container; both hold the same payload, so DSD paths match semantically.
  result.formatMatched =
      dsdFormatMatched || (evaluation.sourceDsd ? pcmFormatsSemanticallyMatch(decodedFormat, evaluation.outputFormat)
                                                : pcmFormatsExactMatch(decodedFormat, evaluation.outputFormat));
  result.sourceFormatMatched = pcmFormatsSemanticallyMatch(evaluation.sourceFormat, evaluation.outputFormat);
  result.resampled = evaluation.backendResampled || !result.formatMatched;
  result.processingActive =
      evaluation.loudnormActive || evaluation.replayGainActive || evaluation.eqActive || evaluation.convolverActive ||
      evaluation.crossfeedActive || evaluation.nativeDspActive || evaluation.crossfadeActive ||
      std::abs(evaluation.volume - 1.0) > kUnityVolumeEpsilon ||
      std::abs(evaluation.playbackRate - 1.0) > kUnityVolumeEpsilon;
  result.routingPreservesSemantics = routingPreservesSemantics(
      evaluation.routingMode,
      decodedFormat.channelCount,
      evaluation.outputFormat.channelCount);
  // A 24-bit source reaching a 24-in-32 wire format keeps every bit, so only a
  // payload change (int -> float, or a different significant-bit count) counts
  // as losing the integer path.
  const bool losslessPcmDecodedConverted =
      !evaluation.sourceDsd && evaluation.sourceLossless &&
      !pcmFormatsSemanticallyMatch(evaluation.sourceFormat, decodedFormat);
  result.pcmPassthrough = evaluation.pcmPassthrough && result.formatMatched && !evaluation.backendResampled &&
                          !losslessPcmDecodedConverted;
  const bool pcmOutputPerfect =
      !evaluation.sourceDsd && evaluation.supportsOutputPerfect && result.pcmPassthrough &&
      !result.processingActive && result.routingPreservesSemantics;
  const bool nativeDsdOutputPerfect =
      evaluation.sourceDsd && evaluation.dsdMode == DsdMode::Native && evaluation.supportsOutputPerfect &&
      evaluation.nativeDsdPassthroughProven &&
      nativeDsdFormatsSemanticallyMatch(evaluation.decodedFormat, evaluation.outputFormat) &&
      !evaluation.backendResampled && !result.processingActive && result.routingPreservesSemantics;
  const bool dopOutputPerfect =
      evaluation.sourceDsd && evaluation.dsdMode == DsdMode::Dop && dopCarrierMatched &&
      evaluation.dopPassthroughProven && evaluation.supportsOutputPerfect && !evaluation.backendResampled &&
      !result.processingActive && result.routingPreservesSemantics;
  result.outputPerfect = pcmOutputPerfect || nativeDsdOutputPerfect || dopOutputPerfect;
  result.sourceExact =
      result.outputPerfect && evaluation.sourceLossless &&
      (evaluation.sourceDsd ? (evaluation.dsdMode == DsdMode::Native || evaluation.dsdMode == DsdMode::Dop)
                            : result.sourceFormatMatched);

  if (result.sourceExact && result.outputPerfect) {
    result.perfectReasonCode.clear();
    result.perfectReason.clear();
  } else if (evaluation.sourceDsd) {
    if (!result.routingPreservesSemantics) {
      result.perfectReasonCode = "routing_changes_semantics";
      result.perfectReason = "Channel routing changes DSD channel semantics";
    } else if (result.processingActive) {
      // Volume and playback rate are transport controls, not the DSP chain.
      // Collapsing them into dsd_processing_pcm_fallback told the listener to
      // "turn off DSP or enable direct mode" — advice that changes nothing when
      // the real blocker is the 70% default software volume, which direct mode
      // deliberately leaves alone (jumping to unity would be a +3dB surprise).
      // Volume gets its own DSD code because it is the one blocker a listener
      // hits by default; playback rate defaults to 1.0 and direct mode forces
      // it, so the shared transport code carries enough for that edge case.
      const std::string processingCode = processingReasonCode(evaluation);
      if (processingCode == "volume_not_unity") {
        result.perfectReasonCode = "dsd_volume_pcm_fallback";
        result.perfectReason = "Software volume is not unity; DSD falls back to PCM";
      } else if (processingCode == "playback_rate_not_unity") {
        result.perfectReasonCode = processingCode;
        result.perfectReason = processingReason(evaluation);
      } else {
        result.perfectReasonCode = "dsd_processing_pcm_fallback";
        result.perfectReason = "DSD processing active; falling back to PCM";
      }
    } else if (evaluation.dsdMode == DsdMode::Pcm && evaluation.dsdRate >= 256 &&
               evaluation.backendPerfectReason.empty()) {
      result.perfectReasonCode = "dsd_high_rate_pcm_fallback";
      result.perfectReason = "DSD" + std::to_string(evaluation.dsdRate) + " currently falls back to PCM";
    } else {
      result.perfectReasonCode = dsdPerfectReasonCode(evaluation);
      result.perfectReason = dsdPerfectReason(evaluation);
    }
  } else if (!evaluation.supportsOutputPerfect) {
    result.perfectReasonCode =
        evaluation.backendPerfectReasonCode.empty() ? "backend_not_output_perfect" : evaluation.backendPerfectReasonCode;
    result.perfectReason =
        evaluation.backendPerfectReason.empty() ? "共享输出经过系统混音" : evaluation.backendPerfectReason;
  } else if (!result.routingPreservesSemantics) {
    result.perfectReasonCode = "routing_changes_semantics";
    result.perfectReason = "声道映射改变声道语义";
  } else if (result.processingActive) {
    result.perfectReasonCode = processingReasonCode(evaluation);
    result.perfectReason = processingReason(evaluation);
  } else if (losslessPcmDecodedConverted) {
    result.perfectReasonCode = "integer_passthrough_unavailable";
    result.perfectReason =
        "Lossless PCM decoded through non-identical PCM format: " + formatSummary(evaluation.sourceFormat) + " -> " +
        formatSummary(decodedFormat);
  } else if (!result.pcmPassthrough) {
    result.perfectReasonCode = "pcm_converted";
    result.perfectReason =
        evaluation.backendPerfectReason.empty()
            ? "Decoded PCM converted from " + formatSummary(decodedFormat) + " to " + formatSummary(evaluation.outputFormat)
            : evaluation.backendPerfectReason;
  } else if (!evaluation.sourceLossless) {
    result.perfectReasonCode = "source_lossy";
    result.perfectReason = "Source is lossy; decoded PCM path is output perfect";
  } else if (!result.sourceFormatMatched) {
    result.perfectReasonCode = "source_format_differs";
    result.perfectReason =
        "Source PCM format differs from output format: " + formatSummary(evaluation.sourceFormat) + " -> " +
        formatSummary(evaluation.outputFormat);
  } else {
    result.perfectReasonCode = "output_not_perfect";
  }
  return result;
}

}  // namespace twilight::audio
