#pragma once

#include "../core/Utf8Path.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

namespace twilight::audio {

enum class SacdIsoEntryStatus {
  NotSacdIso,
  Supported,
  Unsupported
};

struct SacdIsoEntryProbe {
  SacdIsoEntryStatus status = SacdIsoEntryStatus::NotSacdIso;
  std::string source;
  std::string reasonCode;
  std::string reason;
  std::string codec;
  std::string container;
  bool isIso9660 = false;
  bool hasSacdMarkers = false;
  bool isDsd = false;
  bool hasDst = false;
  bool playable = false;
  std::vector<std::string> markers;

  bool isSacdIso() const {
    return status != SacdIsoEntryStatus::NotSacdIso;
  }

  bool unsupported() const {
    return status == SacdIsoEntryStatus::Unsupported;
  }
};

inline constexpr const char* kSacdIsoCodecName = "sacd_iso";
inline constexpr const char* kSacdIsoContainerName = "SACD ISO";
inline constexpr const char* kSacdIsoUnsupportedReasonCode = "sacd_iso_unsupported";
inline constexpr const char* kSacdIsoUnsupportedReason =
    "SACD ISO recognized but no uncompressed DSD area is playable";
inline constexpr const char* kSacdIsoOpenFailedReasonCode = "sacd_iso_open_failed";
inline constexpr const char* kSacdIsoNotIso9660ReasonCode = "not_iso9660";
inline constexpr const char* kSacdIsoMissingMarkersReasonCode = "iso9660_without_sacd_markers";
inline constexpr const char* kSacdDstCodecName = "dst";
inline constexpr const char* kSacdDstFfmpegProviderName = "ffmpeg";
inline constexpr const char* kSacdDstNoProviderReasonCode = "dst_provider_unavailable";
inline constexpr const char* kSacdDstNoProviderReason =
    "DST decoding unavailable: FFmpeg DST decoder is unavailable and no optional DST provider is registered";
inline constexpr const char* kSacdDstDsdProviderUnavailableReasonCode = "dst_dsd_provider_unavailable";
inline constexpr const char* kSacdDstDsdProviderUnavailableReason =
    "SACD DST requires a DSD-preserving provider; PCM-only DST decoding is not accepted for Native DSD or DoP";
inline constexpr const char* kSacdDstDsdProviderFailedReasonCode = "dst_dsd_provider_failed";
inline constexpr const char* kSacdDstProviderRejectedReasonCode = "dst_provider_rejected";

class SacdDstProvider {
 public:
  virtual ~SacdDstProvider() = default;
  virtual const char* name() const = 0;
  virtual bool available(std::string* reason) const = 0;
  virtual bool preservesDsd() const { return false; }
};

// Decode-capable DSD-preserving DST provider contract. Selection (above) stays
// separate from decode mechanics: the demuxer owns a SacdDstDecoderProvider
// instance and drives frame-by-frame decode through this interface. The output
// is raw DSD bytes (MSB-first, DffInterleaved) matching the pipeline expected
// by DsdReader::openSacdIso.
class SacdDstDecoderProvider {
 public:
  virtual ~SacdDstDecoderProvider() = default;
  virtual const char* name() const = 0;
  virtual bool available(std::string* reason) const = 0;
  // Prepare to decode a track with the given channel count and DSD sample rate
  // (e.g. 2822400 for DSD64). Returns false on unsupported config.
  virtual bool open(int channels, int sampleRate, std::string* error) = 0;
  // Decode one compressed DST frame into dsdOut. dstFrameBytes/dstFrameSize is
  // exactly one DST access unit. dsdOut must hold channels*frameBytesPerChannel
  // bytes. Returns bytes written (0 on error). Each frame is independently
  // decodable, so callers may reset between frames.
  virtual size_t decodeFrame(const uint8_t* dstFrameBytes,
                             size_t dstFrameSize,
                             uint8_t* dsdOut,
                             size_t dsdOutSize,
                             std::string* error) = 0;
  // Bytes of raw DSD produced per channel per frame (e.g. 4704 for DSD64).
  virtual size_t frameBytesPerChannel(int sampleRate) const = 0;
  virtual void reset() = 0;
};

// Factory: returns the built-in DstDecoder-backed provider, or nullptr if the
// DSD-preserving DST decoder is unavailable in this build.
std::unique_ptr<SacdDstDecoderProvider> createDefaultSacdDstDecoderProvider();

struct SacdDstProviderSelection {
  bool available = false;
  std::string provider;
  std::string reasonCode;
  std::string reason;
};

inline std::string sacdIsoExtensionOf(const std::string& source) {
  std::string cleanSource = source;
  const size_t qm = cleanSource.find('?');
  if (qm != std::string::npos) {
    cleanSource = cleanSource.substr(0, qm);
  }
  const size_t slash = cleanSource.find_last_of("/\\");
  const size_t dot = cleanSource.find_last_of('.');
  if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) return "";

