#include "SacdIsoDemuxer.h"

#include "SacdIsoDemuxerUtils.h"
#include "SacdIsoProbe.h"
#include "ScarletbookToc.h"
#include "../core/DsdRate.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstring>
#include <fstream>

namespace twilight::audio {
namespace {

constexpr uint32_t kIsoSectorSize = 2048;

struct IsoEntry {
  std::string path;
  uint32_t extent = 0;
  uint32_t size = 0;
  bool directory = false;
};

struct ParsedSource {
  std::string path;
  std::string area;
  int track = -1;
};

std::string toLower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string toUpper(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return value;
}

std::string trimIsoName(std::string value) {
  const size_t version = value.find(';');
  if (version != std::string::npos) value.resize(version);
  while (!value.empty() && (value.back() == '.' || value.back() == ' ')) value.pop_back();
  return value;
}

bool endsWith(const std::string& value, const std::string& suffix) {
  return value.size() >= suffix.size() && value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool containsNoCase(const std::string& value, const std::string& needle) {
  return toLower(value).find(toLower(needle)) != std::string::npos;
}

uint32_t readLe32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
}

uint64_t fileSize(std::ifstream& file) {
  const auto current = file.tellg();
  file.seekg(0, std::ios::end);
  const auto end = file.tellg();
  file.seekg(current, std::ios::beg);
  return end < 0 ? 0 : static_cast<uint64_t>(end);
}

bool readExactAt(std::ifstream& file, uint64_t offset, uint8_t* data, size_t size) {
  file.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
  if (!file) return false;
  file.read(reinterpret_cast<char*>(data), static_cast<std::streamsize>(size));
  return static_cast<size_t>(file.gcount()) == size;
}

ParsedSource parseSource(const std::string& source) {
  ParsedSource parsed;
  parsed.path = source;
  const size_t qm = parsed.path.find('?');
  if (qm == std::string::npos) return parsed;

  const std::string query = parsed.path.substr(qm + 1);
  parsed.path.resize(qm);
  size_t start = 0;
  while (start <= query.size()) {
    const size_t amp = query.find('&', start);
    const std::string pair = query.substr(start, amp == std::string::npos ? std::string::npos : amp - start);
    const size_t eq = pair.find('=');
    const std::string key = toLower(eq == std::string::npos ? pair : pair.substr(0, eq));
    const std::string value = eq == std::string::npos ? "" : pair.substr(eq + 1);
    if (key == "track") {
      try {
        parsed.track = std::stoi(value);
      } catch (...) {
        parsed.track = -1;
      }
    } else if (key == "area") {
      parsed.area = toLower(value);
    }
    if (amp == std::string::npos) break;
    start = amp + 1;
  }
  return parsed;
}

void collectDirectory(
    std::ifstream& file,
    uint32_t extent,
    uint32_t size,
    const std::string& parent,
    int depth,
    std::vector<IsoEntry>* entries) {
  if (!entries || depth > 5 || extent == 0 || size == 0 || entries->size() > 1024) return;

  std::vector<uint8_t> directory(size);
  if (!readExactAt(file, static_cast<uint64_t>(extent) * kIsoSectorSize, directory.data(), directory.size())) return;

  size_t offset = 0;
  while (offset < directory.size() && entries->size() <= 1024) {
    const uint8_t length = directory[offset];
    if (length == 0) {
      offset = ((offset / kIsoSectorSize) + 1) * kIsoSectorSize;
      continue;
    }
    if (offset + length > directory.size() || length < 34) break;

    const uint8_t nameLength = directory[offset + 32];
    if (33U + nameLength > length) {
      offset += length;
      continue;
    }
    const uint8_t* rawName = directory.data() + offset + 33;
    if (nameLength == 1 && (rawName[0] == 0 || rawName[0] == 1)) {
      offset += length;
      continue;
    }

    const std::string name = trimIsoName(toUpper(
        std::string(reinterpret_cast<const char*>(rawName), reinterpret_cast<const char*>(rawName) + nameLength)));
    if (name.empty()) {
      offset += length;
      continue;
    }

    IsoEntry entry;
    entry.path = parent.empty() ? name : parent + "/" + name;
    entry.extent = readLe32(directory.data() + offset + 2);
    entry.size = readLe32(directory.data() + offset + 10);
    entry.directory = (directory[offset + 25] & 0x02) != 0;
    entries->push_back(entry);
    if (entry.directory) collectDirectory(file, entry.extent, entry.size, entry.path, depth + 1, entries);
    offset += length;
  }
}

std::vector<IsoEntry> readIsoEntries(std::ifstream& file) {
  std::vector<IsoEntry> entries;
  std::array<uint8_t, kIsoSectorSize> sector{};
  uint32_t rootExtent = 0;
  uint32_t rootSize = 0;
  for (uint32_t sectorIndex = 16; sectorIndex < 64; ++sectorIndex) {
    if (!readExactAt(file, static_cast<uint64_t>(sectorIndex) * kIsoSectorSize, sector.data(), sector.size())) break;
    if (std::memcmp(sector.data() + 1, "CD001", 5) != 0 || sector[6] != 1) continue;
    if (sector[0] == 1) {
      const uint8_t* rootRecord = sector.data() + 156;
      if (rootRecord[0] >= 34) {
        rootExtent = readLe32(rootRecord + 2);
        rootSize = readLe32(rootRecord + 10);
      }
    } else if (sector[0] == 255) {
      break;
    }
  }
  collectDirectory(file, rootExtent, rootSize, "", 0, &entries);
  return entries;
}

const IsoEntry* findEntry(const std::vector<IsoEntry>& entries, const std::string& path) {
  const std::string target = toUpper(path);
  const auto it = std::find_if(entries.begin(), entries.end(), [&](const IsoEntry& entry) {
    return entry.path == target;
  });
  return it == entries.end() ? nullptr : &*it;
}

std::string areaFromPath(const std::string& path) {
  if (containsNoCase(path, "TWOCH") || containsNoCase(path, "2CH")) return "stereo";
  if (containsNoCase(path, "MULTI") || containsNoCase(path, "MCH")) return "multichannel";
  return "stereo";
}

bool parseTwilightAreaToc(
    const std::vector<uint8_t>& bytes,
    const std::string& area,
    const std::vector<IsoEntry>& entries,
    std::vector<SacdIsoTrackInfo>* tracks) {
  if (bytes.size() < 16 || std::memcmp(bytes.data(), "TWTEAREA", 8) != 0 || !tracks) return false;
  const uint32_t count = readLe32(bytes.data() + 8);
  const size_t firstTrackIndex = tracks->size();
  size_t offset = 16;
  bool parsed = false;
  for (uint32_t i = 0; i < count && offset + 64 <= bytes.size(); ++i) {
    if (std::memcmp(bytes.data() + offset, "TWTE1", 5) != 0) break;
    SacdIsoTrackInfo track;
    track.area = area;
    track.trackNumber = static_cast<int>(readLe32(bytes.data() + offset + 8));
    track.startSector = readLe32(bytes.data() + offset + 12);
    track.sectorCount = readLe32(bytes.data() + offset + 16);
    track.channelCount = static_cast<int>(readLe32(bytes.data() + offset + 20));
    track.sampleRate = static_cast<int>(readLe32(bytes.data() + offset + 24));
    track.isDst = readLe32(bytes.data() + offset + 28) != 0;
    const std::string fileName = trimIsoName(toUpper(std::string(
        reinterpret_cast<const char*>(bytes.data() + offset + 32),
        reinterpret_cast<const char*>(bytes.data() + offset + 32 + 24))));
    const IsoEntry* file = fileName.empty() ? nullptr : findEntry(entries, "SACD/" + fileName);
    if (file) {
      track.startSector = file->extent;
      track.sectorCount = std::max<uint64_t>(1, (static_cast<uint64_t>(file->size) + kIsoSectorSize - 1) / kIsoSectorSize);
      track.dataSize = file->size;
      track.isDst = track.isDst || endsWith(file->path, ".DST");
    } else {
      track.dataSize = track.sectorCount * kIsoSectorSize;
    }
    track.dataOffset = track.startSector * kIsoSectorSize;
    track.durationSeconds =
        track.sampleRate > 0 && track.channelCount > 0
            ? static_cast<double>(track.dataSize * 8) /
                  static_cast<double>(static_cast<uint64_t>(track.sampleRate) * static_cast<uint64_t>(track.channelCount))
            : 0.0;
    track.title = "Track " + std::to_string(track.trackNumber);
    track.playable = !track.isDst && track.dataOffset > 0 && track.dataSize > 0;
    if (track.isDst) {
      track.reasonCode = kSacdDstDsdProviderUnavailableReasonCode;
      track.reason = kSacdDstDsdProviderUnavailableReason;
    }
    tracks->push_back(track);
    parsed = true;
    offset += 64;
  }
  while (offset + 16 <= bytes.size()) {
    if (std::memcmp(bytes.data() + offset, "TWDSTFRM", 8) != 0) break;
    const int trackNumber = static_cast<int>(readLe32(bytes.data() + offset + 8));
    const uint32_t frameCount = readLe32(bytes.data() + offset + 12);
    const size_t tableBytes = static_cast<size_t>(frameCount) * sizeof(uint32_t);
    if (offset + 16 + tableBytes > bytes.size()) break;

    auto trackIt = std::find_if(
        tracks->begin() + static_cast<std::ptrdiff_t>(firstTrackIndex),
        tracks->end(),
        [&](const SacdIsoTrackInfo& track) {
          return track.area == area && track.trackNumber == trackNumber && track.isDst;
        });
    if (trackIt != tracks->end()) {
      trackIt->dstFrameSizes.clear();
      trackIt->dstFrameSizes.reserve(frameCount);
      uint64_t frameBytes = 0;
      bool validTable = frameCount > 0;
      for (uint32_t frameIndex = 0; frameIndex < frameCount; ++frameIndex) {
        const uint32_t frameSize = readLe32(bytes.data() + offset + 16 + frameIndex * 4);
        // Frame sizes come from the file and drive the decode read buffer.
        // Entries beyond the Scarletbook DST frame ceiling are corrupt or
        // hostile: reject the whole table rather than allocating for it.
        validTable = validTable && frameSize > 0 && frameSize <= sacd::kScarletbookMaxDstFrameBytes;
        frameBytes += frameSize;
        trackIt->dstFrameSizes.push_back(frameSize);
      }
      if (!validTable || frameBytes > trackIt->dataSize) {
        trackIt->dstFrameSizes.clear();
      }
    }
    offset += 16 + tableBytes;
  }
  return parsed;
}

std::vector<uint8_t> readEntryBytes(std::ifstream& file, const IsoEntry& entry) {
  std::vector<uint8_t> bytes(entry.size);
  if (bytes.empty()) return bytes;
  if (!readExactAt(file, static_cast<uint64_t>(entry.extent) * kIsoSectorSize, bytes.data(), bytes.size())) bytes.clear();
  return bytes;
}

void addMarkerTracks(const std::vector<IsoEntry>& entries, std::vector<SacdIsoTrackInfo>* tracks) {
  if (!tracks) return;
  int stereoTrack = 1;
  int multiTrack = 1;
  for (const auto& entry : entries) {
    if (entry.directory || entry.path.rfind("SACD/", 0) != 0) continue;
    const bool dsd = endsWith(entry.path, ".DSD") || endsWith(entry.path, ".2CH") || endsWith(entry.path, ".MCH");
    const bool dst = endsWith(entry.path, ".DST");
    if (!dsd && !dst) continue;

    SacdIsoTrackInfo track;
    track.area = areaFromPath(entry.path);
    track.trackNumber = track.area == "stereo" ? stereoTrack++ : multiTrack++;
    track.title = "Track " + std::to_string(track.trackNumber);
    track.startSector = entry.extent;
    track.sectorCount = std::max<uint64_t>(1, (static_cast<uint64_t>(entry.size) + kIsoSectorSize - 1) / kIsoSectorSize);
    track.dataOffset = static_cast<uint64_t>(entry.extent) * kIsoSectorSize;
    track.dataSize = entry.size;
    track.channelCount = track.area == "multichannel" ? 6 : 2;
    track.sampleRate = 2822400;
    track.isDst = dst;
    track.durationSeconds =
        static_cast<double>(track.dataSize * 8) /
        static_cast<double>(static_cast<uint64_t>(track.sampleRate) * static_cast<uint64_t>(track.channelCount));
    track.playable = !track.isDst;
    if (track.isDst) {
      track.reasonCode = kSacdDstDsdProviderUnavailableReasonCode;
      track.reason = kSacdDstDsdProviderUnavailableReason;
    }
    tracks->push_back(track);
  }
}

void addScarletbookAreaTracks(
    const sacd::ScarletbookArea& area,
    const sacd::ScarletbookAlbum& album,
    const char* areaName,
    std::vector<SacdIsoTrackInfo>* tracks) {
  if (!area.valid || !tracks) return;
  const std::string albumTitle = !album.albumTitle.empty() ? album.albumTitle : album.discTitle;
  const std::string albumArtist = !album.albumArtist.empty() ? album.albumArtist : album.discArtist;
  for (const auto& sbTrack : area.tracks) {
    SacdIsoTrackInfo track;
    track.area = areaName;
    track.trackNumber = sbTrack.trackNumber;
    track.title = !sbTrack.title.empty() ? sbTrack.title : "Track " + std::to_string(sbTrack.trackNumber);
    track.artist = !sbTrack.performer.empty() ? sbTrack.performer : albumArtist;
    track.albumTitle = albumTitle;
    track.startSector = sbTrack.startLsn;
    track.sectorCount = sbTrack.lengthLsn;
    track.dataOffset = static_cast<uint64_t>(sbTrack.startLsn) * kIsoSectorSize;
    track.dataSize = static_cast<uint64_t>(sbTrack.lengthLsn) * kIsoSectorSize;
    track.channelCount = area.channelCount;
    track.sampleRate = area.sampleRate;
    track.isDst = area.dst;
    track.scarletbook = true;
    track.durationSeconds =
        sbTrack.durationSeconds > 0.0
            ? sbTrack.durationSeconds
            : (track.sampleRate > 0 && track.channelCount > 0
                   ? static_cast<double>(track.dataSize * 8) /
                         static_cast<double>(static_cast<uint64_t>(track.sampleRate) *
                                             static_cast<uint64_t>(track.channelCount))
                   : 0.0);
    track.playable = !track.isDst && track.dataOffset > 0 && track.dataSize > 0;
    if (track.isDst) {
      track.reasonCode = kSacdDstDsdProviderUnavailableReasonCode;
      track.reason = kSacdDstDsdProviderUnavailableReason;
    }
    tracks->push_back(track);
  }
}

bool areaMatches(const SacdIsoTrackInfo& track, const std::string& area) {
  return area.empty() || area == "auto" || track.area == area;
}

bool preferTrack(const SacdIsoTrackInfo& left, const SacdIsoTrackInfo& right, const std::string& requestedArea) {
  if (requestedArea == "stereo" || requestedArea == "multichannel") return left.area == requestedArea && right.area != requestedArea;
  if (left.area != right.area) return left.area == "stereo";
  return left.trackNumber < right.trackNumber;
}

uint64_t dstFrameCountForCompressedWindow(uint64_t compressedBytes, size_t compressedFrameWindow) {
  if (compressedBytes == 0 || compressedFrameWindow == 0) return 0;
  return (compressedBytes + static_cast<uint64_t>(compressedFrameWindow) - 1) /
         static_cast<uint64_t>(compressedFrameWindow);
}

uint64_t dstFrameCount(const SacdIsoTrackInfo& track, size_t compressedFrameWindow) {
  if (!track.dstFrameSizes.empty()) return track.dstFrameSizes.size();
  return dstFrameCountForCompressedWindow(track.dataSize, compressedFrameWindow);
}

uint64_t dstCompressedOffsetForFrame(const SacdIsoTrackInfo& track, uint64_t frameIndex, size_t compressedFrameWindow) {
  if (track.dstFrameSizes.empty()) {
    return std::min(frameIndex * static_cast<uint64_t>(compressedFrameWindow), track.dataSize);
  }
  uint64_t offset = 0;
  const size_t count = std::min<size_t>(static_cast<size_t>(frameIndex), track.dstFrameSizes.size());
  for (size_t index = 0; index < count; ++index) {
    offset += track.dstFrameSizes[index];
  }
  return std::min(offset, track.dataSize);
}

double dstDurationSecondsForDecodedFrames(const SacdIsoTrackInfo& track, size_t decodedFrameBytes, uint64_t frameCount) {
  if (decodedFrameBytes == 0 || frameCount == 0 || track.sampleRate <= 0 || track.channelCount <= 0) return 0.0;
  const long double decodedBytes = static_cast<long double>(decodedFrameBytes) * static_cast<long double>(frameCount);
  const long double decodedBits = decodedBytes * 8.0L;
  const long double bitsPerSecond =
      static_cast<long double>(track.sampleRate) * static_cast<long double>(track.channelCount);
  return static_cast<double>(decodedBits / bitsPerSecond);
}

}  // namespace

struct SacdIsoDemuxer::Impl {
  ParsedSource source;
  std::ifstream file;
  std::vector<SacdIsoTrackInfo> tracks;
  int currentTrackIndex = -1;
  uint64_t readOffset = 0;
  bool eof = true;
  AudioStreamInfo streamInfo;
  // DST decode state (only used when the selected track isDst and a DSD-
  // preserving provider is registered).
  SacdDstDecoderProvider* dstProvider = nullptr;
  std::unique_ptr<SacdDstDecoderProvider> ownedDstProvider;
  std::vector<uint8_t> decodedDsdBuffer;   // decoded raw DSD bytes for the current frame
  std::vector<uint8_t> compressedFrameBuffer;
  size_t decodedSize = 0;                  // valid decoded bytes in decodedDsdBuffer
  size_t decodedOffset = 0;                // read cursor inside decodedDsdBuffer
  size_t dstDecodedSkipBytes = 0;          // decoded bytes to discard after a DST seek
  uint64_t dstCompressedOffset = 0;        // byte cursor into the track's compressed DST stream
  uint64_t dstFrameIndex = 0;              // frame cursor for indexed variable-size DST streams
  bool dstActive = false;                  // a DST track is being decoded through the provider

