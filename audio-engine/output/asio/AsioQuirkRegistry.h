#pragma once

#include "IAsioHost.h"
#include "AsioQuirkTypes.h"

#include <optional>
#include <string>
#include <vector>

namespace twilight::audio {

struct AsioQuirkApplication {
  std::optional<AsioSampleFormatMapping> sampleFormatMapping;
  long dsdMinimumBufferFrames = 0;
  AsioNativeDsdControlOrder dsdControlOrder = AsioNativeDsdControlOrder::Default;
  uint32_t dsdCadenceConfirmCallbacks = 2;
  std::vector<std::string> applied;
  std::string fingerprint;
  std::string registryState = "empty";
};

/**
 * Audited compatibility exceptions for ASIO drivers. Entries match an exact
 * CLSID, inclusive driver-version range, and the capability record produced by
 * the driver probe. The registry deliberately has no name-based matching.
 */
class AsioQuirkRegistry final {
 public:
  static constexpr int kSchemaVersion = 1;

  /** Invalid, unknown-version, or disabled documents return an empty registry. */
  static AsioQuirkRegistry fromJson(const std::string& json);
  static AsioQuirkRegistry builtIn();

  AsioQuirkApplication apply(const AsioDeviceInfo& device) const;
  bool compatible() const { return compatible_; }
  size_t size() const { return entries_.size(); }

  static std::string capabilityFingerprint(const AsioDeviceInfo& device);

 enum class Type : uint8_t {
    SampleTypeMapping,
    DsdMinimumBuffer,
    DsdControlOrder,
    DsdCallbackCadence
  };

 private:
  struct Entry {
    std::string clsid;
    long minVersion = 0;
    long maxVersion = 0;
    std::string fingerprint;
    Type type = Type::SampleTypeMapping;
    std::string source;
    std::string value;
  };

  bool compatible_ = false;
  bool disabled_ = false;
  std::vector<Entry> entries_;
};

}  // namespace twilight::audio
