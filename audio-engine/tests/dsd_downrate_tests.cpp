#include "dsp/DsdDownrateProcessor.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <new>
#include <string>
#include <vector>

using namespace twilight::audio;

namespace {
size_t allocationCount = 0;
bool countAllocations = false;
}

void* operator new(std::size_t size) {
  if (countAllocations) ++allocationCount;
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void operator delete(void* memory) noexcept {
  std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept {
  std::free(memory);
}

namespace {

uint8_t reverseBits(uint8_t value) {
  value = static_cast<uint8_t>((value >> 4) | (value << 4));
  value = static_cast<uint8_t>(((value & 0xcc) >> 2) | ((value & 0x33) << 2));
  return static_cast<uint8_t>(((value & 0xaa) >> 1) | ((value & 0x55) << 1));
}

std::vector<uint8_t> makeDensityInput(size_t byteFrames, int channels, double density) {
  std::vector<uint8_t> result(byteFrames * static_cast<size_t>(channels));
  std::vector<double> error(static_cast<size_t>(channels));
  for (size_t frame = 0; frame < byteFrames; ++frame) {
    for (int channel = 0; channel < channels; ++channel) {
      uint8_t byte = 0;
      for (int bit = 0; bit < 8; ++bit) {
        const double shaped = density + error[static_cast<size_t>(channel)];
        const double quantized = shaped >= 0.0 ? 1.0 : -1.0;
        error[static_cast<size_t>(channel)] = shaped - quantized;
        byte = static_cast<uint8_t>((byte << 1) | (quantized > 0.0 ? 1 : 0));
      }
      result[frame * static_cast<size_t>(channels) + static_cast<size_t>(channel)] = byte;
    }
  }
  return result;
}

double meanDensity(const std::vector<uint8_t>& bytes, int channels, int channel, size_t skipFrames = 0) {
  double sum = 0.0;
  size_t count = 0;
  for (size_t frame = skipFrames; frame < bytes.size() / static_cast<size_t>(channels); ++frame) {
    const uint8_t byte = bytes[frame * static_cast<size_t>(channels) + static_cast<size_t>(channel)];
    for (int bit = 0; bit < 8; ++bit) {
      sum += ((byte >> (7 - bit)) & 1U) ? 1.0 : -1.0;
      ++count;
    }
  }
  return count == 0 ? 0.0 : sum / static_cast<double>(count);
}

std::vector<uint8_t> run(
    const DsdDownrateConfig& config,
    const std::vector<uint8_t>& input,
    const std::vector<size_t>& chunks = {}) {
  DsdDownrateProcessor processor;
  std::string error;
  assert(processor.configure(config, &error));
  const size_t inputFrames = input.size() / static_cast<size_t>(config.channelCount);
  std::vector<uint8_t> output(
      processor.maximumOutputByteFrames(inputFrames) * static_cast<size_t>(config.channelCount));
  size_t inputOffset = 0;
  size_t outputFrames = 0;
  size_t chunkIndex = 0;
  while (inputOffset < inputFrames) {
    const size_t requested = chunks.empty() ? inputFrames : chunks[chunkIndex++ % chunks.size()];
    const size_t frames = std::min(requested, inputFrames - inputOffset);
    outputFrames += processor.process(
        input.data() + inputOffset * static_cast<size_t>(config.channelCount),
        frames,
        output.data() + outputFrames * static_cast<size_t>(config.channelCount),
        output.size() / static_cast<size_t>(config.channelCount) - outputFrames);
    inputOffset += frames;
  }
  output.resize(outputFrames * static_cast<size_t>(config.channelCount));
  return output;
}

void testRatesAndFamilies() {
  for (const int base : {44100, 48000}) {
    for (const int sourceMultiplier : {128, 256, 512}) {
      for (int targetMultiplier = sourceMultiplier / 2; targetMultiplier >= 64;
           targetMultiplier /= 2) {
        DsdDownrateProcessor processor;
        std::string error;
        assert(processor.configure(
            {base * sourceMultiplier, base * targetMultiplier, 2, DsdBitOrder::MsbFirst,
             DsdBitOrder::MsbFirst},
            &error));
        assert(processor.decimationRatio() == sourceMultiplier / targetMultiplier);
      }
    }
  }
}

void testBitOrderAndPackingNormalization() {
  const auto msb = makeDensityInput(4096, 2, 0.2);
  auto lsb = msb;
  for (uint8_t& byte : lsb) byte = reverseBits(byte);
  const DsdDownrateConfig msbConfig{
      44100 * 256, 44100 * 64, 2, DsdBitOrder::MsbFirst, DsdBitOrder::MsbFirst};
  const DsdDownrateConfig lsbConfig{
      44100 * 256, 44100 * 64, 2, DsdBitOrder::LsbFirst, DsdBitOrder::MsbFirst};
  assert(run(msbConfig, msb) == run(lsbConfig, lsb));

  std::vector<uint8_t> dsfPlanar;
  dsfPlanar.reserve(msb.size());
  for (size_t block = 0; block < 4096; block += 257) {
    const size_t frames = std::min<size_t>(257, 4096 - block);
    for (int channel = 0; channel < 2; ++channel) {
      for (size_t frame = 0; frame < frames; ++frame) {
        dsfPlanar.push_back(msb[(block + frame) * 2 + static_cast<size_t>(channel)]);
      }
    }
  }
  std::vector<uint8_t> normalized;
  normalized.reserve(msb.size());
  size_t offset = 0;
  for (size_t block = 0; block < 4096; block += 257) {
    const size_t frames = std::min<size_t>(257, 4096 - block);
    for (size_t frame = 0; frame < frames; ++frame) {
      for (int channel = 0; channel < 2; ++channel) {
        normalized.push_back(dsfPlanar[offset + static_cast<size_t>(channel) * frames + frame]);
      }
    }
    offset += frames * 2;
  }
  assert(run(msbConfig, msb) == run(msbConfig, normalized));
}

void testArbitraryChunksAndReset() {
  const auto input = makeDensityInput(8192, 2, -0.15);
  const DsdDownrateConfig config{
      48000 * 512, 48000 * 64, 2, DsdBitOrder::MsbFirst, DsdBitOrder::MsbFirst};
  const auto whole = run(config, input);
  assert(whole == run(config, input, {1, 7, 31, 3, 257, 19}));

  DsdDownrateProcessor processor;
  std::string error;
  assert(processor.configure(config, &error));
  std::vector<uint8_t> first(processor.maximumOutputByteFrames(8192) * 2);
  const size_t firstFrames = processor.process(input.data(), 8192, first.data(), first.size() / 2);
  processor.reset();
  std::vector<uint8_t> second(first.size());
  const size_t secondFrames = processor.process(input.data(), 8192, second.data(), second.size() / 2);
  assert(firstFrames == secondFrames);
  assert(first == second);
}

void testFilterAndNoiseStability() {
  const DsdDownrateConfig config{
      44100 * 512, 44100 * 64, 2, DsdBitOrder::MsbFirst, DsdBitOrder::MsbFirst};
  const auto positive = run(config, makeDensityInput(32768, 2, 0.25));
  assert(std::abs(meanDensity(positive, 2, 0, 16) - 0.25) < 0.04);
  assert(std::abs(meanDensity(positive, 2, 1, 16) - 0.25) < 0.04);

  std::vector<uint8_t> stopband(32768 * 2);
  for (size_t frame = 0; frame < 32768; ++frame) {
    const uint8_t byte = frame % 2 == 0 ? 0x0f : 0xf0;
    stopband[frame * 2] = byte;
    stopband[frame * 2 + 1] = byte;
  }
  const auto filtered = run(config, stopband);
  assert(std::abs(meanDensity(filtered, 2, 0, 16)) < 0.02);

  const auto silence = run(config, makeDensityInput(32768, 2, 0.0));
  assert(std::abs(meanDensity(silence, 2, 0, 16)) < 0.02);
  assert(std::any_of(silence.begin(), silence.end(), [](uint8_t byte) {
    return byte != 0x00 && byte != 0xff;
  }));
}

void testNoProcessAllocation() {
  DsdDownrateProcessor processor;
  std::string error;
  assert(processor.configure(
      {44100 * 256, 44100 * 64, 2, DsdBitOrder::MsbFirst, DsdBitOrder::MsbFirst},
      &error));
  const auto input = makeDensityInput(4096, 2, 0.1);
  std::array<uint8_t, 2048> output{};
  allocationCount = 0;
  countAllocations = true;
  const size_t written = processor.process(input.data(), 4096, output.data(), 1024);
  countAllocations = false;
  assert(written == 1024);
  assert(allocationCount == 0);
}

}  // namespace

int main() {
  testRatesAndFamilies();
  testBitOrderAndPackingNormalization();
  testArbitraryChunksAndReset();
  testFilterAndNoiseStability();
  testNoProcessAllocation();
  return 0;
}
