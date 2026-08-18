/*
 * Direct Stream Transfer (DST) decoder
 * Copyright (c) 2014 Peter Ross <pross@xvid.org>
 *
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/*
 * Modifications:
 * - Removed the FFmpeg AVCodecContext/AVFrame/AVPacket integration layer.
 * - Removed the dsd2pcm translation tail so raw DSD bytes remain intact.
 * - Changed output layout to tight DffInterleaved byte packing.
 * - Replaced FFmpeg bitreader helpers with a minimal in-repo MSB-first reader.
 * - Exposed a raw-buffer decode entry point for the Twilight Audio Engine host.
 */

#include "dstdec.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cstring>
#include <limits>

namespace twilight::audio::dstdec {
namespace {

constexpr int kFrameDenominator = 2822400;
constexpr int kSacdSampleRateBase = 44100;
constexpr int kDsdBitsPerByte = 8;
constexpr int kDstMaxElements = 2 * kDstMaxChannels;

constexpr std::array<uint8_t, 128> makeReverse7() {
  std::array<uint8_t, 128> table{};
  for (int value = 0; value < 128; ++value) {
    uint8_t reversed = 0;
    for (int bit = 0; bit < 7; ++bit) {
      reversed = static_cast<uint8_t>((reversed << 1) | ((value >> bit) & 1));
    }
    table[static_cast<size_t>(value)] = reversed;
  }
  return table;
}

constexpr std::array<uint8_t, 128> kReverse7 = makeReverse7();

constexpr std::array<std::array<int8_t, 3>, 3> kFsetsCodePredCoeff{{{{-8, 0, 0}}, {{-16, 8, 0}}, {{-9, -5, 6}}}};
constexpr std::array<std::array<int8_t, 3>, 3> kProbsCodePredCoeff{{{{-8, 0, 0}}, {{-16, 8, 0}}, {{-24, 24, -8}}}};

class BitReader {
 public:
  bool init(const uint8_t* data, size_t size, std::string* error) {
    if (!data || size == 0) {
      if (error) *error = "DST frame is empty";
      return false;
    }
    data_ = data;
    size_ = size;
    bitPos_ = 0;
    return true;
  }

  size_t bitsLeft() const {
    return size_ * 8U - bitPos_;
  }

  bool getBit(unsigned* value, std::string* error) {
    if (bitsLeft() == 0) {
      if (error) *error = "Unexpected end of DST frame";
      return false;
    }
    *value = static_cast<unsigned>((data_[bitPos_ >> 3] >> (7U - (bitPos_ & 7U))) & 1U);
    ++bitPos_;
    return true;
  }

  bool getBits(unsigned count, unsigned* value, std::string* error) {
    if (count > 32U || bitsLeft() < count) {
      if (error) *error = "Unexpected end of DST frame";
      return false;
    }
    unsigned result = 0;
    for (unsigned bit = 0; bit < count; ++bit) {
      result <<= 1U;
      result |= static_cast<unsigned>((data_[bitPos_ >> 3] >> (7U - (bitPos_ & 7U))) & 1U);
      ++bitPos_;
    }
    *value = result;
    return true;
  }

  bool getSignedBits(unsigned count, int* value, std::string* error) {
    unsigned raw = 0;
    if (!getBits(count, &raw, error)) return false;
    if (count == 0) {
      *value = 0;
      return true;
    }
    const unsigned signBit = 1U << (count - 1U);
    if ((raw & signBit) != 0U) {
      const unsigned mask = (1U << count) - 1U;
      raw = static_cast<unsigned>((~raw + 1U) & mask);
      *value = -static_cast<int>(raw);
    } else {
      *value = static_cast<int>(raw);
    }
    return true;
  }