  std::string extension = cleanSource.substr(dot + 1);
  std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return extension;
}

inline SacdDstProviderSelection selectSacdDstProvider(bool ffmpegDstAvailable, const SacdDstProvider* fallbackProvider) {
  SacdDstProviderSelection selection;
  if (ffmpegDstAvailable) {
    selection.available = false;
    selection.provider = kSacdDstFfmpegProviderName;
    selection.reasonCode = kSacdDstDsdProviderUnavailableReasonCode;
    selection.reason = kSacdDstDsdProviderUnavailableReason;
    return selection;
  }

  if (fallbackProvider) {
    std::string reason;
    const bool providerAvailable = fallbackProvider->available(&reason);
    const bool providerPreservesDsd = fallbackProvider->preservesDsd();
    if (providerAvailable && providerPreservesDsd) {
      selection.available = true;
      selection.provider = fallbackProvider->name() ? fallbackProvider->name() : "";
      return selection;
    }
    selection.provider = fallbackProvider->name() ? fallbackProvider->name() : "";
    selection.reasonCode = providerAvailable ? kSacdDstDsdProviderUnavailableReasonCode : kSacdDstProviderRejectedReasonCode;
    selection.reason = reason.empty()
                           ? (selection.reasonCode == kSacdDstDsdProviderUnavailableReasonCode
                                  ? kSacdDstDsdProviderUnavailableReason
                                  : "Optional DST provider is unavailable")
                           : reason;
    return selection;
  }

  selection.reasonCode = kSacdDstDsdProviderUnavailableReasonCode;
  selection.reason = kSacdDstDsdProviderUnavailableReason;
  return selection;
}

inline uint32_t sacdReadLe32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
}

inline bool sacdReadExactAt(std::ifstream& file, uint64_t offset, uint8_t* data, size_t size) {
  file.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
  if (!file) return false;
  file.read(reinterpret_cast<char*>(data), static_cast<std::streamsize>(size));
  return static_cast<size_t>(file.gcount()) == size;
}

inline std::string sacdUpperIsoIdentifier(std::string value) {
  const size_t version = value.find(';');
  if (version != std::string::npos) value.resize(version);
  while (!value.empty() && (value.back() == '.' || value.back() == ' ')) value.pop_back();
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return value;
}

