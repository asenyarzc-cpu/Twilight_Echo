#pragma once

#include "../../core/AudioTypes.h"

#include <cstdint>
#include <optional>

namespace twilight::audio {

enum class AsioNativeDsdControlOrder : uint8_t {
  Default,
  FormatFirst,
  RateFirst,
  RateOnly
};

struct AsioSampleFormatMapping {
  AudioSampleFormat reported = AudioSampleFormat::Float32Interleaved;
  AudioSampleFormat interpreted = AudioSampleFormat::Float32Interleaved;
};

}  // namespace twilight::audio
