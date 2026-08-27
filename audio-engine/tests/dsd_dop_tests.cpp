#include "../decoder/DopPacker.h"
#include "../decoder/DopPackerUtils.h"
#include "../decoder/DsdReader.h"
#include "../decoder/SacdIsoDemuxer.h"
#include "../decoder/SacdIsoDemuxerUtils.h"
#include "../decoder/SacdIsoProbe.h"
#include "../core/AudioPipelineDsdUtils.h"

#include <cassert>
#include <array>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numeric>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using namespace twilight::audio;

namespace {

void testSacdIsoByteScratchResizePreservesSameSizedScratch() {
  std::vector<uint8_t> scratch = {0x11, 0x22, 0x33};
  const uint8_t* before = scratch.data();

  sacd::resizeByteScratchForOverwrite(scratch, scratch.size());

  assert(scratch.data() == before);
  assert((scratch == std::vector<uint8_t>{0x11, 0x22, 0x33}));
}

std::string readTextFile(const std::filesystem::path& path) {
  std::ifstream input(path);
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

[[noreturn]] void failTest(const char* message) {
  std::cerr << message << '\n';
  std::abort();
}

void testSacdDstDecodePathDoesNotPreclearDecodedFrameBuffer() {
  const std::filesystem::path sourcePath =
      std::filesystem::path(__FILE__).parent_path().parent_path() / "decoder" / "SacdIsoDemuxer.cpp";
  const std::string source = readTextFile(sourcePath);

  if (source.empty() || source.find("decodedDsdBuffer.assign(decodedFrameBytes, 0)") != std::string::npos) {
    failTest("SacdIsoDemuxer DST decode path still preclears decodedDsdBuffer");
  }
}

void writeLe16(std::ofstream& out, uint16_t value) {
  out.put(static_cast<char>(value & 0xff));
  out.put(static_cast<char>((value >> 8) & 0xff));
}

void writeLe32(std::ofstream& out, uint32_t value) {
  writeLe16(out, static_cast<uint16_t>(value & 0xffff));
  writeLe16(out, static_cast<uint16_t>((value >> 16) & 0xffff));
}

void writeLe64(std::ofstream& out, uint64_t value) {
  writeLe32(out, static_cast<uint32_t>(value & 0xffffffffULL));
  writeLe32(out, static_cast<uint32_t>((value >> 32) & 0xffffffffULL));
}

void writeLe32To(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>(value & 0xff);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  data[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

void writeBe32To(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>((value >> 24) & 0xff);
  data[1] = static_cast<uint8_t>((value >> 16) & 0xff);
  data[2] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[3] = static_cast<uint8_t>(value & 0xff);
}

void writeTwilightTrack(
    std::vector<uint8_t>& toc,
    size_t offset,
    int trackNumber,
    uint32_t startSector,
    uint32_t sectorCount,
    uint32_t channelCount,
    uint32_t sampleRate,
    bool dst,
    const std::string& fileName) {
  assert(offset + 64 <= toc.size());
  std::memcpy(toc.data() + offset, "TWTE1", 5);
  writeLe32To(toc.data() + offset + 8, static_cast<uint32_t>(trackNumber));
  writeLe32To(toc.data() + offset + 12, startSector);
  writeLe32To(toc.data() + offset + 16, sectorCount);
  writeLe32To(toc.data() + offset + 20, channelCount);
  writeLe32To(toc.data() + offset + 24, sampleRate);
  writeLe32To(toc.data() + offset + 28, dst ? 1U : 0U);
  std::copy(fileName.begin(), fileName.end(), toc.begin() + static_cast<std::ptrdiff_t>(offset + 32));
}

void writeTwilightDstFrameTable(
    std::vector<uint8_t>& toc,
    size_t offset,
    int trackNumber,
    const std::vector<uint32_t>& frameSizes) {
  assert(offset + 16 + frameSizes.size() * 4 <= toc.size());
  std::memcpy(toc.data() + offset, "TWDSTFRM", 8);
  writeLe32To(toc.data() + offset + 8, static_cast<uint32_t>(trackNumber));
  writeLe32To(toc.data() + offset + 12, static_cast<uint32_t>(frameSizes.size()));
  for (size_t index = 0; index < frameSizes.size(); ++index) {
    writeLe32To(toc.data() + offset + 16 + index * 4, frameSizes[index]);
  }
}

void writeDirectoryRecord(
    std::vector<uint8_t>& directory,
    size_t offset,
    uint32_t extent,
    uint32_t size,
    bool isDirectory,
    const std::string& name) {
  const size_t nameLength = name.size();
  const size_t recordLength = 33 + nameLength + ((nameLength % 2) == 0 ? 1 : 0);
  assert(offset + recordLength <= directory.size());
  directory[offset] = static_cast<uint8_t>(recordLength);
  writeLe32To(directory.data() + offset + 2, extent);
  writeBe32To(directory.data() + offset + 6, extent);
  writeLe32To(directory.data() + offset + 10, size);
  writeBe32To(directory.data() + offset + 14, size);
  directory[offset + 25] = isDirectory ? 0x02 : 0x00;
  directory[offset + 28] = 1;
  directory[offset + 31] = 1;
  directory[offset + 32] = static_cast<uint8_t>(nameLength);
  std::copy(name.begin(), name.end(), directory.begin() + static_cast<std::ptrdiff_t>(offset + 33));
}

void writeSpecialDirectoryRecord(
    std::vector<uint8_t>& directory,
    size_t offset,
    uint32_t extent,
    uint32_t size,
    uint8_t name) {
  directory[offset] = 34;
  writeLe32To(directory.data() + offset + 2, extent);
  writeBe32To(directory.data() + offset + 6, extent);
  writeLe32To(directory.data() + offset + 10, size);
  writeBe32To(directory.data() + offset + 14, size);
  directory[offset + 25] = 0x02;
  directory[offset + 28] = 1;
  directory[offset + 31] = 1;
  directory[offset + 32] = 1;
  directory[offset + 33] = name;
}

void writeBe16(std::ofstream& out, uint16_t value) {
  out.put(static_cast<char>((value >> 8) & 0xff));
  out.put(static_cast<char>(value & 0xff));
}

void writeBe32(std::ofstream& out, uint32_t value) {
  writeBe16(out, static_cast<uint16_t>((value >> 16) & 0xffff));
  writeBe16(out, static_cast<uint16_t>(value & 0xffff));
}

void writeBe64(std::ofstream& out, uint64_t value) {
  writeBe32(out, static_cast<uint32_t>((value >> 32) & 0xffffffffULL));
  writeBe32(out, static_cast<uint32_t>(value & 0xffffffffULL));
}

std::filesystem::path writeDsfFixture(const std::string& name, int sampleRate = 2822400) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kChannels = 2;
  constexpr uint32_t kBlockSizePerChannel = 8;
  constexpr uint64_t kDataBytes = static_cast<uint64_t>(kChannels) * kBlockSizePerChannel;
  constexpr uint64_t kFileSize = 28 + 52 + 12 + kDataBytes;

  std::ofstream out(path, std::ios::binary);
  out.write("DSD ", 4);
  writeLe64(out, 28);
  writeLe64(out, kFileSize);
  writeLe64(out, 0);
  out.write("fmt ", 4);
  writeLe64(out, 52);
  writeLe32(out, 1);
  writeLe32(out, 0);
  writeLe32(out, 2);
  writeLe32(out, kChannels);
  writeLe32(out, static_cast<uint32_t>(sampleRate));
  writeLe32(out, 1);
  writeLe64(out, kBlockSizePerChannel * 8);
  writeLe32(out, kBlockSizePerChannel);
  writeLe32(out, 0);
  out.write("data", 4);
  writeLe64(out, 12 + kDataBytes);
  for (uint8_t byte : {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88}) out.put(static_cast<char>(byte));
  for (uint8_t byte : {0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xf0, 0x0f}) out.put(static_cast<char>(byte));
  return path;
}

std::filesystem::path writeTwoBlockDsfFixture(const std::string& name, int sampleRate = 2822400) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kChannels = 2;
  constexpr uint32_t kBlockSizePerChannel = 4;
  constexpr uint32_t kBlockCount = 2;
  constexpr uint64_t kDataBytes =
      static_cast<uint64_t>(kChannels) * kBlockSizePerChannel * kBlockCount;
  constexpr uint64_t kFileSize = 28 + 52 + 12 + kDataBytes;

  std::ofstream out(path, std::ios::binary);
  out.write("DSD ", 4);
  writeLe64(out, 28);
  writeLe64(out, kFileSize);
  writeLe64(out, 0);
  out.write("fmt ", 4);
  writeLe64(out, 52);
  writeLe32(out, 1);
  writeLe32(out, 0);
  writeLe32(out, 2);
  writeLe32(out, kChannels);
  writeLe32(out, static_cast<uint32_t>(sampleRate));
  writeLe32(out, 1);
  writeLe64(out, static_cast<uint64_t>(kBlockSizePerChannel) * kBlockCount * 8);
  writeLe32(out, kBlockSizePerChannel);
  writeLe32(out, 0);
  out.write("data", 4);
  writeLe64(out, 12 + kDataBytes);
  for (uint8_t byte : {0x10, 0x11, 0x12, 0x13}) out.put(static_cast<char>(byte));
  for (uint8_t byte : {0x20, 0x21, 0x22, 0x23}) out.put(static_cast<char>(byte));
  for (uint8_t byte : {0x30, 0x31, 0x32, 0x33}) out.put(static_cast<char>(byte));
  for (uint8_t byte : {0x40, 0x41, 0x42, 0x43}) out.put(static_cast<char>(byte));
  return path;
}

std::filesystem::path writeMalformedDsfFixture(
    const std::string& name,
    uint32_t sampleRate,
    uint32_t channels,
    uint32_t blockSizePerChannel,
    uint64_t dataBytes) {
  const auto path = std::filesystem::temp_directory_path() / name;
  const uint64_t fileSize = 28 + 52 + 12 + dataBytes;

  std::ofstream out(path, std::ios::binary);
  out.write("DSD ", 4);
  writeLe64(out, 28);
  writeLe64(out, fileSize);
  writeLe64(out, 0);
  out.write("fmt ", 4);
  writeLe64(out, 52);
  writeLe32(out, 1);
  writeLe32(out, 0);
  writeLe32(out, 2);
  writeLe32(out, channels);
  writeLe32(out, sampleRate);
  writeLe32(out, 1);
  writeLe64(out, dataBytes * 8 / std::max<uint32_t>(1, channels));
  writeLe32(out, blockSizePerChannel);
  writeLe32(out, 0);
  out.write("data", 4);
  writeLe64(out, 12 + dataBytes);
  for (uint64_t i = 0; i < dataBytes; ++i) out.put(static_cast<char>(0x80 + (i & 0x0f)));
  return path;
}

std::filesystem::path writeDffFixtureAt(const std::filesystem::path& path) {
  const uint64_t propPayload = 4 + (12 + 4) + (12 + 2);
  const uint64_t dsdPayload = 16;
  const uint64_t formSize = 4 + (12 + propPayload) + (12 + dsdPayload);

  std::ofstream out(path, std::ios::binary);
  out.write("FRM8", 4);
  writeBe64(out, formSize);
  out.write("DSD ", 4);
  out.write("PROP", 4);
  writeBe64(out, propPayload);
  out.write("SND ", 4);
  out.write("FS  ", 4);
  writeBe64(out, 4);
  writeBe32(out, 5644800);
  out.write("CHNL", 4);
  writeBe64(out, 2);
  writeBe16(out, 2);
  out.write("DSD ", 4);
  writeBe64(out, dsdPayload);
  for (int i = 0; i < 16; ++i) out.put(static_cast<char>(0x80 + i));
  return path;
}

std::filesystem::path writeDffFixture(const std::string& name) {
  return writeDffFixtureAt(std::filesystem::temp_directory_path() / name);
}

// DST-compressed DFF (FRM8 form type 'DST ' + CMPR "DST"): two 8-byte DSTF
// frames whose first byte identifies them, so an echo provider's decoded
// output stays traceable to its source frame. FRTE declares 2 frames @ 75Hz.
std::filesystem::path writeDstDffFixture(const std::string& name) {
  const auto path = std::filesystem::temp_directory_path() / name;
  const std::vector<std::vector<uint8_t>> frames = {
      {0xA0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77},
      {0xB0, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE}};
  const uint64_t propPayload = 4 + (12 + 4) + (12 + 2) + (12 + 6);
  const uint64_t dstPayload = (12 + 6) + frames.size() * (12 + 8);
  const uint64_t formSize = 4 + (12 + 4) + (12 + propPayload) + (12 + dstPayload);

  std::ofstream out(path, std::ios::binary);
  out.write("FRM8", 4);
  writeBe64(out, formSize);
  out.write("DST ", 4);
  out.write("FVER", 4);
  writeBe64(out, 4);
  writeBe32(out, 0x01050000);
  out.write("PROP", 4);
  writeBe64(out, propPayload);
  out.write("SND ", 4);
  out.write("FS  ", 4);
  writeBe64(out, 4);
  writeBe32(out, 2822400);
  out.write("CHNL", 4);
  writeBe64(out, 2);
  writeBe16(out, 2);
  out.write("CMPR", 4);
  writeBe64(out, 6);
  out.write("DST ", 4);
  out.put(static_cast<char>(1));
  out.put('\0');
  out.write("DST ", 4);
  writeBe64(out, dstPayload);
  out.write("FRTE", 4);
  writeBe64(out, 6);
  writeBe32(out, static_cast<uint32_t>(frames.size()));
  writeBe16(out, 75);
  for (const auto& frame : frames) {
    out.write("DSTF", 4);
    writeBe64(out, frame.size());
    out.write(reinterpret_cast<const char*>(frame.data()), static_cast<std::streamsize>(frame.size()));
  }
  return path;
}

std::filesystem::path writeSacdIsoFixture(
    const std::string& name,
    uint32_t dstSampleRate = 2822400,
    const std::vector<uint32_t>& dstFrameSizes = {}) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kRootSector = 20;
  constexpr uint32_t kSacdSector = 21;
  constexpr uint32_t kSectorSize = 2048;
  std::vector<uint8_t> image(28 * kSectorSize, 0);
  const uint32_t dstPayloadSize =
      dstFrameSizes.empty()
          ? 256U
          : static_cast<uint32_t>(std::accumulate(dstFrameSizes.begin(), dstFrameSizes.end(), 0U));

  uint8_t* pvd = image.data() + 16 * kSectorSize;
  pvd[0] = 1;
  std::memcpy(pvd + 1, "CD001", 5);
  pvd[6] = 1;
  std::memcpy(pvd + 40, "TWILIGHT_SACD_FIXTURE", 21);
  pvd[80] = 28;
  writeLe32To(pvd + 156 + 2, kRootSector);
  writeBe32To(pvd + 156 + 6, kRootSector);
  writeLe32To(pvd + 156 + 10, kSectorSize);
  writeBe32To(pvd + 156 + 14, kSectorSize);
  pvd[156] = 34;
  pvd[156 + 25] = 0x02;
  pvd[156 + 28] = 1;
  pvd[156 + 31] = 1;
  pvd[156 + 32] = 1;

  uint8_t* terminator = image.data() + 17 * kSectorSize;
  terminator[0] = 255;
  std::memcpy(terminator + 1, "CD001", 5);
  terminator[6] = 1;

  std::vector<uint8_t> root(kSectorSize, 0);
  writeSpecialDirectoryRecord(root, 0, kRootSector, kSectorSize, 0);
  writeSpecialDirectoryRecord(root, 34, kRootSector, kSectorSize, 1);
  writeDirectoryRecord(root, 68, kSacdSector, kSectorSize, true, "SACD");
  std::copy(root.begin(), root.end(), image.begin() + kRootSector * kSectorSize);

  std::vector<uint8_t> sacd(kSectorSize, 0);
  writeSpecialDirectoryRecord(sacd, 0, kSacdSector, kSectorSize, 0);
  writeSpecialDirectoryRecord(sacd, 34, kRootSector, kSectorSize, 1);
  writeDirectoryRecord(sacd, 68, 22, 128, false, "MASTER.TOC");
  writeDirectoryRecord(sacd, 112, 23, 2048, false, "TWOCH_AREA.TOC");
  writeDirectoryRecord(sacd, 160, 24, 2048, false, "MCH_AREA.TOC");
  writeDirectoryRecord(sacd, 206, 25, 256, false, "TRACK01.DSD");
  writeDirectoryRecord(sacd, 250, 26, dstPayloadSize, false, "TRACK01.DST");
  std::copy(sacd.begin(), sacd.end(), image.begin() + kSacdSector * kSectorSize);

  std::vector<uint8_t> twoch(kSectorSize, 0);
  std::memcpy(twoch.data(), "TWTEAREA", 8);
  writeLe32To(twoch.data() + 8, 2);
  writeTwilightTrack(twoch, 16, 1, 25, 1, 2, 2822400, false, "TRACK01.DSD");
  writeTwilightTrack(twoch, 80, 2, 26, 1, 2, dstSampleRate, true, "TRACK01.DST");
  if (!dstFrameSizes.empty()) {
    writeTwilightDstFrameTable(twoch, 144, 2, dstFrameSizes);
  }
  std::copy(twoch.begin(), twoch.end(), image.begin() + 23 * kSectorSize);

  std::vector<uint8_t> mch(kSectorSize, 0);
  std::memcpy(mch.data(), "TWTEAREA", 8);
  writeLe32To(mch.data() + 8, 1);
  writeTwilightTrack(mch, 16, 1, 25, 1, 6, 2822400, false, "TRACK01.DSD");
  std::copy(mch.begin(), mch.end(), image.begin() + 24 * kSectorSize);

  for (int i = 0; i < 256; ++i) image[25 * kSectorSize + i] = static_cast<uint8_t>(0x80 + (i & 0x3f));
  if (dstFrameSizes.empty()) {
    for (int i = 0; i < 256; ++i) image[26 * kSectorSize + i] = static_cast<uint8_t>(0x40 + (i & 0x3f));
  } else {
    size_t offset = 0;
    for (size_t frameIndex = 0; frameIndex < dstFrameSizes.size(); ++frameIndex) {
      for (uint32_t byteIndex = 0; byteIndex < dstFrameSizes[frameIndex]; ++byteIndex) {
        image[26 * kSectorSize + offset + byteIndex] =
            static_cast<uint8_t>(0x40 + ((frameIndex * 0x10 + byteIndex) & 0x3f));
      }
      offset += dstFrameSizes[frameIndex];
    }
  }

  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(image.data()), static_cast<std::streamsize>(image.size()));
  return path;
}

