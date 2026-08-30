#pragma once

#include "../core/AudioTypes.h"
#include "SacdIsoDemuxer.h"

#include <cstddef>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

namespace twilight::audio {

class SacdDstDecoderProvider;

enum class DsdBitOrder {
  LsbFirst,
  MsbFirst
};

enum class DsdPacking {
  DsfPlanarBlocks,
  DffInterleaved
};

struct DsdStreamInfo {
  std::string source;
  std::string container;
  int channelCount = 0;
  int dsdSampleRate = 0;
  int dsdRate = 0;
  DsdBitOrder bitOrder = DsdBitOrder::LsbFirst;
  DsdPacking packing = DsdPacking::DsfPlanarBlocks;
  double durationSeconds = 0.0;
  uint64_t dataOffset = 0;
  uint64_t dataSize = 0;
  uint32_t blockSizePerChannel = 0;
};

bool sourceLooksDsfOrDff(const std::string& source);
bool sourceLooksSacdIso(const std::string& source);
int inferDsdRateFromSampleRate(int sampleRate);

class DsdReader {
 public:
  DsdReader();
  ~DsdReader();

  DsdReader(const DsdReader&) = delete;
  DsdReader& operator=(const DsdReader&) = delete;

  bool open(const std::string& source, std::string* error);
  void close();
  bool seek(double seconds, std::string* error);
  size_t readBytes(uint8_t* output, size_t maxBytes);
  bool eof() const;

  const DsdStreamInfo& streamInfo() const;

  // Forward a DSD-preserving DST decoder provider to the SACD ISO demuxer so
  // DST-compressed tracks become playable. Also enables DST-compressed DFF
  // (DSDIFF) decoding inside this reader. No-op for DSF and uncompressed DFF.
  void setDstDecoderProvider(SacdDstDecoderProvider* provider);

 private:
  struct DstFrameEntry {
    uint64_t offset = 0;
    uint64_t size = 0;
  };

  bool openDsf(std::string* error);
  bool openDff(std::string* error);
  bool openSacdIso(const std::string& source, std::string* error);
  size_t readDstBytes(uint8_t* output, size_t maxBytes);

  std::ifstream file_;
  SacdIsoDemuxer sacd_;
  SacdDstDecoderProvider* dstProvider_ = nullptr;
  DsdStreamInfo info_;
  uint64_t readOffset_ = 0;
  bool eof_ = false;
  bool sacdActive_ = false;
  // DST-compressed DFF state: the DST sound chunk is a sequence of DSTF
  // sub-chunks, each an independently decodable access unit. Frames are
  // decoded on demand into decodedDsdBuffer_ and drained from there.
  bool dstActive_ = false;
  int dstFrameRate_ = 0;
  size_t dstFrameIndex_ = 0;
  size_t decodedOffset_ = 0;
  size_t decodedSize_ = 0;
  std::vector<DstFrameEntry> dstFrames_;
  std::vector<uint8_t> decodedDsdBuffer_;
  std::vector<uint8_t> compressedFrameBuffer_;
};

}  // namespace twilight::audio