inline bool sacdEndsWith(const std::string& value, const std::string& suffix) {
  return value.size() >= suffix.size() && value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

inline bool sacdHasPath(const std::vector<std::string>& paths, const std::string& path) {
  return std::find(paths.begin(), paths.end(), path) != paths.end();
}

inline bool sacdPathLooksAudioAreaMarker(const std::string& path) {
  if (path.rfind("SACD/", 0) != 0) return false;
  return path.find("_AREA") != std::string::npos || path.find("_TAREA") != std::string::npos ||
         sacdEndsWith(path, ".2CH") || sacdEndsWith(path, ".MCH") || sacdEndsWith(path, ".DST") ||
         sacdEndsWith(path, ".DSD");
}

inline bool sacdPathLooksUncompressedDsdMarker(const std::string& path) {
  if (path.rfind("SACD/", 0) != 0) return false;
  return path.find("TWOCH") != std::string::npos || path.find("2CH") != std::string::npos ||
         path.find("MCH") != std::string::npos || path.find("MULTI") != std::string::npos ||
         sacdEndsWith(path, ".DSD");
}

inline void sacdCollectIsoDirectory(
    std::ifstream& file,
    uint32_t extent,
    uint32_t size,
    const std::string& parent,
    int depth,
    std::vector<std::string>* paths) {
  if (!paths || depth > 3 || extent == 0 || size == 0 || paths->size() > 512) return;

  std::vector<uint8_t> directory(size);
  if (!sacdReadExactAt(file, static_cast<uint64_t>(extent) * 2048ULL, directory.data(), directory.size())) return;

  size_t offset = 0;
  while (offset < directory.size() && paths->size() <= 512) {
    const uint8_t length = directory[offset];
    if (length == 0) {
      offset = ((offset / 2048) + 1) * 2048;
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

    const std::string name = sacdUpperIsoIdentifier(
        std::string(reinterpret_cast<const char*>(rawName), reinterpret_cast<const char*>(rawName) + nameLength));
    if (name.empty()) {
      offset += length;
      continue;
    }

    const std::string path = parent.empty() ? name : parent + "/" + name;
    paths->push_back(path);
    const bool isDirectory = (directory[offset + 25] & 0x02) != 0;
    if (isDirectory) {
      const uint32_t childExtent = sacdReadLe32(directory.data() + offset + 2);
      const uint32_t childSize = sacdReadLe32(directory.data() + offset + 10);
      sacdCollectIsoDirectory(file, childExtent, childSize, path, depth + 1, paths);
    }
    offset += length;
  }
}

inline SacdIsoEntryProbe probeSacdIsoEntry(const std::string& source) {
  if (sacdIsoExtensionOf(source) != "iso") return {};

  SacdIsoEntryProbe probe;
  probe.source = source;
  probe.codec = kSacdIsoCodecName;
  probe.container = kSacdIsoContainerName;

  std::string cleanSource = source;
  const size_t qm = cleanSource.find('?');
  if (qm != std::string::npos) {
    cleanSource = cleanSource.substr(0, qm);
  }

  std::ifstream file(utf8Path(cleanSource), std::ios::binary);
  if (!file) {
    probe.reasonCode = kSacdIsoOpenFailedReasonCode;
    probe.reason = "Unable to open ISO image";
    return probe;
  }

  std::array<uint8_t, 2048> sector{};
  uint32_t rootExtent = 0;
  uint32_t rootSize = 0;
  bool sawIsoDescriptor = false;

  for (uint32_t sectorIndex = 16; sectorIndex < 64; ++sectorIndex) {
    if (!sacdReadExactAt(file, static_cast<uint64_t>(sectorIndex) * 2048ULL, sector.data(), sector.size())) break;
    if (std::memcmp(sector.data() + 1, "CD001", 5) != 0 || sector[6] != 1) continue;
    sawIsoDescriptor = true;
    if (sector[0] == 1) {
      const uint8_t* rootRecord = sector.data() + 156;
      if (rootRecord[0] >= 34) {
        rootExtent = sacdReadLe32(rootRecord + 2);
        rootSize = sacdReadLe32(rootRecord + 10);
      }
    } else if (sector[0] == 255) {
      break;
    }
  }

  probe.isIso9660 = sawIsoDescriptor;
  if (!sawIsoDescriptor || rootExtent == 0 || rootSize == 0) {
    probe.reasonCode = kSacdIsoNotIso9660ReasonCode;
    probe.reason = "ISO candidate does not contain a readable ISO9660 primary volume descriptor";
    return probe;
  }

  sacdCollectIsoDirectory(file, rootExtent, rootSize, "", 0, &probe.markers);
  const bool hasSacdDirectory = sacdHasPath(probe.markers, "SACD");
  const bool hasMasterToc = sacdHasPath(probe.markers, "SACD/MASTER.TOC") ||
                            sacdHasPath(probe.markers, "SACD/MASTER2.TOC");
  bool hasAreaMarker = false;
  bool hasUncompressedDsdMarker = false;
  for (const auto& marker : probe.markers) {
    hasAreaMarker = hasAreaMarker || sacdPathLooksAudioAreaMarker(marker);
    hasUncompressedDsdMarker = hasUncompressedDsdMarker || sacdPathLooksUncompressedDsdMarker(marker);
    probe.hasDst = probe.hasDst || sacdEndsWith(marker, ".DST") || marker.find("DST") != std::string::npos;
  }

  probe.hasSacdMarkers = hasSacdDirectory && hasMasterToc && hasAreaMarker;
  if (!probe.hasSacdMarkers) {
    probe.reasonCode = kSacdIsoMissingMarkersReasonCode;
    probe.reason = "ISO9660 image does not contain SACD directory and TOC markers";
    return probe;
  }

  probe.isDsd = true;
  probe.playable = hasUncompressedDsdMarker;
  if (probe.playable) {
    probe.status = SacdIsoEntryStatus::Supported;
    probe.reasonCode.clear();
    probe.reason.clear();
  } else {
    probe.status = SacdIsoEntryStatus::Unsupported;
    probe.reasonCode = kSacdIsoUnsupportedReasonCode;
    probe.reason = kSacdIsoUnsupportedReason;
  }
  return probe;
}

}  // namespace twilight::audio