void writeBe16To(uint8_t* data, uint16_t value) {
  data[0] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[1] = static_cast<uint8_t>(value & 0xff);
}

// Writes one Scarletbook audio sector at `sector` with a single audio packet
// carrying `payload`. Non-DST sectors carry a 3-byte frame-info entry, DST
// sectors a 4-byte one, matching the on-disc layout.
void writeScarletbookAudioSector(
    std::vector<uint8_t>& image,
    uint32_t lsn,
    bool dst,
    bool frameStart,
    const std::vector<uint8_t>& payload) {
  uint8_t* sector = image.data() + static_cast<size_t>(lsn) * 2048;
  // Header: packet_info_count=1 (bits 7-5), frame_info_count=1 (bits 4-2),
  // dst_encoded (bit 0).
  sector[0] = static_cast<uint8_t>(0x20 | 0x04 | (dst ? 0x01 : 0x00));
  // Packet info: frame_start (bit 15), data_type=2 audio (bits 13-11),
  // packet_length (bits 10-0).
  const uint16_t length = static_cast<uint16_t>(payload.size());
  sector[1] = static_cast<uint8_t>((frameStart ? 0x80 : 0x00) | (2 << 3) | ((length >> 8) & 0x07));
  sector[2] = static_cast<uint8_t>(length & 0xff);
  // Frame info: timecode (m/s/f) + DST channel byte.
  const size_t frameInfoSize = dst ? 4 : 3;
  const size_t payloadOffset = 1 + 2 + frameInfoSize;
  std::copy(payload.begin(), payload.end(), sector + payloadOffset);
}

