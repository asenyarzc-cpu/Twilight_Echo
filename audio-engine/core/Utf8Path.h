#pragma once

#include <filesystem>
#include <string>

namespace twilight::audio {

// Sources and user-selected paths arrive as UTF-8 (Node/Electron convention).
// The narrow fstream overloads on Windows reinterpret the bytes in the ANSI
// codepage (GBK on zh-CN systems), so any path with non-ASCII characters fails
// to open even though the file exists. filesystem::path performs the UTF-8 ->
// native wide conversion the streams then use.
inline std::filesystem::path utf8Path(const std::string& source) {
#if defined(_WIN32)
  return std::filesystem::path(
      std::u8string(reinterpret_cast<const char8_t*>(source.data()), source.size()));
#else
  return std::filesystem::path(source);
#endif
}

}  // namespace twilight::audio