  // Scarletbook multiplexed-sector state (real SACD discs). The track extent
  // is a run of 2048-byte audio sectors whose packet tables interleave audio,
  // supplementary and padding packets; audio payload is extracted per sector.
  bool sbActive = false;                    // selected track uses Scarletbook audio sectors
  uint64_t sbSectorIndex = 0;               // sector cursor within the track extent
  std::vector<uint8_t> sbSectorBuffer;      // raw sector scratch
  std::vector<sacd::ScarletbookPacket> sbPackets;
  size_t sbPacketIndex = 0;                 // next unconsumed packet in sbPackets
  std::vector<uint8_t> sbAudioBuffer;       // extracted plain-DSD payload bytes
  size_t sbAudioOffset = 0;                 // read cursor inside sbAudioBuffer
  std::vector<uint8_t> sbFrameBuffer;       // DST access unit being assembled
  bool sbFrameOpen = false;                 // saw the frame_start packet of the current frame

  void resetScarletbookCursor() {
    sbSectorIndex = 0;
    sbPackets.clear();
    sbPacketIndex = 0;
    sbAudioBuffer.clear();
    sbAudioOffset = 0;
    sbFrameBuffer.clear();
    sbFrameOpen = false;
  }

  // Loads the next audio sector of the track extent and parses its packet
  // table. Malformed sectors are skipped; returns false at the extent end or
  // on an I/O failure.
  bool sbLoadNextSector(const SacdIsoTrackInfo& track) {
    while (sbSectorIndex < track.sectorCount) {
      const uint64_t sector = sbSectorIndex++;
      sacd::resizeByteScratchForOverwrite(sbSectorBuffer, kIsoSectorSize);
      file.clear();
      if (!file.seekg(
              static_cast<std::streamoff>(track.dataOffset + sector * kIsoSectorSize), std::ios::beg) ||
          !file.read(reinterpret_cast<char*>(sbSectorBuffer.data()),
                     static_cast<std::streamsize>(kIsoSectorSize)) ||
          static_cast<size_t>(file.gcount()) != kIsoSectorSize) {
        return false;
      }
      if (!sacd::parseScarletbookAudioSector(sbSectorBuffer.data(), kIsoSectorSize, &sbPackets)) {
        continue;  // skip a malformed sector rather than aborting the track
      }
      sbPacketIndex = 0;
      if (!sbPackets.empty()) return true;
    }
    return false;
  }

