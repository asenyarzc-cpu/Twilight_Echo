#include "IAsioHost.h"

namespace twilight::audio {

std::vector<int> asioDefaultSampleRateProbeSet() {
  return {
      44100,
      48000,
      88200,
      96000,
      176400,
      192000,
      352800,
      384000,
      705600,
      768000,
      1411200,
      1536000};
}

std::vector<int> asioDsdSemanticRateProbeSet() {
  return {
      2822400,
      3072000,
      5644800,
      6144000,
      11289600,
      12288000,
      22579200,
      24576000};
}

std::string asioSampleFormatName(AudioSampleFormat format) {
  return sampleFormatToString(format);
}

}  // namespace twilight::audio