// Builds a minimal spec-conformant Scarletbook SACD ISO: ISO9660 descriptor +
// SACD directory (probe requirements), Master TOC at LSN 510 ("SACDMTOC"),
// master text at 511 ("SACDText"), a 2CH area TOC at 520 and an MC area TOC
// at 530 with SACDTTxt / SACDTRL1 / SACDTRL2 sectors, and audio sectors.
std::filesystem::path writeScarletbookIsoFixture(const std::string& name, bool dstStereoArea) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr uint32_t kRootSector = 20;
  constexpr uint32_t kSacdSector = 21;
  constexpr uint32_t kSectorSize = 2048;
  constexpr uint32_t kTwoChTocLsn = 520;
  constexpr uint32_t kMcTocLsn = 530;
  constexpr uint32_t kTrack1Lsn = 540;
  constexpr uint32_t kTrack2Lsn = 542;
  constexpr uint32_t kMcTrackLsn = 544;
  std::vector<uint8_t> image(560 * kSectorSize, 0);

  // --- ISO9660 wrapper (satisfies the probe) ---
  uint8_t* pvd = image.data() + 16 * kSectorSize;
  pvd[0] = 1;
  std::memcpy(pvd + 1, "CD001", 5);
  pvd[6] = 1;
  writeLe32To(pvd + 156 + 2, kRootSector);
  writeBe32To(pvd + 156 + 6, kRootSector);
  writeLe32To(pvd + 156 + 10, kSectorSize);
  writeBe32To(pvd + 156 + 14, kSectorSize);
  pvd[156] = 34;
  pvd[156 + 25] = 0x02;
  pvd[156 + 28] = 1;
  pvd[156 + 31] = 1;
  pvd[156 + 32] = 1;
  uint8_t* terminator = image.data() + 17 * kSectorSize;
  terminator[0] = 255;
  std::memcpy(terminator + 1, "CD001", 5);
  terminator[6] = 1;

  std::vector<uint8_t> root(kSectorSize, 0);
  writeSpecialDirectoryRecord(root, 0, kRootSector, kSectorSize, 0);
  writeSpecialDirectoryRecord(root, 34, kRootSector, kSectorSize, 1);
  writeDirectoryRecord(root, 68, kSacdSector, kSectorSize, true, "SACD");
  std::copy(root.begin(), root.end(), image.begin() + kRootSector * kSectorSize);

  std::vector<uint8_t> sacd(kSectorSize, 0);
  writeSpecialDirectoryRecord(sacd, 0, kSacdSector, kSectorSize, 0);
  writeSpecialDirectoryRecord(sacd, 34, kRootSector, kSectorSize, 1);
  writeDirectoryRecord(sacd, 68, 510, 10 * kSectorSize, false, "MASTER.TOC");
  writeDirectoryRecord(sacd, 112, kTwoChTocLsn, 4 * kSectorSize, false, "TWOCH_AREA.TOC");
  writeDirectoryRecord(sacd, 160, kMcTocLsn, 4 * kSectorSize, false, "MCH_AREA.TOC");
  std::copy(sacd.begin(), sacd.end(), image.begin() + kSacdSector * kSectorSize);

  // --- Master TOC (LSN 510) ---
  uint8_t* mtoc = image.data() + 510 * kSectorSize;
  std::memcpy(mtoc, "SACDMTOC", 8);
  mtoc[8] = 1;   // version major
  mtoc[9] = 20;  // version minor
  std::memcpy(mtoc + 24, "TWILIGHT-0001", 13);  // album_catalog_number
  writeBe32To(mtoc + 64, kTwoChTocLsn);         // area_1_toc_1_start
  writeBe32To(mtoc + 72, kMcTocLsn);            // area_2_toc_1_start
  writeBe16To(mtoc + 84, 4);                    // area_1_toc_size
  writeBe16To(mtoc + 86, 4);                    // area_2_toc_size
  writeBe16To(mtoc + 120, 2020);                // disc_date_year
  mtoc[122] = 6;
  mtoc[123] = 15;

  // --- Master text (LSN 511) ---
  uint8_t* mtext = image.data() + 511 * kSectorSize;
  std::memcpy(mtext, "SACDText", 8);
  const auto putMasterText = [&](size_t positionOffset, uint16_t position, const char* text) {
    writeBe16To(mtext + positionOffset, position);
    std::memcpy(mtext + position, text, std::strlen(text));
  };
  putMasterText(16, 128, "Twilight Album");   // album_title_position
  putMasterText(20, 160, "Echo Ensemble");    // album_artist_position
  putMasterText(32, 192, "Twilight Disc");    // disc_title_position
  putMasterText(36, 224, "Echo Disc Artist"); // disc_artist_position

  // --- Area TOC writer ---
  const auto writeAreaToc = [&](uint32_t tocLsn,
                                const char* signature,
                                bool dst,
                                uint8_t channels,
                                uint8_t trackCount,
                                uint32_t trackStart,
                                uint32_t trackEnd,
                                const std::vector<uint32_t>& startLsns,
                                const std::vector<uint32_t>& lengthLsns,
                                const std::vector<std::array<uint8_t, 3>>& startTimes,
                                const std::vector<std::array<uint8_t, 3>>& durations,
                                const std::vector<std::pair<std::string, std::string>>& texts) {
    uint8_t* atoc = image.data() + static_cast<size_t>(tocLsn) * kSectorSize;
    std::memcpy(atoc, signature, 8);
    atoc[8] = 1;
    atoc[9] = 20;
    writeBe16To(atoc + 10, 4);          // size in sectors
    atoc[20] = 0x04;                    // sample_frequency: 64 * 44.1 kHz
    atoc[21] = dst ? 0x00 : 0x02;       // frame_format: 0 DST, 2 DSD-3-in-14
    atoc[32] = channels;                // channel_count
    atoc[69] = trackCount;              // track_count
    writeBe32To(atoc + 72, trackStart); // track_start LSN
    writeBe32To(atoc + 76, trackEnd);   // track_end LSN

    // SACDTTxt sector (+1)
    uint8_t* ttxt = image.data() + static_cast<size_t>(tocLsn + 1) * kSectorSize;
    std::memcpy(ttxt, "SACDTTxt", 8);
    uint16_t recordPosition = 256;
    for (uint8_t trackIndex = 0; trackIndex < trackCount; ++trackIndex) {
      writeBe16To(ttxt + 8 + trackIndex * 2, recordPosition);
      uint8_t* record = ttxt + recordPosition;
      record[0] = 2;  // amount: title + performer
      size_t cursor = 4;
      const auto writeEntry = [&](uint8_t type, const std::string& text) {
        record[cursor++] = type;
        record[cursor++] = 0x20;
        std::memcpy(record + cursor, text.data(), text.size());
        cursor += text.size();
        record[cursor++] = 0;  // NUL run separates entries
      };
      writeEntry(0x01, texts[trackIndex].first);
      writeEntry(0x02, texts[trackIndex].second);
      recordPosition = static_cast<uint16_t>(recordPosition + 128);
    }

    // SACDTRL1 sector (+2)
    uint8_t* trl1 = image.data() + static_cast<size_t>(tocLsn + 2) * kSectorSize;
    std::memcpy(trl1, "SACDTRL1", 8);
    for (uint8_t trackIndex = 0; trackIndex < trackCount; ++trackIndex) {
      writeBe32To(trl1 + 8 + trackIndex * 4, startLsns[trackIndex]);
      writeBe32To(trl1 + 1028 + trackIndex * 4, lengthLsns[trackIndex]);
    }

    // SACDTRL2 sector (+3)
    uint8_t* trl2 = image.data() + static_cast<size_t>(tocLsn + 3) * kSectorSize;
    std::memcpy(trl2, "SACDTRL2", 8);
    for (uint8_t trackIndex = 0; trackIndex < trackCount; ++trackIndex) {
      std::memcpy(trl2 + 8 + trackIndex * 4, startTimes[trackIndex].data(), 3);
      std::memcpy(trl2 + 1028 + trackIndex * 4, durations[trackIndex].data(), 3);
    }
  };

  writeAreaToc(
      kTwoChTocLsn, "TWOCHTOC", dstStereoArea, 2, 2, kTrack1Lsn, kMcTrackLsn,
      {kTrack1Lsn, kTrack2Lsn}, {2, 2},
      {{{0, 0, 0}}, {{0, 1, 0}}},
      {{{0, 1, 0}}, {{0, 2, 0}}},
      {{"Song One", "Artist One"}, {"Song Two", "Artist Two"}});
  writeAreaToc(
      kMcTocLsn, "MULCHTOC", false, 6, 1, kMcTrackLsn, kMcTrackLsn + 2,
      {kMcTrackLsn}, {2},
      {{{0, 0, 0}}},
      {{{0, 3, 0}}},
      {{"Surround One", "Artist Multi"}});

  // --- Audio sectors ---
  const auto sequencePayload = [](uint8_t base, size_t size) {
    std::vector<uint8_t> payload(size);
    for (size_t index = 0; index < size; ++index) {
      payload[index] = static_cast<uint8_t>(base + (index & 0x3f));
    }
    return payload;
  };
  if (dstStereoArea) {
    // Track 1: one DST access unit spanning two sectors (frame_start only on
    // the first). Track 2: two single-sector frames, exercising frame
    // completion when the next frame_start packet arrives.
    writeScarletbookAudioSector(image, kTrack1Lsn, true, true, sequencePayload(0x41, 24));
    writeScarletbookAudioSector(image, kTrack1Lsn + 1, true, false, sequencePayload(0x51, 24));
    writeScarletbookAudioSector(image, kTrack2Lsn, true, true, sequencePayload(0x61, 24));
    writeScarletbookAudioSector(image, kTrack2Lsn + 1, true, true, sequencePayload(0x71, 24));
  } else {
    writeScarletbookAudioSector(image, kTrack1Lsn, false, true, sequencePayload(0x80, 32));
    writeScarletbookAudioSector(image, kTrack1Lsn + 1, false, true, sequencePayload(0x90, 32));
    writeScarletbookAudioSector(image, kTrack2Lsn, false, true, sequencePayload(0xa0, 32));
    writeScarletbookAudioSector(image, kTrack2Lsn + 1, false, true, sequencePayload(0xb0, 32));
  }
  writeScarletbookAudioSector(image, kMcTrackLsn, false, true, sequencePayload(0x20, 30));
  writeScarletbookAudioSector(image, kMcTrackLsn + 1, false, true, sequencePayload(0x30, 30));

  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(image.data()), static_cast<std::streamsize>(image.size()));
  return path;
}