  // Plain-DSD Scarletbook track: refills sbAudioBuffer with the concatenated
  // audio-packet payloads of the following sectors. After a seek, payload is
  // only accepted from the next frame_start packet onward so the channel
  // interleave stays aligned.
  bool sbFillAudio(const SacdIsoTrackInfo& track) {
    sbAudioBuffer.clear();
    sbAudioOffset = 0;
    while (sbAudioBuffer.empty()) {
      if (sbPacketIndex >= sbPackets.size() && !sbLoadNextSector(track)) return false;
      while (sbPacketIndex < sbPackets.size()) {
        const sacd::ScarletbookPacket& packet = sbPackets[sbPacketIndex++];
        if (packet.dataType != sacd::kScarletbookPacketTypeAudio || packet.length == 0) continue;
        if (!sbFrameOpen && !packet.frameStart) continue;
        sbFrameOpen = true;
        sbAudioBuffer.insert(
            sbAudioBuffer.end(),
            sbSectorBuffer.data() + packet.offset,
            sbSectorBuffer.data() + packet.offset + packet.length);
      }
    }
    return true;
  }

  // DST Scarletbook track: assembles the next complete DST access unit from
  // the audio packets (frames start at frame_start packets and may span
  // sectors). Returns false when the extent is exhausted.
  bool sbNextDstFrame(const SacdIsoTrackInfo& track, std::vector<uint8_t>* frame) {
    while (true) {
      if (sbPacketIndex >= sbPackets.size()) {
        if (!sbLoadNextSector(track)) {
          if (sbFrameOpen && !sbFrameBuffer.empty()) {
            frame->swap(sbFrameBuffer);
            sbFrameBuffer.clear();
            sbFrameOpen = false;
            return true;
          }
          return false;
        }
      }
      while (sbPacketIndex < sbPackets.size()) {
        const sacd::ScarletbookPacket& packet = sbPackets[sbPacketIndex];
        if (packet.dataType != sacd::kScarletbookPacketTypeAudio || packet.length == 0) {
          ++sbPacketIndex;
          continue;
        }
        if (packet.frameStart && sbFrameOpen && !sbFrameBuffer.empty()) {
          // The accumulated frame is complete; leave this packet for the next
          // call so it starts the following frame.
          frame->swap(sbFrameBuffer);
          sbFrameBuffer.clear();
          sbFrameOpen = false;
          return true;
        }
        if (!sbFrameOpen && !packet.frameStart) {
          ++sbPacketIndex;  // mid-frame data after a seek; wait for a frame start
          continue;
        }
        sbFrameOpen = true;
        if (sbFrameBuffer.size() + packet.length > sacd::kScarletbookMaxDstFrameBytes) {
          // Malformed oversized frame: drop it and resynchronize.
          sbFrameBuffer.clear();
          sbFrameOpen = false;
          ++sbPacketIndex;
          continue;
        }
        sbFrameBuffer.insert(
            sbFrameBuffer.end(),
            sbSectorBuffer.data() + packet.offset,
            sbSectorBuffer.data() + packet.offset + packet.length);
        ++sbPacketIndex;
      }
    }
  }
};

SacdIsoDemuxer::SacdIsoDemuxer() : impl_(std::make_unique<Impl>()) {}

SacdIsoDemuxer::~SacdIsoDemuxer() {
  close();
}

void SacdIsoDemuxer::setDstDecoderProvider(SacdDstDecoderProvider* provider) {
  impl_->dstProvider = provider;
}

bool SacdIsoDemuxer::open(const std::string& path, std::string* error) {
  close();
  impl_->source = parseSource(path);

  SacdIsoEntryProbe probe = probeSacdIsoEntry(impl_->source.path);
  if (!probe.isSacdIso()) {
    if (error) *error = "Not a SACD ISO file";
    return false;
  }
  if (!probe.hasSacdMarkers) {
    if (error) *error = probe.reason;
    return false;
  }

  impl_->file.open(impl_->source.path, std::ios::binary);
  if (!impl_->file) {
    if (error) *error = "Failed to open ISO file for reading";
    return false;
  }

  // Real Scarletbook discs first: Master TOC at LSN 510 + area TOCs. Falls
  // back to the legacy TWTE* fixture format / filename heuristics when the
  // Scarletbook signatures are absent or malformed.
  sacd::ScarletbookDisc scarletbook;
  if (sacd::parseScarletbookDisc(impl_->file, fileSize(impl_->file), &scarletbook)) {
    addScarletbookAreaTracks(scarletbook.stereo, scarletbook.album, "stereo", &impl_->tracks);
    addScarletbookAreaTracks(scarletbook.multichannel, scarletbook.album, "multichannel", &impl_->tracks);
  }

  if (impl_->tracks.empty()) {
    const std::vector<IsoEntry> entries = readIsoEntries(impl_->file);
    for (const auto& entry : entries) {
      if (entry.directory || entry.path.rfind("SACD/", 0) != 0 || entry.path.find("AREA.TOC") == std::string::npos) continue;
      const auto bytes = readEntryBytes(impl_->file, entry);
      parseTwilightAreaToc(bytes, areaFromPath(entry.path), entries, &impl_->tracks);
    }
    if (impl_->tracks.empty()) addMarkerTracks(entries, &impl_->tracks);
  }

  std::sort(impl_->tracks.begin(), impl_->tracks.end(), [](const SacdIsoTrackInfo& left, const SacdIsoTrackInfo& right) {
    if (left.area != right.area) return left.area < right.area;
    return left.trackNumber < right.trackNumber;
  });

  // When a DSD-preserving DST decoder provider is registered, DST-compressed
  // tracks become playable through the DoP / native-DSD pipeline. Flip the
  // playable flag and clear the unavailability reason. Tracks stay unplayable
  // (dst_dsd_provider_unavailable) when no provider is registered.
  const bool dstProviderAvailable = impl_->dstProvider != nullptr && [this]() {
    std::string reason;
    return impl_->dstProvider->available(&reason);
  }();
  if (dstProviderAvailable) {
    for (auto& track : impl_->tracks) {
      if (track.isDst && track.dataOffset > 0 && track.dataSize > 0) {
        track.playable = true;
        track.reasonCode.clear();
        track.reason.clear();
      }
    }
  }
  (void)dstProviderAvailable;  // referenced again below for capability reporting

  if (impl_->tracks.empty()) {
    if (error) *error = "SACD ISO contains no recognized DSD area tracks";
    close();
    return false;
  }

  if (impl_->source.track > 0) {
    return selectTrack(impl_->source.area, impl_->source.track, error);
  }

  impl_->eof = true;
  return true;
}

void SacdIsoDemuxer::close() {
  if (impl_->file.is_open()) impl_->file.close();
  impl_->source = {};
  impl_->tracks.clear();
  impl_->currentTrackIndex = -1;
  impl_->readOffset = 0;
  impl_->eof = true;
  impl_->streamInfo = {};
  impl_->decodedDsdBuffer.clear();
  impl_->decodedSize = 0;
  impl_->decodedOffset = 0;
  impl_->dstDecodedSkipBytes = 0;
  impl_->dstCompressedOffset = 0;
  impl_->dstFrameIndex = 0;
  impl_->dstActive = false;
  impl_->sbActive = false;
  impl_->resetScarletbookCursor();
}

const std::vector<SacdIsoTrackInfo>& SacdIsoDemuxer::tracks() const {
  return impl_->tracks;
}

bool SacdIsoDemuxer::selectTrack(int trackNumber, std::string* error) {
  return selectTrack(impl_->source.area, trackNumber, error);
}

bool SacdIsoDemuxer::selectTrack(const std::string& area, int trackNumber, std::string* error) {
  if (!impl_->file.is_open()) {
    if (error) *error = "SACD ISO demuxer is not open";
    return false;
  }
  std::vector<int> candidates;
  for (size_t i = 0; i < impl_->tracks.size(); ++i) {
    const auto& track = impl_->tracks[i];
    if (track.trackNumber == trackNumber && areaMatches(track, toLower(area))) {
      candidates.push_back(static_cast<int>(i));
    }
  }
  if (candidates.empty()) {
    if (error) *error = "Requested SACD ISO track or area is unavailable";
    return false;
  }
  int selected = candidates.front();
  for (int candidate : candidates) {
    if (preferTrack(impl_->tracks[static_cast<size_t>(candidate)], impl_->tracks[static_cast<size_t>(selected)], toLower(area))) {
      selected = candidate;
    }
  }

  const auto& track = impl_->tracks[static_cast<size_t>(selected)];
  if (!track.playable) {
    if (error) *error = track.reason.empty() ? kSacdDstDsdProviderUnavailableReason : track.reason;
    return false;
  }
  const uint64_t size = fileSize(impl_->file);
  if (track.dataOffset == 0 || track.dataSize == 0 || track.dataOffset >= size) {
    if (error) *error = "SACD ISO track points outside the image";
    return false;
  }

  // Reset any previous DST decode state before selecting a new track.
  impl_->decodedDsdBuffer.clear();
  impl_->decodedSize = 0;
  impl_->decodedOffset = 0;
  impl_->dstDecodedSkipBytes = 0;
  impl_->dstCompressedOffset = 0;
  impl_->dstActive = false;
  impl_->sbActive = false;
  impl_->resetScarletbookCursor();
  if (impl_->dstProvider != nullptr) impl_->dstProvider->reset();

  impl_->currentTrackIndex = selected;
  impl_->readOffset = 0;
  impl_->eof = false;
  impl_->streamInfo = {};
  impl_->streamInfo.source = impl_->source.path + "?area=" + track.area + "&track=" + std::to_string(track.trackNumber);
  impl_->streamInfo.codec = track.isDst ? "dst" : "dsd";
  impl_->streamInfo.durationSeconds = track.durationSeconds;
  impl_->streamInfo.sourceLossless = true;
  impl_->streamInfo.isDsd = true;
  impl_->streamInfo.dsdMode = DsdMode::Pcm;
  impl_->streamInfo.dsdRate = dsdRateFromSampleRate(track.sampleRate);
  impl_->streamInfo.sourceFormat.sampleRate = track.sampleRate;
  impl_->streamInfo.sourceFormat.channelCount = track.channelCount;
  impl_->streamInfo.sourceFormat.bitDepth = 1;
  impl_->streamInfo.sourceFormat.sampleFormat = AudioSampleFormat::DsdInt8Msb1;
  impl_->streamInfo.decodedFormat = impl_->streamInfo.sourceFormat;
  impl_->file.seekg(static_cast<std::streamoff>(track.dataOffset), std::ios::beg);

  impl_->sbActive = track.scarletbook;

  // For DST-compressed tracks, initialize the DSD-preserving decoder so
  // readBytes can decode frame-by-frame. Uncompressed DSD tracks read raw
  // bytes directly as before.
  if (track.isDst) {
    if (impl_->dstProvider == nullptr) {
      if (error) *error = kSacdDstDsdProviderUnavailableReason;
      return false;
    }
    std::string dstError;
    if (!impl_->dstProvider->open(track.channelCount, track.sampleRate, &dstError)) {
      if (error) *error = dstError.empty() ? kSacdDstDsdProviderFailedReasonCode : dstError;
      return false;
    }
    if (!impl_->sbActive) {
      const size_t frameBytesPerChannel = impl_->dstProvider->frameBytesPerChannel(track.sampleRate);
      const size_t decodedFrameBytes = frameBytesPerChannel * static_cast<size_t>(track.channelCount);
      const size_t compressedFrameWindow = decodedFrameBytes > 0 ? 1 + decodedFrameBytes : 0;
      const uint64_t decodedFrameCount = dstFrameCount(track, compressedFrameWindow);
      impl_->streamInfo.durationSeconds = dstDurationSecondsForDecodedFrames(track, decodedFrameBytes, decodedFrameCount);
    }
    // Scarletbook DST tracks keep the TOC time-code duration; frames are
    // assembled from the multiplexed audio packets in readScarletbookBytes.
    impl_->dstActive = true;
  }
  return true;
}

size_t SacdIsoDemuxer::readBytes(uint8_t* output, size_t maxBytes) {
  if (!output || maxBytes == 0 || impl_->currentTrackIndex < 0 || impl_->eof || !impl_->file.is_open()) return 0;
  const auto& track = impl_->tracks[static_cast<size_t>(impl_->currentTrackIndex)];

  // Real Scarletbook tracks read multiplexed audio sectors: audio packets are
  // demultiplexed and (for DST areas) assembled into access units for the
  // DSD-preserving provider.
  if (impl_->sbActive) {
    return readScarletbookBytes(track, output, maxBytes);
  }

  // DST-compressed tracks: decode frame-by-frame through the DSD-preserving
  // provider. Each DST frame is an independent access unit that decodes to
  // frameBytesPerChannel*channels raw DSD bytes. readBytes drains the decoded
  // buffer before decoding the next frame.
  if (impl_->dstActive) {
    return readDstBytes(track, output, maxBytes);
  }

  const uint64_t remaining = track.dataSize > impl_->readOffset ? track.dataSize - impl_->readOffset : 0;
  const size_t toRead = static_cast<size_t>(std::min<uint64_t>(remaining, maxBytes));
  if (toRead == 0) {
    impl_->eof = true;
    return 0;
  }
  impl_->file.seekg(static_cast<std::streamoff>(track.dataOffset + impl_->readOffset), std::ios::beg);
  impl_->file.read(reinterpret_cast<char*>(output), static_cast<std::streamsize>(toRead));
  const size_t read = static_cast<size_t>(std::max<std::streamsize>(0, impl_->file.gcount()));
  impl_->readOffset += read;
  impl_->eof = read == 0 || impl_->readOffset >= track.dataSize;
  return read;
}

size_t SacdIsoDemuxer::readDstBytes(const SacdIsoTrackInfo& track, uint8_t* output, size_t maxBytes) {
  if (impl_->dstProvider == nullptr) {
    impl_->eof = true;
    return 0;
  }
  const size_t frameBytesPerChannel = impl_->dstProvider->frameBytesPerChannel(track.sampleRate);
  if (frameBytesPerChannel == 0 || track.channelCount <= 0) {
    impl_->eof = true;
    return 0;
  }
  const size_t decodedFrameBytes = frameBytesPerChannel * static_cast<size_t>(track.channelCount);
  // Each DST access unit is read as one frame. The compressed payload is
  // variable-length, but the uncompressed frame path (first bit 0) is exactly
  // 1 header byte + decodedFrameBytes. We read that window per frame; the
  // vendored dstdec consumes what it needs and the provider reports bytes
  // written. Frame boundaries are derived from the decoded size so the
  // pipeline stays aligned for the common uncompressed-frame case.
  const size_t compressedFrameWindow = 1 + decodedFrameBytes;
  sacd::resizeByteScratchForOverwrite(impl_->compressedFrameBuffer, compressedFrameWindow);

  size_t delivered = 0;
  while (delivered < maxBytes) {
    // Drain any remaining decoded bytes from the current frame first.
    if (impl_->decodedOffset < impl_->decodedSize) {
      const size_t available = impl_->decodedSize - impl_->decodedOffset;
      const size_t copyBytes = std::min(available, maxBytes - delivered);
      std::memcpy(output + delivered, impl_->decodedDsdBuffer.data() + impl_->decodedOffset, copyBytes);
      impl_->decodedOffset += copyBytes;
      delivered += copyBytes;
      impl_->readOffset += copyBytes;
      continue;
    }

    // No buffered decoded bytes: decode the next DST frame.
    if (impl_->dstCompressedOffset >= track.dataSize) {
      impl_->eof = true;
      break;
    }
    const uint64_t remaining = track.dataSize - impl_->dstCompressedOffset;
    size_t readSize = static_cast<size_t>(std::min<uint64_t>(remaining, compressedFrameWindow));
    if (!track.dstFrameSizes.empty()) {
      if (impl_->dstFrameIndex >= track.dstFrameSizes.size()) {
        impl_->eof = true;
        break;
      }
      readSize = track.dstFrameSizes[static_cast<size_t>(impl_->dstFrameIndex)];
      if (readSize == 0 || readSize > remaining) {
        impl_->eof = true;
        break;
      }
      // Defense in depth: the table entry controls the file.read length below.
      // Never let it exceed the scratch buffer it lands in — grow the scratch
      // (entries are capped at kScarletbookMaxDstFrameBytes during parsing).
      if (readSize > impl_->compressedFrameBuffer.size()) {
        sacd::resizeByteScratchForOverwrite(impl_->compressedFrameBuffer, readSize);
      }
    }
    if (!impl_->file.seekg(static_cast<std::streamoff>(track.dataOffset + impl_->dstCompressedOffset), std::ios::beg) ||
        !impl_->file.read(
            reinterpret_cast<char*>(impl_->compressedFrameBuffer.data()),
            static_cast<std::streamsize>(readSize))) {
      impl_->eof = true;
      break;
    }
    const size_t frameRead = static_cast<size_t>(std::max<std::streamsize>(0, impl_->file.gcount()));
    if (frameRead == 0) {
      impl_->eof = true;
      break;
    }
    sacd::resizeByteScratchForOverwrite(impl_->decodedDsdBuffer, decodedFrameBytes);
    std::string dstError;
    const size_t decoded = impl_->dstProvider->decodeFrame(
        impl_->compressedFrameBuffer.data(),
        frameRead,
        impl_->decodedDsdBuffer.data(),
        decodedFrameBytes,
        &dstError);
    impl_->dstCompressedOffset += frameRead;
    ++impl_->dstFrameIndex;
    if (decoded == 0) {
      // Decode failure: stop honestly rather than emit garbage DSD.
      impl_->decodedDsdBuffer.clear();
      impl_->decodedSize = 0;
      impl_->decodedOffset = 0;
      impl_->dstDecodedSkipBytes = 0;
      impl_->eof = true;
      break;
    }
    impl_->decodedSize = std::min(decoded, decodedFrameBytes);
    const size_t skipBytes = std::min(impl_->dstDecodedSkipBytes, impl_->decodedSize);
    impl_->decodedOffset = skipBytes;
    impl_->dstDecodedSkipBytes -= skipBytes;
    // Loop continues to drain the freshly filled decoded buffer.
  }
  impl_->eof = impl_->eof || (delivered == 0 && impl_->dstCompressedOffset >= track.dataSize);
  return delivered;
}

size_t SacdIsoDemuxer::readScarletbookBytes(const SacdIsoTrackInfo& track, uint8_t* output, size_t maxBytes) {
  size_t delivered = 0;

  if (!track.isDst) {
    // Plain-DSD area: deliver demultiplexed audio-packet payload directly.
    while (delivered < maxBytes) {
      if (impl_->sbAudioOffset < impl_->sbAudioBuffer.size()) {
        const size_t available = impl_->sbAudioBuffer.size() - impl_->sbAudioOffset;
        const size_t copyBytes = std::min(available, maxBytes - delivered);
        std::memcpy(output + delivered, impl_->sbAudioBuffer.data() + impl_->sbAudioOffset, copyBytes);
        impl_->sbAudioOffset += copyBytes;
        delivered += copyBytes;
        impl_->readOffset += copyBytes;
        continue;
      }
      if (!impl_->sbFillAudio(track)) {
        impl_->eof = true;
        break;
      }
    }
    return delivered;
  }

  // DST area: assemble access units from the multiplexed packets and decode
  // them through the DSD-preserving provider.
  if (impl_->dstProvider == nullptr) {
    impl_->eof = true;
    return 0;
  }
  const size_t frameBytesPerChannel = impl_->dstProvider->frameBytesPerChannel(track.sampleRate);
  const size_t decodedFrameBytes = frameBytesPerChannel * static_cast<size_t>(track.channelCount);
  if (decodedFrameBytes == 0) {
    impl_->eof = true;
    return 0;
  }
  while (delivered < maxBytes) {
    if (impl_->decodedOffset < impl_->decodedSize) {
      const size_t available = impl_->decodedSize - impl_->decodedOffset;
      const size_t copyBytes = std::min(available, maxBytes - delivered);
      std::memcpy(output + delivered, impl_->decodedDsdBuffer.data() + impl_->decodedOffset, copyBytes);
      impl_->decodedOffset += copyBytes;
      delivered += copyBytes;
      impl_->readOffset += copyBytes;
      continue;
    }
    std::vector<uint8_t> frame;
    if (!impl_->sbNextDstFrame(track, &frame) || frame.empty()) {
      impl_->eof = true;
      break;
    }
    sacd::resizeByteScratchForOverwrite(impl_->decodedDsdBuffer, decodedFrameBytes);
    std::string dstError;
    const size_t decoded = impl_->dstProvider->decodeFrame(
        frame.data(), frame.size(), impl_->decodedDsdBuffer.data(), decodedFrameBytes, &dstError);
    if (decoded == 0) {
      // Decode failure: stop honestly rather than emit garbage DSD.
      impl_->decodedDsdBuffer.clear();
      impl_->decodedSize = 0;
      impl_->decodedOffset = 0;
      impl_->dstDecodedSkipBytes = 0;
      impl_->eof = true;
      break;
    }
    impl_->decodedSize = std::min(decoded, decodedFrameBytes);
    const size_t skipBytes = std::min(impl_->dstDecodedSkipBytes, impl_->decodedSize);
    impl_->decodedOffset = skipBytes;
    impl_->dstDecodedSkipBytes -= skipBytes;
  }
  return delivered;
}

size_t SacdIsoDemuxer::readFrames(PcmBlock& output, std::string* error) {
  if (audioFormatBytesPerFrame(output.format) == 0) {
    if (error) *error = "Invalid SACD ISO output format";
    return 0;
  }
  const size_t read = readBytes(output.data, output.byteSize);
  return read / audioFormatBytesPerFrame(output.format);
}

bool SacdIsoDemuxer::seek(double seconds, std::string* error) {
  if (impl_->currentTrackIndex < 0) {
    if (error) *error = "No SACD ISO track selected";
    return false;
  }
  const auto& track = impl_->tracks[static_cast<size_t>(impl_->currentTrackIndex)];

  if (impl_->sbActive) {
    // Scarletbook seek: jump to the proportional sector inside the track
    // extent and resynchronize on the next frame_start packet. This is
    // frame-accurate to within one audio frame (1/75 s).
    uint64_t targetSector = 0;
    if (track.durationSeconds > 0.0 && track.sectorCount > 0) {
      const double ratio = std::clamp(std::max(0.0, seconds) / track.durationSeconds, 0.0, 1.0);
      targetSector = static_cast<uint64_t>(static_cast<double>(track.sectorCount) * ratio);
      targetSector = std::min(targetSector, track.sectorCount);
    }
    impl_->resetScarletbookCursor();
    impl_->sbSectorIndex = targetSector;
    impl_->decodedDsdBuffer.clear();
    impl_->decodedSize = 0;
    impl_->decodedOffset = 0;
    impl_->dstDecodedSkipBytes = 0;
    if (track.sampleRate > 0 && track.channelCount > 0) {
      const long double decodedBytesPerSecond =
          (static_cast<long double>(track.sampleRate) * static_cast<long double>(track.channelCount)) / 8.0L;
      impl_->readOffset = static_cast<uint64_t>(std::llround(std::max(0.0, seconds) * static_cast<double>(decodedBytesPerSecond)));
    } else {
      impl_->readOffset = 0;
    }
    impl_->eof = targetSector >= track.sectorCount;
    if (impl_->dstProvider) impl_->dstProvider->reset();
    return true;
  }

  if (impl_->dstActive) {
    const size_t frameBytesPerChannel = impl_->dstProvider ? impl_->dstProvider->frameBytesPerChannel(track.sampleRate) : 0;
    const size_t decodedFrameBytes = frameBytesPerChannel * static_cast<size_t>(track.channelCount);
    const size_t compressedFrameWindow = decodedFrameBytes > 0 ? 1 + decodedFrameBytes : 0;
    const uint64_t frameCount = dstFrameCount(track, compressedFrameWindow);
    const uint64_t decodedDataSize = static_cast<uint64_t>(decodedFrameBytes) * frameCount;
    if (decodedFrameBytes == 0 || decodedDataSize == 0 || track.sampleRate <= 0 || track.channelCount <= 0) {
      impl_->eof = true;
      return true;
    }

    const long double decodedBytesPerSecond =
        (static_cast<long double>(track.sampleRate) * static_cast<long double>(track.channelCount)) / 8.0L;
    uint64_t byteOffset = static_cast<uint64_t>(std::llround(std::max(0.0, seconds) * decodedBytesPerSecond));
    byteOffset = std::min(byteOffset, decodedDataSize);
    byteOffset -= byteOffset % static_cast<uint64_t>(track.channelCount);
    impl_->readOffset = byteOffset;
    impl_->eof = impl_->readOffset >= decodedDataSize;
    impl_->decodedDsdBuffer.clear();
    impl_->decodedSize = 0;
    impl_->decodedOffset = 0;
    impl_->dstDecodedSkipBytes = static_cast<size_t>(impl_->readOffset % decodedFrameBytes);
    const uint64_t frameIndex = impl_->readOffset / decodedFrameBytes;
    impl_->dstFrameIndex = impl_->eof ? frameCount : frameIndex;
    impl_->dstCompressedOffset = impl_->eof ? track.dataSize : dstCompressedOffsetForFrame(track, frameIndex, compressedFrameWindow);
    if (impl_->dstProvider) impl_->dstProvider->reset();
    return true;
  }

  uint64_t byteOffset = 0;
  if (track.durationSeconds > 0.0) {
    const double ratio = std::clamp(std::max(0.0, seconds) / track.durationSeconds, 0.0, 1.0);
    byteOffset = static_cast<uint64_t>(static_cast<double>(track.dataSize) * ratio);
  }
  if (track.channelCount > 0) byteOffset -= byteOffset % static_cast<uint64_t>(track.channelCount);
  impl_->readOffset = std::min(byteOffset, track.dataSize);
  impl_->eof = impl_->readOffset >= track.dataSize;

  return true;
}

bool SacdIsoDemuxer::eof() const {
  return impl_->eof;
}

const AudioStreamInfo& SacdIsoDemuxer::streamInfo() const {
  return impl_->streamInfo;
}

}  // namespace twilight::audio