 private:
  const uint8_t* data_ = nullptr;
  size_t size_ = 0;
  size_t bitPos_ = 0;
};

struct ArithCoder {
  unsigned a = 4095;
  unsigned c = 0;
};

struct Table {
  unsigned elements = 0;
  std::array<unsigned, kDstMaxElements> length{};
  std::array<std::array<int, 128>, kDstMaxElements> coeff{};
};

struct DecoderState {
  BitReader bits;
  ArithCoder ac;
  Table fsets;
  Table probs;
  std::array<std::array<uint8_t, 16>, kDstMaxChannels> status{};
  std::array<std::array<std::array<int16_t, 256>, 16>, kDstMaxElements> filter{};
  int channels = 0;
  int sampleRate = 0;
  size_t frameBytesPerChannel = 0;
};

size_t bitsPerChannelForFrame(size_t frameBytesPerChannel) {
  return frameBytesPerChannel * kDsdBitsPerByte;
}

// FFmpeg: (ff_reverse[c & 127] >> 1) + 1. kReverse7[x] is already the 7-bit
// reversal of x in bits 0..6, which equals (ff_reverse[x] >> 1) for x < 128,
// so no further shift is needed before adding 1.
unsigned probDstXBit(int value) {
  return static_cast<unsigned>(kReverse7[static_cast<size_t>(value & 127)]) + 1U;
}

bool readMap(BitReader& bits, Table* table, std::array<unsigned, kDstMaxChannels>* map, int channels, std::string* error) {
  table->elements = 1;
  (*map)[0] = 0;
  unsigned firstBit = 0;
  if (!bits.getBit(&firstBit, error)) return false;
  if (!firstBit) {
    for (int ch = 1; ch < channels; ++ch) {
      // FFmpeg upstream read_map: bits = av_log2(elements) + 1 == bit_width(elements).
      // The extra +1 shifted every per-channel map entry by one bit and broke
      // decoding of stereo/multichannel DST frames that use per-channel maps.
      const unsigned bitCount = static_cast<unsigned>(std::bit_width(table->elements));
      unsigned value = 0;
      if (!bits.getBits(bitCount, &value, error)) return false;
      if (value == table->elements) {
        ++table->elements;
        if (table->elements >= kDstMaxElements) {
          if (error) *error = "Invalid DST map";
          return false;
        }
      } else if (value > table->elements) {
        if (error) *error = "Invalid DST map";
        return false;
      }
      (*map)[static_cast<size_t>(ch)] = value;
    }
  } else {
    map->fill(0);
  }
  return true;
}

int getSrGolombDst(BitReader& bits, unsigned k, std::string* error) {
  unsigned unaryCount = 0;
  while (true) {
    unsigned bit = 0;
    if (!bits.getBit(&bit, error)) return 0;
    if (bit) break;
    ++unaryCount;
  }
  unsigned suffix = 0;
  if (k > 0 && !bits.getBits(k, &suffix, error)) return 0;
  int value = static_cast<int>((unaryCount << k) | suffix);
  unsigned sign = 0;
  if (value != 0 && !bits.getBit(&sign, error)) return 0;
  if (value != 0 && sign) value = -value;
  return value;
}

bool readUnsignedOrSignedCoeffs(BitReader& bits, int* dst, unsigned elements, int coeffBits, bool isSigned, int offset, std::string* error) {
  for (unsigned i = 0; i < elements; ++i) {
    int value = 0;
    if (isSigned) {
      if (!bits.getSignedBits(static_cast<unsigned>(coeffBits), &value, error)) return false;
    } else {
      unsigned raw = 0;
      if (!bits.getBits(static_cast<unsigned>(coeffBits), &raw, error)) return false;
      value = static_cast<int>(raw);
    }
    dst[i] = value + offset;
  }
  return true;
}

bool readTable(BitReader& bits,
               Table* table,
               const std::array<std::array<int8_t, 3>, 3>& codePredCoeff,
               int lengthBits,
               int coeffBits,
               bool isSigned,
               int offset,
               std::string* error) {
  for (unsigned i = 0; i < table->elements; ++i) {
    unsigned length = 0;
    if (!bits.getBits(static_cast<unsigned>(lengthBits), &length, error)) return false;
    table->length[i] = length + 1U;
    unsigned coded = 0;
    if (!bits.getBit(&coded, error)) return false;
    if (!coded) {
      if (!readUnsignedOrSignedCoeffs(bits, table->coeff[i].data(), table->length[i], coeffBits, isSigned, offset, error)) return false;
      continue;
    }

    unsigned method = 0;
    if (!bits.getBits(2U, &method, error)) return false;
    if (method == 3U) {
      if (error) *error = "Invalid DST method";
      return false;
    }

    if (!readUnsignedOrSignedCoeffs(bits, table->coeff[i].data(), method + 1U, coeffBits, isSigned, offset, error)) return false;

    unsigned lsbSize = 0;
    if (!bits.getBits(3U, &lsbSize, error)) return false;
    for (unsigned j = method + 1U; j < table->length[i]; ++j) {
      int predictor = 0;
      for (unsigned k = 0; k < method + 1U; ++k) {
        predictor += codePredCoeff[method][k] * table->coeff[i][j - k - 1U];
      }
      int residual = getSrGolombDst(bits, lsbSize, error);
      if (predictor >= 0) {
        residual -= (predictor + 4) / 8;
      } else {
        residual += (-predictor + 3) / 8;
      }
      if (!isSigned && (residual < offset || residual >= offset + (1 << coeffBits))) {
        if (error) *error = "Invalid DST coefficient";
        return false;
      }
      table->coeff[i][j] = residual;
    }
  }
  return true;
}

bool acGet(ArithCoder* ac, BitReader& bits, int probability, int* bit, std::string* error) {
  const unsigned k = (ac->a >> 8) | ((ac->a >> 7) & 1U);
  const unsigned q = k * static_cast<unsigned>(probability);
  const unsigned aQ = ac->a - q;

  *bit = ac->c < aQ ? 1 : 0;
  if (*bit) {
    ac->a = aQ;
  } else {
    ac->a = q;
    ac->c -= aQ;
  }

  if (ac->a < 2048U) {
    // FFmpeg: n = 11 - av_log2(ac->a), where av_log2(x) = floor(log2(x)) for x>0
    // (and 0 for x==0). 31 - countl_zero(x) reproduces floor(log2(x)) for x>0.
    const unsigned log2a = (ac->a == 0U) ? 0U : (31U - static_cast<unsigned>(std::countl_zero(ac->a)));
    const unsigned n = 11U - log2a;
    ac->a <<= n;
    unsigned extra = 0;
    if (!bits.getBits(n, &extra, error)) return false;
    ac->c = (ac->c << n) | extra;
  }
  return true;
}

bool buildFilter(DecoderState* state, std::string* error) {
  for (unsigned i = 0; i < state->fsets.elements; ++i) {
    const unsigned length = state->fsets.length[i];
    for (unsigned j = 0; j < 16; ++j) {
      const unsigned total = std::clamp<int>(static_cast<int>(length) - static_cast<int>(j * 8U), 0, 8);
      for (unsigned k = 0; k < 256; ++k) {
        int64_t predicted = 0;
        for (unsigned l = 0; l < total; ++l) {
          predicted += (((k >> l) & 1U) * 2 - 1) * state->fsets.coeff[i][j * 8U + l];
        }
        if (predicted < std::numeric_limits<int16_t>::min() || predicted > std::numeric_limits<int16_t>::max()) {
          if (error) *error = "Invalid DST filter";
          return false;
        }
        state->filter[i][j][k] = static_cast<int16_t>(predicted);
      }
    }
  }
  return true;
}

void resetStatus(std::array<std::array<uint8_t, 16>, kDstMaxChannels>& status) {
  for (auto& channelStatus : status) {
    channelStatus.fill(0xAA);
  }
}

void clearFrame(uint8_t* out, size_t size) {
  std::memset(out, 0, size);
}

bool decodeCompressedFrame(DecoderState* state,
                           const uint8_t* dstFrameBytes,
                           size_t dstFrameSize,
                           uint8_t* dsdOut,
                           size_t dsdOutSize,
                           size_t* bytesWritten,
                           std::string* error) {
  std::array<unsigned, kDstMaxChannels> mapChToFelem{};
  std::array<unsigned, kDstMaxChannels> mapChToPelem{};
  std::array<unsigned, kDstMaxChannels> halfProb{};
  int dstXBit = 0;

  if (!state->bits.init(dstFrameBytes, dstFrameSize, error)) return false;

  unsigned firstBit = 0;
  if (!state->bits.getBit(&firstBit, error)) return false;
  if (!firstBit) {
    unsigned ignored = 0;
    if (!state->bits.getBit(&ignored, error)) return false;
    unsigned reserved = 0;
    if (!state->bits.getBits(6U, &reserved, error)) return false;
    if (reserved != 0U) {
      if (error) *error = "Invalid uncompressed DST frame";
      return false;
    }
    const size_t expectedBytes = state->frameBytesPerChannel * static_cast<size_t>(state->channels);
    if (dstFrameSize < 1U + expectedBytes) {
      if (error) *error = "Uncompressed DST frame is too small";
      return false;
    }
    std::memcpy(dsdOut, dstFrameBytes + 1, expectedBytes);
    *bytesWritten = expectedBytes;
    return true;
  }

  unsigned sameSegmentation = 0;
  if (!state->bits.getBit(&sameSegmentation, error) || !sameSegmentation) {
    if (error) *error = "Unsupported DST segmentation";
    return false;
  }
  unsigned sameSegmentationAll = 0;
  if (!state->bits.getBit(&sameSegmentationAll, error) || !sameSegmentationAll) {
    if (error) *error = "Unsupported DST segmentation";
    return false;
  }
  unsigned endOfChannelSegmentation = 0;
  if (!state->bits.getBit(&endOfChannelSegmentation, error) || !endOfChannelSegmentation) {
    if (error) *error = "Unsupported DST segmentation";
    return false;
  }

  unsigned sameMap = 0;
  if (!state->bits.getBit(&sameMap, error)) return false;
  if (!readMap(state->bits, &state->fsets, &mapChToFelem, state->channels, error)) return false;
  if (sameMap) {
    state->probs.elements = state->fsets.elements;
    mapChToPelem = mapChToFelem;
  } else {
    if (!readMap(state->bits, &state->probs, &mapChToPelem, state->channels, error)) return false;
  }

  for (int ch = 0; ch < state->channels; ++ch) {
    unsigned half = 0;
    if (!state->bits.getBit(&half, error)) return false;
    halfProb[static_cast<size_t>(ch)] = half;
  }

  if (!readTable(state->bits, &state->fsets, kFsetsCodePredCoeff, 7, 9, true, 0, error)) return false;
  if (!readTable(state->bits, &state->probs, kProbsCodePredCoeff, 6, 7, false, 1, error)) return false;

  unsigned trailingZero = 0;
  if (!state->bits.getBit(&trailingZero, error) || trailingZero != 0U) {
    if (error) *error = "Invalid DST arithmetic stream";
    return false;
  }

  unsigned c12 = 0;
  if (!state->bits.getBits(12U, &c12, error)) return false;
  state->ac.a = 4095;
  state->ac.c = c12;

  if (!buildFilter(state, error)) return false;
  resetStatus(state->status);
  clearFrame(dsdOut, dsdOutSize);

  if (!acGet(&state->ac, state->bits, static_cast<int>(probDstXBit(state->fsets.coeff[0][0])), &dstXBit, error)) {
    return false;
  }

  const size_t bitCountPerChannel = bitsPerChannelForFrame(state->frameBytesPerChannel);
  if (dsdOutSize < static_cast<size_t>(state->channels) * state->frameBytesPerChannel) {
    if (error) *error = "DST output buffer is too small";
    return false;
  }

  for (size_t i = 0; i < bitCountPerChannel; ++i) {
    for (int ch = 0; ch < state->channels; ++ch) {
      const unsigned felem = mapChToFelem[static_cast<size_t>(ch)];
      auto& filter = state->filter[felem];
      auto& status = state->status[static_cast<size_t>(ch)];

      int predict = 0;
      for (int tap = 0; tap < 16; ++tap) {
        predict += filter[static_cast<size_t>(tap)][status[static_cast<size_t>(tap)]];
      }

      int probability = 128;
      if (!halfProb[static_cast<size_t>(ch)] || i >= state->fsets.length[felem]) {
        const unsigned pelem = mapChToPelem[static_cast<size_t>(ch)];
        const unsigned index = static_cast<unsigned>(std::abs(predict) >> 3);
        const unsigned probIndex = std::min(index, state->probs.length[pelem] - 1U);
        probability = state->probs.coeff[pelem][probIndex];
      }

      int residual = 0;
      if (!acGet(&state->ac, state->bits, probability, &residual, error)) return false;
      const int v = ((predict >> 15) ^ residual) & 1;
      dsdOut[(i >> 3U) * static_cast<size_t>(state->channels) + static_cast<size_t>(ch)] |= static_cast<uint8_t>(v << (7U - (i & 7U)));

      for (int idx = 15; idx > 0; --idx) {
        status[static_cast<size_t>(idx)] = static_cast<uint8_t>((status[static_cast<size_t>(idx)] << 1U) |
                                                                 ((status[static_cast<size_t>(idx - 1)] >> 7U) & 1U));
      }
      status[0] = static_cast<uint8_t>((status[0] << 1U) | static_cast<uint8_t>(v & 1));
    }
  }

  *bytesWritten = static_cast<size_t>(state->channels) * state->frameBytesPerChannel;
  return true;
}

size_t frameBytesPerChannelForRateInternal(int sampleRate) {
  if (sampleRate <= 0 || sampleRate % kSacdSampleRateBase != 0) return 0;
  const int dsdRate = sampleRate / kSacdSampleRateBase;
  if (dsdRate != 64 && dsdRate != 128 && dsdRate != 256 && dsdRate != 512) return 0;
  return static_cast<size_t>(588U * static_cast<unsigned>(dsdRate) / 8U);
}

}  // namespace

size_t frameBytesPerChannelForSampleRate(int sampleRate) {
  return frameBytesPerChannelForRateInternal(sampleRate);
}

bool decodeFrame(const uint8_t* dstFrameBytes,
                 size_t dstFrameSize,
                 int channels,
                 int sampleRate,
                 uint8_t* dsdOut,
                 size_t dsdOutSize,
                 size_t* bytesWritten,
                 std::string* error) {
  if (bytesWritten) *bytesWritten = 0;
  if (!dstFrameBytes || !dsdOut) {
    if (error) *error = "DST buffers must not be null";
    return false;
  }
  if (channels <= 0 || channels > kDstMaxChannels) {
    if (error) *error = "DST channel count must be between 1 and 6";
    return false;
  }

  DecoderState state;
  state.channels = channels;
  state.sampleRate = sampleRate;
  state.frameBytesPerChannel = frameBytesPerChannelForRateInternal(sampleRate);
  if (state.frameBytesPerChannel == 0) {
    if (error) *error = "Unsupported DST sample rate";
    return false;
  }

  const size_t expectedBytes = state.frameBytesPerChannel * static_cast<size_t>(channels);
  if (dsdOutSize < expectedBytes) {
    if (error) *error = "DST output buffer is too small";
    return false;
  }

  return decodeCompressedFrame(&state, dstFrameBytes, dstFrameSize, dsdOut, dsdOutSize, bytesWritten, error);
}

}  // namespace twilight::audio::dstdec