std::filesystem::path writeNonSacdIsoFixture(const std::string& name) {
  const auto path = std::filesystem::temp_directory_path() / name;
  std::array<uint8_t, 4096> bytes{};
  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  return path;
}

void testDsfReader() {
  const auto path = writeDsfFixture("twilight-dsd-reader.dsf");
  DsdReader reader;
  std::string error;
  assert(reader.open(path.string(), &error));
  const auto info = reader.streamInfo();
  assert(info.container == "DSF");
  assert(info.channelCount == 2);
  assert(info.dsdSampleRate == 2822400);
  assert(info.dsdRate == 64);
  assert(info.bitOrder == DsdBitOrder::LsbFirst);
  assert(info.packing == DsdPacking::DsfPlanarBlocks);
  assert(info.durationSeconds > 0.0);

  std::vector<uint8_t> bytes(16);
  assert(reader.readBytes(bytes.data(), bytes.size()) == 16);
  assert(bytes[0] == 0x11);
  assert(bytes[8] == 0x99);
  reader.close();
  std::filesystem::remove(path);
}

void testDsfSeekAlignsToPlanarBlockBoundary() {
  const auto path = writeTwoBlockDsfFixture("twilight-dsd-reader-seek-planar-block.dsf");
  DsdReader reader;
  std::string error;
  if (!reader.open(path.string(), &error)) {
    std::cerr << "DSF planar fixture failed to open: " << error << '\n';
    failTest("DSF planar seek fixture did not open");
  }
  const auto info = reader.streamInfo();
  if (info.packing != DsdPacking::DsfPlanarBlocks || info.channelCount != 2 ||
      info.blockSizePerChannel != 4 || info.durationSeconds <= 0.0 || info.dataSize != 16 ||
      info.dataOffset == 0) {
    failTest("DSF planar seek fixture parsed with unexpected stream info");
  }

  const double seekSeconds = 40.0 / 2822400.0;
  if (!reader.seek(seekSeconds, &error)) {
    std::cerr << "DSF planar seek failed: " << error << '\n';
    failTest("DSF planar seek failed");
  }
  std::vector<uint8_t> bytes(8, 0xee);
  const size_t read = reader.readBytes(bytes.data(), bytes.size());
  const std::vector<uint8_t> expected = {0x30, 0x31, 0x32, 0x33, 0x40, 0x41, 0x42, 0x43};
  if (read != expected.size() || bytes != expected) {
    std::cerr << "DSF planar seek read=" << read << " first=" << static_cast<int>(bytes[0]) << '\n';
    failTest("DSF seek did not align to a planar block boundary");
  }

  reader.close();
  std::filesystem::remove(path);
}

void testDsfReaderRejectsBlockSizeLargerThanDataChunk() {
  const auto path = writeMalformedDsfFixture(
      "twilight-dsd-reader-huge-block-small-data.dsf",
      2822400,
      2,
      UINT32_MAX,
      2);
  DsdReader reader;
  std::string error;
  if (reader.open(path.string(), &error)) {
    std::abort();
  }
  {
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
  }
}

void testDffReader() {
  const auto path = writeDffFixture("twilight-dsd-reader.dff");
  DsdReader reader;
  std::string error;
  assert(reader.open(path.string(), &error));
  const auto info = reader.streamInfo();
  assert(info.container == "DFF");
  assert(info.channelCount == 2);
  assert(info.dsdSampleRate == 5644800);
  assert(info.dsdRate == 128);
  assert(info.bitOrder == DsdBitOrder::MsbFirst);
  assert(info.packing == DsdPacking::DffInterleaved);
  reader.close();
  std::filesystem::remove(path);
}

void testDffReaderOpensNonAsciiUtf8Path() {
  // A DFF named in Chinese must still reach the native-DSD/DoP routes: the
  // pipeline's DSD probe passes Node's UTF-8 path through, and narrow ifstream
  // opens reinterpret those bytes in the Windows ANSI codepage (GBK on zh-CN),
  // silently downgrading playback to resampled PCM.
  const std::u8string name = u8"测试-你的眼神.dff";
  const auto path = writeDffFixtureAt(std::filesystem::temp_directory_path() / name);
  const std::u8string utf8Path = path.u8string();
  const std::string source(reinterpret_cast<const char*>(utf8Path.data()), utf8Path.size());
  DsdReader reader;
  std::string error;
  assert(reader.open(source, &error));
  const auto info = reader.streamInfo();
  assert(info.container == "DFF");
  assert(info.channelCount == 2);
  assert(info.dsdRate == 128);
  reader.close();
  std::error_code ignored;
  std::filesystem::remove(path, ignored);
}

void testDsdInterleaveHelperConvertsPlanarBlocks() {
  DsdStreamInfo info;
  info.channelCount = 2;
  info.bitOrder = DsdBitOrder::LsbFirst;
  info.packing = DsdPacking::DsfPlanarBlocks;

  const uint8_t dsd[] = {
      0x11, 0x22,
      0x99, 0xaa,
  };
  std::vector<uint8_t> output(4, 0xee);

  const size_t frames =
      render::dsdBytesToInterleavedResizeOnly(dsd, sizeof(dsd), info, AudioSampleFormat::DsdInt8Lsb1, &output);

  const std::vector<uint8_t> expected = {0x11, 0x99, 0x22, 0xaa};
  assert(frames == 2);
  assert(output == expected);
}

void testDsdInterleaveHelperConvertsBitOrderWithoutPreclearSentinel() {
  DsdStreamInfo info;
  info.channelCount = 2;
  info.bitOrder = DsdBitOrder::LsbFirst;
  info.packing = DsdPacking::DffInterleaved;

  const uint8_t dsd[] = {
      0x80, 0x01,
      0xf0, 0x0f,
  };
  std::vector<uint8_t> output(4, 0xee);

  const size_t frames =
      render::dsdBytesToInterleavedResizeOnly(dsd, sizeof(dsd), info, AudioSampleFormat::DsdInt8Msb1, &output);

  const std::vector<uint8_t> expected = {0x01, 0x80, 0x0f, 0xf0};
  assert(frames == 2);
  assert(output == expected);
}

void testDsdInterleaveHelperCanCopyDffWhenBitOrderMatches() {
  DsdStreamInfo info;
  info.channelCount = 2;
  info.bitOrder = DsdBitOrder::MsbFirst;
  info.packing = DsdPacking::DffInterleaved;

  if (!render::canCopyDsdBytesToInterleaved(info, AudioSampleFormat::DsdInt8Msb1)) std::abort();
  if (render::canCopyDsdBytesToInterleaved(info, AudioSampleFormat::DsdInt8Lsb1)) std::abort();
}

void testDopPackerInt24() {
  DopPacker packer;
  DopPackerConfig config;
  config.channelCount = 2;
  config.dsdRate = 64;
  config.sourceSampleRate = 2822400;
  config.outputFormat = AudioSampleFormat::Int24Interleaved;
  std::string error;
  assert(packer.configure(config, &error));
  const uint8_t dsd[] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88};
  std::vector<uint8_t> pcm;
  assert(packer.pack(dsd, sizeof(dsd), &pcm) == 2);
  assert(pcm.size() == 12);
  // DoP v1.1 int24 little-endian: [later byte][earlier byte][marker], payload
  // MSB-first. The source is DSF (LSB-first), so each byte is bit-reversed:
  // 0x11->0x88 0x22->0x44 0x33->0xcc 0x44->0x22 0x55->0xaa 0x66->0x66
  // 0x77->0xee 0x88->0x11
  assert(pcm[0] == 0x44 && pcm[1] == 0x88 && pcm[2] == 0x05);
  assert(pcm[3] == 0x66 && pcm[4] == 0xaa && pcm[5] == 0x05);
  assert(pcm[6] == 0x22 && pcm[7] == 0xcc && pcm[8] == 0xfa);
  assert(pcm[9] == 0x11 && pcm[10] == 0xee && pcm[11] == 0xfa);
}

/**
 * Guards the two faults that used to cancel out in the fixtures above: the
 * payload byte pair being written in reverse order, and the bit-order
 * normalization reversing the wrong source order.
 *
 * Both source bytes here are asymmetric under bit reversal AND distinct from
 * each other, so a byte swap, a missing reversal, or a spurious reversal each
 * produce a different failure. The older fixtures used values that happened to
 * be bit-reversals of one another, which made a 16-bit time reversal invisible.
 */
void testDopPackerPayloadOrderAndBitOrderAreIndependent() {
  // 0x01 -> 0x80, 0x02 -> 0x40 under bit reversal; neither is symmetric.
  const uint8_t dsd[] = {0x01, 0x02};

  std::vector<uint8_t> lsbPcm;
  size_t lsbMarker = 0;
  const size_t lsbFrames = dop::packDopFramesResizeOnly(
      dsd,
      sizeof(dsd),
      1,
      DsdPacking::DffInterleaved,
      DsdBitOrder::LsbFirst,
      AudioSampleFormat::Int24Interleaved,
      lsbMarker,
      &lsbPcm);
  // earlier=rev(0x01)=0x80, later=rev(0x02)=0x40 -> [0x40][0x80][0x05]
  const std::vector<uint8_t> lsbExpected = {0x40, 0x80, 0x05};
  assert(lsbFrames == 1);
  assert(lsbPcm == lsbExpected);

  std::vector<uint8_t> msbPcm;
  size_t msbMarker = 0;
  const size_t msbFrames = dop::packDopFramesResizeOnly(
      dsd,
      sizeof(dsd),
      1,
      DsdPacking::DffInterleaved,
      DsdBitOrder::MsbFirst,
      AudioSampleFormat::Int24Interleaved,
      msbMarker,
      &msbPcm);
  // DFF is already MSB-first: earlier=0x01, later=0x02 -> [0x02][0x01][0x05]
  const std::vector<uint8_t> msbExpected = {0x02, 0x01, 0x05};
  assert(msbFrames == 1);
  assert(msbPcm == msbExpected);
}

void testDopPackerHelperPacksInterleavedInt24In32WithoutPreclear() {
  const uint8_t dsd[] = {
      0x80, 0x01,
      0xf0, 0x0f,
  };
  std::vector<uint8_t> pcm(16, 0xee);
  size_t markerIndex = 0;

  const size_t frames = dop::packDopFramesResizeOnly(
      dsd,
      sizeof(dsd),
      1,
      DsdPacking::DffInterleaved,
      DsdBitOrder::MsbFirst,
      AudioSampleFormat::Int24In32Interleaved,
      markerIndex,
      &pcm);

  const std::vector<uint8_t> expected = {
      0x00, 0x01, 0x80, 0x05,
      0x00, 0x0f, 0xf0, 0xfa,
  };
  assert(frames == 2);
  assert(markerIndex == 2);
  assert(pcm == expected);
}

void testDopPackerDsd256() {
  DopPacker packer;
  DopPackerConfig config;
  config.channelCount = 2;
  config.dsdRate = 256;
  config.sourceSampleRate = 11289600;
  config.outputFormat = AudioSampleFormat::Int24Interleaved;
  std::string error;
  assert(packer.configure(config, &error));
  assert(packer.carrierFormat().sampleRate == 705600);
  assert(packer.carrierFormat().bitDepth == 24);
  assert(packer.carrierFormat().sampleFormat == AudioSampleFormat::Int24Interleaved);

  const uint8_t dsd[] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88};
  std::vector<uint8_t> pcm;
  assert(packer.pack(dsd, sizeof(dsd), &pcm) == 2);
  assert(pcm.size() == 12);
  // Same payload layout as testDopPackerInt24; only the carrier rate differs.
  assert(pcm[0] == 0x44 && pcm[1] == 0x88 && pcm[2] == 0x05);
  assert(pcm[3] == 0x66 && pcm[4] == 0xaa && pcm[5] == 0x05);
  assert(pcm[6] == 0x22 && pcm[7] == 0xcc && pcm[8] == 0xfa);
  assert(pcm[9] == 0x11 && pcm[10] == 0xee && pcm[11] == 0xfa);
}

void testDopPackerDsd512() {
  DopPacker packer;
  DopPackerConfig config;
  config.channelCount = 2;
  config.dsdRate = 512;
  config.sourceSampleRate = 22579200;
  config.outputFormat = AudioSampleFormat::Int24Interleaved;
  std::string error;
  assert(packer.configure(config, &error));
  assert(packer.carrierFormat().sampleRate == 1411200);
  assert(packer.carrierFormat().bitDepth == 24);
  assert(packer.carrierFormat().sampleFormat == AudioSampleFormat::Int24Interleaved);

  const uint8_t dsd[] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0};
  std::vector<uint8_t> pcm;
  assert(packer.pack(dsd, sizeof(dsd), &pcm) == 2);
  assert(pcm.size() == 12);
  // LSB-first source bit-reversed to the MSB-first DoP payload:
  // 0x12->0x48 0x34->0x2c 0x56->0x6a 0x78->0x1e
  // 0x9a->0x59 0xbc->0x3d 0xde->0x7b 0xf0->0x0f
  assert(pcm[0] == 0x2c && pcm[1] == 0x48 && pcm[2] == 0x05);
  assert(pcm[3] == 0x3d && pcm[4] == 0x59 && pcm[5] == 0x05);
  assert(pcm[6] == 0x1e && pcm[7] == 0x6a && pcm[8] == 0xfa);
  assert(pcm[9] == 0x0f && pcm[10] == 0x7b && pcm[11] == 0xfa);
}

void testDopPackerInt24In32() {
  DopPacker packer;
  DopPackerConfig config;
  config.channelCount = 1;
  config.dsdRate = 128;
  config.sourceSampleRate = 5644800;
  config.outputFormat = AudioSampleFormat::Int24In32Interleaved;
  std::string error;
  assert(packer.configure(config, &error));
  const uint8_t dsd[] = {0x12, 0x34, 0x56, 0x78};
  std::vector<uint8_t> pcm;
  assert(packer.pack(dsd, sizeof(dsd), &pcm) == 2);
  assert(pcm.size() == 8);
  // Int24-in-32, valid bits MSB-aligned: [pad][later][earlier][marker].
  // LSB-first source reversed: 0x12->0x48 0x34->0x2c 0x56->0x6a 0x78->0x1e
  assert(pcm[0] == 0x00 && pcm[1] == 0x2c && pcm[2] == 0x48 && pcm[3] == 0x05);
  assert(pcm[4] == 0x00 && pcm[5] == 0x1e && pcm[6] == 0x6a && pcm[7] == 0xfa);
}

void testSacdIsoProbePlayableEntry() {
  const auto notIso = probeSacdIsoEntry("album.dsf");
  assert(!notIso.isSacdIso());
  assert(!notIso.unsupported());
  assert(notIso.status == SacdIsoEntryStatus::NotSacdIso);
  assert(notIso.reasonCode.empty());
  assert(!notIso.isDsd);
  assert(!notIso.playable);

  const auto nestedPath = probeSacdIsoEntry("library.iso/track.dsf");
  assert(!nestedPath.isSacdIso());

  const auto nonIso = writeNonSacdIsoFixture("twilight-not-sacd.iso");
  const auto rejectedProbe = probeSacdIsoEntry(nonIso.string());
  assert(!rejectedProbe.isSacdIso());
  assert(rejectedProbe.isIso9660 == false);
  assert(rejectedProbe.reasonCode == kSacdIsoNotIso9660ReasonCode);
  {
    std::error_code ignored;
    std::filesystem::remove(nonIso, ignored);
  }

  const auto iso = writeSacdIsoFixture("twilight-sacd-fixture.iso");
  const auto probe = probeSacdIsoEntry(iso.string());
  assert(probe.isSacdIso());
  assert(!probe.unsupported());
  assert(probe.status == SacdIsoEntryStatus::Supported);
  assert(probe.source == iso.string());
  assert(probe.reasonCode.empty());
  assert(probe.reason.empty());
  assert(probe.codec == kSacdIsoCodecName);
  assert(probe.container == kSacdIsoContainerName);
  assert(probe.isIso9660);
  assert(probe.hasSacdMarkers);
  assert(probe.isDsd);
  assert(probe.hasDst);
  assert(probe.playable);

  DsdReader reader;
  std::string error;
  assert(reader.open((iso.string() + "?area=stereo&track=1"), &error));
  assert(reader.streamInfo().container == "SACD ISO");
  assert(reader.streamInfo().channelCount == 2);
  assert(reader.streamInfo().dsdRate == 64);
  std::vector<uint8_t> bytes(16);
  assert(reader.readBytes(bytes.data(), bytes.size()) == bytes.size());
  assert(bytes[0] == 0x80);
  reader.close();

  assert(!reader.open((iso.string() + "?area=stereo&track=2"), &error));
  assert(error == kSacdDstDsdProviderUnavailableReason);
  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testSacdIsoDemuxerTracksAndSeek() {
  const auto iso = writeSacdIsoFixture("twilight-sacd-demuxer-fixture.iso");
  SacdIsoDemuxer demuxer;
  std::string error;
  assert(demuxer.open(iso.string(), &error));
  assert(demuxer.tracks().size() == 3);
  assert(demuxer.selectTrack("stereo", 1, &error));
  assert(demuxer.streamInfo().source.find("area=stereo&track=1") != std::string::npos);
  std::vector<uint8_t> bytes(8);
  assert(demuxer.readBytes(bytes.data(), bytes.size()) == bytes.size());
  assert(bytes[0] == 0x80);
  assert(demuxer.seek(0.0, &error));
  assert(demuxer.readBytes(bytes.data(), bytes.size()) == bytes.size());
  assert(bytes[0] == 0x80);
  assert(!demuxer.selectTrack("stereo", 2, &error));
  assert(error == kSacdDstDsdProviderUnavailableReason);
  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

class RejectingDstProvider final : public SacdDstProvider {
 public:
  const char* name() const override {
    return "rejecting-test-provider";
  }

  bool available(std::string* reason) const override {
    if (reason) *reason = "test provider disabled";
    return false;
  }
};

class AcceptingDstProvider final : public SacdDstProvider {
 public:
  const char* name() const override {
    return "accepting-test-provider";
  }

  bool available(std::string* reason) const override {
    if (reason) reason->clear();
    return true;
  }

  bool preservesDsd() const override {
    return true;
  }
};

class PartialDstDecoderProvider final : public SacdDstDecoderProvider {
 public:
  const char* name() const override {
    return "partial-dst-decoder-test-provider";
  }

  bool available(std::string* reason) const override {
    if (reason) reason->clear();
    return true;
  }

  bool open(int channels, int sampleRate, std::string* error) override {
    (void)channels;
    (void)sampleRate;
    if (error) error->clear();
    return true;
  }

  size_t decodeFrame(
      const uint8_t* dstFrameBytes,
      size_t dstFrameSize,
      uint8_t* dsdOut,
      size_t dsdOutSize,
      std::string* error) override {
    (void)dstFrameBytes;
    (void)dstFrameSize;
    if (error) error->clear();
    if (dsdOutSize < 3) return 0;
    const uint8_t base = static_cast<uint8_t>(0x10 + frameIndex_ * 0x10);
    dsdOut[0] = base;
    dsdOut[1] = static_cast<uint8_t>(base + 1);
    dsdOut[2] = static_cast<uint8_t>(base + 2);
    ++frameIndex_;
    return 3;
  }

  size_t frameBytesPerChannel(int sampleRate) const override {
    (void)sampleRate;
    return 4;
  }

  void reset() override {
    frameIndex_ = 0;
  }

 private:
  size_t frameIndex_ = 0;
};

class EchoDstDecoderProvider final : public SacdDstDecoderProvider {
 public:
  const char* name() const override {
    return "echo-dst-decoder-test-provider";
  }

  bool available(std::string* reason) const override {
    if (reason) reason->clear();
    return true;
  }

  bool open(int channels, int sampleRate, std::string* error) override {
    (void)channels;
    (void)sampleRate;
    if (error) error->clear();
    return true;
  }

  size_t decodeFrame(
      const uint8_t* dstFrameBytes,
      size_t dstFrameSize,
      uint8_t* dsdOut,
      size_t dsdOutSize,
      std::string* error) override {
    if (error) error->clear();
    if (!dstFrameBytes || dstFrameSize == 0 || dsdOutSize < 8) return 0;
    for (size_t index = 0; index < 8; ++index) {
      dsdOut[index] = static_cast<uint8_t>(dstFrameBytes[0] + index);
    }
    return 8;
  }

  size_t frameBytesPerChannel(int sampleRate) const override {
    (void)sampleRate;
    return 4;
  }

  void reset() override {}
};

class ExactSizeDstDecoderProvider final : public SacdDstDecoderProvider {
 public:
  explicit ExactSizeDstDecoderProvider(std::vector<size_t> expectedFrameSizes)
      : expectedFrameSizes_(std::move(expectedFrameSizes)) {}

  const char* name() const override {
    return "exact-size-dst-decoder-test-provider";
  }

  bool available(std::string* reason) const override {
    if (reason) reason->clear();
    return true;
  }

  bool open(int channels, int sampleRate, std::string* error) override {
    (void)channels;
    (void)sampleRate;
    if (error) error->clear();
    return true;
  }

  size_t decodeFrame(
      const uint8_t* dstFrameBytes,
      size_t dstFrameSize,
      uint8_t* dsdOut,
      size_t dsdOutSize,
      std::string* error) override {
    if (!dstFrameBytes || dstFrameSize == 0 || dsdOutSize < 8 || dstFrameBytes[0] < 0x40) {
      if (error) *error = "unexpected DST frame";
      return 0;
    }
    const size_t frameIndex = static_cast<size_t>((dstFrameBytes[0] - 0x40) / 0x10);
    if (frameIndex >= expectedFrameSizes_.size() || dstFrameSize != expectedFrameSizes_[frameIndex]) {
      if (error) *error = "DST frame size did not match frame table";
      return 0;
    }
    const uint8_t base = static_cast<uint8_t>(0xa0 + frameIndex * 0x10);
    for (size_t index = 0; index < 8; ++index) {
      dsdOut[index] = static_cast<uint8_t>(base + index);
    }
    if (error) error->clear();
    return 8;
  }

  size_t frameBytesPerChannel(int sampleRate) const override {
    (void)sampleRate;
    return 4;
  }

  void reset() override {}

 private:
  std::vector<size_t> expectedFrameSizes_;
};

void testDffDstReaderDecodesThroughProvider() {
  const auto path = writeDstDffFixture("twilight-dst-dff.dff");
  EchoDstDecoderProvider provider;
  DsdReader reader;
  reader.setDstDecoderProvider(&provider);
  std::string error;
  assert(reader.open(path.string(), &error));
  const auto info = reader.streamInfo();
  assert(info.container == "DFF");
  assert(info.dsdSampleRate == 2822400);
  assert(info.dsdRate == 64);
  assert(info.channelCount == 2);
  assert(info.bitOrder == DsdBitOrder::MsbFirst);
  assert(info.packing == DsdPacking::DffInterleaved);
  // dataSize reports decoded bytes: 2 frames x 8 bytes per decoded frame.
  assert(info.dataSize == 16);
  assert(std::abs(info.durationSeconds - (2.0 / 75.0)) < 1e-9);

  uint8_t buffer[8];
  assert(reader.readBytes(buffer, sizeof(buffer)) == 8);
  assert(buffer[0] == 0xA0 && buffer[7] == 0xA7);
  assert(reader.readBytes(buffer, sizeof(buffer)) == 8);
  assert(buffer[0] == 0xB0 && buffer[7] == 0xB7);
  uint8_t extra[4];
  assert(reader.readBytes(extra, sizeof(extra)) == 0);
  assert(reader.eof());

  // Frame-indexed seek restarts at the requested frame boundary.
  assert(reader.seek(1.0 / 75.0, &error));
  assert(reader.readBytes(buffer, sizeof(buffer)) == 8);
  assert(buffer[0] == 0xB0);
  reader.close();
  std::filesystem::remove(path);
}

void testDffDstReaderRequiresProvider() {
  const auto path = writeDstDffFixture("twilight-dst-dff-noprovider.dff");
  DsdReader reader;
  std::string error;
  assert(!reader.open(path.string(), &error));
  assert(error.find("DST decoder provider") != std::string::npos);
  std::error_code ignored;
  std::filesystem::remove(path, ignored);
}

// Uncompressed DST frames (first bit 0) are exactly one header byte plus the
// raw interleaved DSD bytes, so the real vendored dstdec passes them through.
// This proves the DFF-DST path against the production decoder, not a stub.
std::filesystem::path writeUncompressedDstDffFixture(const std::string& name, int frameCount) {
  const auto path = std::filesystem::temp_directory_path() / name;
  constexpr size_t kFrameBytesPerChannel = 4704;  // 2822400 / 8 / 75
  constexpr size_t kDecodedFrameBytes = kFrameBytesPerChannel * 2;
  const size_t frameSize = 1 + kDecodedFrameBytes;
  const size_t frameChunkSize = frameSize + (frameSize & 1);
  const uint64_t dstPayload = (12 + 6) + static_cast<uint64_t>(frameCount) * (12 + frameChunkSize);
  const uint64_t propPayload = 4 + (12 + 4) + (12 + 2) + (12 + 6);
  const uint64_t formSize = 4 + (12 + 4) + (12 + propPayload) + (12 + dstPayload);

  std::ofstream out(path, std::ios::binary);
  out.write("FRM8", 4);
  writeBe64(out, formSize);
  out.write("DST ", 4);
  out.write("FVER", 4);
  writeBe64(out, 4);
  writeBe32(out, 0x01050000);
  out.write("PROP", 4);
  writeBe64(out, propPayload);
  out.write("SND ", 4);
  out.write("FS  ", 4);
  writeBe64(out, 4);
  writeBe32(out, 2822400);
  out.write("CHNL", 4);
  writeBe64(out, 2);
  writeBe16(out, 2);
  out.write("CMPR", 4);
  writeBe64(out, 6);
  out.write("DST ", 4);
  out.put(static_cast<char>(1));
  out.put('\0');
  out.write("DST ", 4);
  writeBe64(out, dstPayload);
  out.write("FRTE", 4);
  writeBe64(out, 6);
  writeBe32(out, static_cast<uint32_t>(frameCount));
  writeBe16(out, 75);
  for (int frame = 0; frame < frameCount; ++frame) {
    out.write("DSTF", 4);
    writeBe64(out, frameSize);
    out.put('\0');
    for (size_t index = 0; index < kDecodedFrameBytes; ++index) {
      out.put(static_cast<char>((frame * 3 + index) & 0xFF));
    }
    // DSDIFF pads odd-sized chunk payloads; 1 + 2*4704 is odd.
    if ((frameSize & 1) != 0) out.put('\0');
  }
  return path;
}

void testDffDstUncompressedFramesDecodeWithRealProvider() {
  const auto path = writeUncompressedDstDffFixture("twilight-dst-dff-real.dff", 3);
  auto provider = createDefaultSacdDstDecoderProvider();
  DsdReader reader;
  reader.setDstDecoderProvider(provider.get());
  std::string error;
  assert(reader.open(path.string(), &error));
  const auto info = reader.streamInfo();
  assert(info.dsdRate == 64);
  assert(info.dataSize == 3 * 4704 * 2);

  constexpr size_t kDecodedFrameBytes = 4704 * 2;
  std::vector<uint8_t> buffer(kDecodedFrameBytes);
  for (int frame = 0; frame < 3; ++frame) {
    assert(reader.readBytes(buffer.data(), buffer.size()) == buffer.size());
    for (size_t index = 0; index < buffer.size(); ++index) {
      assert(buffer[index] == ((frame * 3 + index) & 0xFF));
    }
  }
  uint8_t extra[8];
  assert(reader.readBytes(extra, sizeof(extra)) == 0);
  assert(reader.eof());
  reader.close();
  std::filesystem::remove(path);
}

class PcmOnlyDstProvider final : public SacdDstProvider {
 public:
  const char* name() const override {
    return "pcm-only-test-provider";
  }

  bool available(std::string* reason) const override {
    if (reason) reason->clear();
    return true;
  }
};

void testSacdDstProviderSelection() {
  auto ffmpeg = selectSacdDstProvider(true, nullptr);
  assert(!ffmpeg.available);
  assert(ffmpeg.provider == kSacdDstFfmpegProviderName);
  assert(ffmpeg.reasonCode == kSacdDstDsdProviderUnavailableReasonCode);
  assert(ffmpeg.reason == kSacdDstDsdProviderUnavailableReason);

  auto none = selectSacdDstProvider(false, nullptr);
  assert(!none.available);
  assert(none.reasonCode == kSacdDstDsdProviderUnavailableReasonCode);
  assert(none.reason == kSacdDstDsdProviderUnavailableReason);

  RejectingDstProvider rejecting;
  auto rejected = selectSacdDstProvider(false, &rejecting);
  assert(!rejected.available);
  assert(rejected.provider == "rejecting-test-provider");
  assert(rejected.reasonCode == kSacdDstProviderRejectedReasonCode);
  assert(rejected.reason == "test provider disabled");

  PcmOnlyDstProvider pcmOnly;
  auto pcmOnlyRejected = selectSacdDstProvider(false, &pcmOnly);
  assert(!pcmOnlyRejected.available);
  assert(pcmOnlyRejected.provider == "pcm-only-test-provider");
  assert(pcmOnlyRejected.reasonCode == kSacdDstDsdProviderUnavailableReasonCode);
  assert(pcmOnlyRejected.reason == kSacdDstDsdProviderUnavailableReason);

  AcceptingDstProvider accepting;
  auto accepted = selectSacdDstProvider(false, &accepting);
  assert(accepted.available);
  assert(accepted.provider == "accepting-test-provider");
  assert(accepted.reasonCode.empty());
}

void testSacdDstTrackPlayableWithProvider() {
  // When a DSD-preserving DST decoder provider is registered, SACD ISO DST
  // tracks flip to playable and selectTrack succeeds (no longer rejected with
  // dst_dsd_provider_unavailable). The fixture's DST track carries synthetic
  // payload (not a real compressed DST frame), so readBytes may stop at EOF
  // when the decoder cannot parse it; the contract under test is that the
  // track is selectable and the provider is wired up.
  const auto iso = writeSacdIsoFixture("twilight-sacd-dst-provider-fixture.iso");
  auto provider = createDefaultSacdDstDecoderProvider();
  assert(provider != nullptr);
  std::string reason;
  assert(provider->available(&reason));

  SacdIsoDemuxer demuxer;
  demuxer.setDstDecoderProvider(provider.get());
  std::string error;
  assert(demuxer.open(iso.string(), &error));
  // The fixture has a DST track (stereo track 2). With a provider registered
  // it must report playable=true (no dst_dsd_provider_unavailable reason).
  bool foundDst = false;
  for (const auto& track : demuxer.tracks()) {
    if (track.isDst) {
      foundDst = true;
      assert(track.playable);
      assert(track.reasonCode.empty());
      assert(track.reason.empty());
    }
  }
  assert(foundDst);
  // selectTrack on the DST track must succeed now that a provider is wired up.
  assert(demuxer.selectTrack("stereo", 2, &error));
  assert(demuxer.streamInfo().isDsd);
  assert(demuxer.streamInfo().codec == "dst");
  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testSacdDstReadBytesDrainsOnlyDecodedBytes() {
  const auto iso = writeSacdIsoFixture("twilight-sacd-dst-partial-decode-fixture.iso");
  PartialDstDecoderProvider provider;
  SacdIsoDemuxer demuxer;
  demuxer.setDstDecoderProvider(&provider);
  std::string error;
  if (!demuxer.open(iso.string(), &error) || !demuxer.selectTrack("stereo", 2, &error)) {
    failTest("partial DST provider fixture failed to open/select");
  }

  std::vector<uint8_t> bytes(8, 0xee);
  const size_t read = demuxer.readBytes(bytes.data(), bytes.size());
  const std::vector<uint8_t> expected = {0x10, 0x11, 0x12, 0x20, 0x21, 0x22, 0x30, 0x31};
  if (read != bytes.size() || bytes != expected) {
    failTest("DST readBytes drained padded bytes instead of decoded byte count");
  }

  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testSacdDstReadBytesUsesFrameTableForVariableFrames() {
  const std::vector<uint32_t> frameSizes = {3, 7, 2};
  const auto iso = writeSacdIsoFixture("twilight-sacd-dst-variable-frame-fixture.iso", 2400, frameSizes);
  ExactSizeDstDecoderProvider provider({3, 7, 2});
  SacdIsoDemuxer demuxer;
  demuxer.setDstDecoderProvider(&provider);
  std::string error;
  if (!demuxer.open(iso.string(), &error) || !demuxer.selectTrack("stereo", 2, &error)) {
    failTest("variable DST frame fixture failed to open/select");
  }

  std::vector<uint8_t> bytes(16, 0xee);
  const size_t read = demuxer.readBytes(bytes.data(), bytes.size());
  const std::vector<uint8_t> expected = {
      0xa0,
      0xa1,
      0xa2,
      0xa3,
      0xa4,
      0xa5,
      0xa6,
      0xa7,
      0xb0,
      0xb1,
      0xb2,
      0xb3,
      0xb4,
      0xb5,
      0xb6,
      0xb7};
  if (read != bytes.size() || bytes != expected) {
    failTest("DST readBytes ignored variable frame sizes from the frame table");
  }

  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testSacdDstSeekUsesDecodedFrameTimeInsteadOfCompressedByteRatio() {
  const auto iso = writeSacdIsoFixture("twilight-sacd-dst-seek-fixture.iso", 2400);
  EchoDstDecoderProvider provider;
  SacdIsoDemuxer demuxer;
  demuxer.setDstDecoderProvider(&provider);
  std::string error;
  if (!demuxer.open(iso.string(), &error) || !demuxer.selectTrack("stereo", 2, &error)) {
    failTest("echo DST provider fixture failed to open/select");
  }

  if (!demuxer.seek(10.0 / 75.0, &error) || demuxer.eof()) {
    failTest("DST seek unexpectedly reached EOF");
  }
  std::vector<uint8_t> bytes(4, 0xee);
  const size_t read = demuxer.readBytes(bytes.data(), bytes.size());
  const uint8_t expectedFrameFirstByte = static_cast<uint8_t>(0x40 + ((10 * 9) & 0x3f));
  const std::vector<uint8_t> expected = {
      expectedFrameFirstByte,
      static_cast<uint8_t>(expectedFrameFirstByte + 1),
      static_cast<uint8_t>(expectedFrameFirstByte + 2),
      static_cast<uint8_t>(expectedFrameFirstByte + 3)};
  if (read != bytes.size() || bytes != expected) {
    std::cerr << "DST seek read=" << read << " expectedFirst=" << static_cast<int>(expectedFrameFirstByte)
              << " actualFirst=" << static_cast<int>(bytes[0]) << '\n';
    failTest("DST seek did not land on the expected compressed frame");
  }

  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testSacdDstSeekUsesFrameTableForVariableFrames() {
  const std::vector<uint32_t> frameSizes = {3, 7, 2};
  const auto iso = writeSacdIsoFixture("twilight-sacd-dst-variable-frame-seek-fixture.iso", 2400, frameSizes);
  ExactSizeDstDecoderProvider provider({3, 7, 2});
  SacdIsoDemuxer demuxer;
  demuxer.setDstDecoderProvider(&provider);
  std::string error;
  if (!demuxer.open(iso.string(), &error) || !demuxer.selectTrack("stereo", 2, &error)) {
    failTest("variable DST seek fixture failed to open/select");
  }

  if (!demuxer.seek(16.0 / 600.0, &error) || demuxer.eof()) {
    failTest("DST variable-frame seek unexpectedly reached EOF");
  }

  std::vector<uint8_t> bytes(8, 0xee);
  const size_t read = demuxer.readBytes(bytes.data(), bytes.size());
  const std::vector<uint8_t> expected = {0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7};
  if (read != bytes.size() || bytes != expected) {
    failTest("DST seek ignored variable frame sizes from the frame table");
  }

  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testSacdDstTrackUnplayableWithoutProvider() {
  // Without a provider, DST tracks remain unplayable (regression guard for
  // the dst_dsd_provider_unavailable contract).
  const auto iso = writeSacdIsoFixture("twilight-sacd-dst-no-provider-fixture.iso");
  SacdIsoDemuxer demuxer;
  std::string error;
  assert(demuxer.open(iso.string(), &error));
  bool foundDst = false;
  for (const auto& track : demuxer.tracks()) {
    if (track.isDst) {
      foundDst = true;
      assert(!track.playable);
      assert(track.reasonCode == kSacdDstDsdProviderUnavailableReasonCode);
    }
  }
  assert(foundDst);
  assert(!demuxer.selectTrack("stereo", 2, &error));
  assert(error == kSacdDstDsdProviderUnavailableReason);
  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testScarletbookTocParsesTracksAndMetadata() {
  const auto iso = writeScarletbookIsoFixture("twilight-scarletbook-dsd-fixture.iso", false);
  SacdIsoDemuxer demuxer;
  std::string error;
  if (!demuxer.open(iso.string(), &error)) {
    std::cerr << "Scarletbook fixture failed to open: " << error << '\n';
    failTest("Scarletbook fixture did not open");
  }

  // 2 stereo tracks + 1 multichannel track from the real area TOCs.
  const auto& tracks = demuxer.tracks();
  size_t stereoCount = 0;
  size_t multiCount = 0;
  for (const auto& track : tracks) {
    if (track.area == "stereo") ++stereoCount;
    if (track.area == "multichannel") ++multiCount;
    if (!track.scarletbook) failTest("Scarletbook track missing scarletbook flag");
  }
  if (tracks.size() != 3 || stereoCount != 2 || multiCount != 1) {
    std::cerr << "tracks=" << tracks.size() << " stereo=" << stereoCount << " multi=" << multiCount << '\n';
    failTest("Scarletbook TOC produced the wrong track counts");
  }

  for (const auto& track : tracks) {
    if (track.area == "stereo" && track.trackNumber == 1) {
      if (track.title != "Song One" || track.artist != "Artist One") {
        std::cerr << "title=" << track.title << " artist=" << track.artist << '\n';
        failTest("Scarletbook track 1 title/performer not parsed from SACDTTxt");
      }
      if (track.albumTitle != "Twilight Album") failTest("Scarletbook album title not parsed from SACDText");
      if (track.isDst) failTest("DSD area track incorrectly flagged as DST");
      if (track.channelCount != 2 || track.sampleRate != 2822400) failTest("Scarletbook 2CH format wrong");
      if (track.startSector != 540 || track.sectorCount != 2) failTest("Scarletbook track 1 extent wrong");
      if (std::abs(track.durationSeconds - 1.0) > 1e-9) failTest("Scarletbook track 1 duration wrong");
      if (!track.playable) failTest("Scarletbook DSD track must be playable");
    }
    if (track.area == "stereo" && track.trackNumber == 2) {
      if (track.title != "Song Two" || track.artist != "Artist Two") failTest("Scarletbook track 2 text wrong");
      if (track.startSector != 542 || std::abs(track.durationSeconds - 2.0) > 1e-9) {
        failTest("Scarletbook track 2 start/duration wrong");
      }
    }
    if (track.area == "multichannel") {
      if (track.channelCount != 6) failTest("Scarletbook MC channel count wrong");
      if (track.title != "Surround One") failTest("Scarletbook MC track title wrong");
      if (std::abs(track.durationSeconds - 3.0) > 1e-9) failTest("Scarletbook MC duration wrong");
    }
  }

  // Area selection: stereo preferred by default, MC reachable explicitly.
  if (!demuxer.selectTrack("multichannel", 1, &error)) failTest("Scarletbook MC area selection failed");
  if (demuxer.streamInfo().sourceFormat.channelCount != 6) failTest("MC selection returned wrong channel count");

  // DSD byte extraction: demultiplexed audio-packet payload, not raw sectors.
  if (!demuxer.selectTrack("stereo", 1, &error)) failTest("Scarletbook stereo selection failed");
  std::vector<uint8_t> bytes(40, 0xee);
  const size_t read = demuxer.readBytes(bytes.data(), bytes.size());
  if (read != bytes.size()) failTest("Scarletbook DSD readBytes returned short");
  for (size_t index = 0; index < 32; ++index) {
    if (bytes[index] != static_cast<uint8_t>(0x80 + (index & 0x3f))) {
      failTest("Scarletbook DSD payload mismatch in first sector");
    }
  }
  for (size_t index = 32; index < 40; ++index) {
    if (bytes[index] != static_cast<uint8_t>(0x90 + ((index - 32) & 0x3f))) {
      failTest("Scarletbook DSD payload mismatch across sector boundary");
    }
  }

  // Seek back to zero re-syncs on the first frame-start packet.
  if (!demuxer.seek(0.0, &error)) failTest("Scarletbook seek failed");
  std::fill(bytes.begin(), bytes.end(), 0xee);
  if (demuxer.readBytes(bytes.data(), 8) != 8 || bytes[0] != 0x80) {
    failTest("Scarletbook seek did not return to the track start");
  }

  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testScarletbookDstAreaFlagsAndDecode() {
  const auto iso = writeScarletbookIsoFixture("twilight-scarletbook-dst-fixture.iso", true);

  // Without a provider the DST tracks must stay unplayable.
  {
    SacdIsoDemuxer demuxer;
    std::string error;
    if (!demuxer.open(iso.string(), &error)) failTest("Scarletbook DST fixture did not open");
    for (const auto& track : demuxer.tracks()) {
      if (track.area == "stereo") {
        if (!track.isDst) failTest("Scarletbook DST area track not flagged as DST");
        if (track.playable) failTest("Scarletbook DST track playable without provider");
        if (track.reasonCode != kSacdDstDsdProviderUnavailableReasonCode) {
          failTest("Scarletbook DST track missing provider-unavailable reason");
        }
      } else if (track.isDst) {
        failTest("Scarletbook MC DSD area incorrectly flagged as DST");
      }
    }
  }

  // With an echo provider, DST access units are assembled from the
  // multiplexed packets: track 1 is one frame spanning two sectors (first
  // payload byte 0x41), track 2 is two single-sector frames (0x61, 0x71).
  {
    EchoDstDecoderProvider provider;
    SacdIsoDemuxer demuxer;
    demuxer.setDstDecoderProvider(&provider);
    std::string error;
    if (!demuxer.open(iso.string(), &error) || !demuxer.selectTrack("stereo", 1, &error)) {
      failTest("Scarletbook DST select with provider failed");
    }
    if (demuxer.streamInfo().codec != "dst") failTest("Scarletbook DST codec not reported");
    std::vector<uint8_t> bytes(8, 0xee);
    if (demuxer.readBytes(bytes.data(), bytes.size()) != bytes.size() || bytes[0] != 0x41) {
      std::cerr << "first=" << static_cast<int>(bytes[0]) << '\n';
      failTest("Scarletbook DST frame did not decode from assembled access unit");
    }

    if (!demuxer.selectTrack("stereo", 2, &error)) failTest("Scarletbook DST track 2 select failed");
    std::vector<uint8_t> frames(16, 0xee);
    const size_t read = demuxer.readBytes(frames.data(), frames.size());
    if (read != frames.size() || frames[0] != 0x61 || frames[8] != 0x71) {
      std::cerr << "read=" << read << " f0=" << static_cast<int>(frames[0])
                << " f8=" << static_cast<int>(frames[8]) << '\n';
      failTest("Scarletbook DST frame boundaries not detected via frame_start packets");
    }
  }

  {
    std::error_code ignored;
    std::filesystem::remove(iso, ignored);
  }
}

void testScarletbookMalformedTocFallsBackGracefully() {
  // A Scarletbook master TOC pointing at a bogus area TOC must not crash and
  // must fall back to the legacy heuristics (which find nothing here, so open
  // fails with a clean error instead of a crash).
  const auto path = std::filesystem::temp_directory_path() / "twilight-scarletbook-malformed.iso";
  {
    const auto valid = writeScarletbookIsoFixture("twilight-scarletbook-malformed-src.iso", false);
    std::ifstream in(valid, std::ios::binary);
    std::vector<uint8_t> image((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    in.close();
    {
      std::error_code ignored;
      std::filesystem::remove(valid, ignored);
    }
    // Corrupt the 2CH area TOC signature and point the MC area out of range.
    std::memcpy(image.data() + 520 * 2048, "GARBAGE!", 8);
    uint8_t* mtoc = image.data() + 510 * 2048;
    mtoc[72] = 0xff;
    mtoc[73] = 0xff;
    mtoc[74] = 0xff;
    mtoc[75] = 0xff;
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(image.data()), static_cast<std::streamsize>(image.size()));
  }

  SacdIsoDemuxer demuxer;
  std::string error;
  const bool opened = demuxer.open(path.string(), &error);
  if (opened) {
    // Fallback heuristics may still surface marker-derived tracks; the only
    // hard requirement is no crash and no Scarletbook-flagged tracks.
    for (const auto& track : demuxer.tracks()) {
      if (track.scarletbook) failTest("Malformed Scarletbook TOC produced scarletbook tracks");
    }
  }

  {
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
  }
}

}  // namespace

int main() {
  testSacdIsoByteScratchResizePreservesSameSizedScratch();
  testSacdDstDecodePathDoesNotPreclearDecodedFrameBuffer();
  testDsfReader();
  testDsfSeekAlignsToPlanarBlockBoundary();
  testDsfReaderRejectsBlockSizeLargerThanDataChunk();
  testDffReader();
  testDffReaderOpensNonAsciiUtf8Path();
  testDffDstReaderDecodesThroughProvider();
  testDffDstReaderRequiresProvider();
  testDffDstUncompressedFramesDecodeWithRealProvider();
  testDsdInterleaveHelperConvertsPlanarBlocks();
  testDsdInterleaveHelperConvertsBitOrderWithoutPreclearSentinel();
  testDsdInterleaveHelperCanCopyDffWhenBitOrderMatches();
  testDopPackerHelperPacksInterleavedInt24In32WithoutPreclear();
  testDopPackerPayloadOrderAndBitOrderAreIndependent();
  testDopPackerInt24();
  testDopPackerDsd256();
  testDopPackerDsd512();
  testDopPackerInt24In32();
  testSacdIsoProbePlayableEntry();
  testSacdIsoDemuxerTracksAndSeek();
  testSacdDstProviderSelection();
  testSacdDstTrackPlayableWithProvider();
  testSacdDstReadBytesDrainsOnlyDecodedBytes();
  testSacdDstReadBytesUsesFrameTableForVariableFrames();
  testSacdDstSeekUsesDecodedFrameTimeInsteadOfCompressedByteRatio();
  testSacdDstSeekUsesFrameTableForVariableFrames();
  testSacdDstTrackUnplayableWithoutProvider();
  testScarletbookTocParsesTracksAndMetadata();
  testScarletbookDstAreaFlagsAndDecode();
  testScarletbookMalformedTocFallsBackGracefully();
  assert(sourceLooksDsfOrDff("song.DSF"));
  assert(sourceLooksDsfOrDff("song.dff"));
  assert(inferDsdRateFromSampleRate(11289600) == 256);
  return 0;
}
