#include "AsioQuirkRegistry.h"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <cstdlib>
#include <regex>
#include <set>
#include <sstream>
#include <string_view>

namespace twilight::audio {
namespace {

std::string normalizedClsid(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return value;
}

std::optional<std::string> clsidFromDeviceId(const std::string& deviceId) {
  constexpr std::string_view kPrefix = "asio:";
  if (!deviceId.starts_with(kPrefix)) return std::nullopt;
  const std::string candidate = deviceId.substr(kPrefix.size());
  static const std::regex kClsid(R"(^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$)");
  if (!std::regex_match(candidate, kClsid)) return std::nullopt;
  return normalizedClsid(candidate);
}

std::optional<std::string> stringField(const std::string& object, const char* name) {
  const std::regex expression(
      std::string("\\\"") + name + "\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"");
  std::smatch match;
  if (!std::regex_search(object, match, expression)) return std::nullopt;
  return match[1].str();
}

std::optional<long> parseLong(std::string_view value) {
  long parsed = 0;
  const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (error != std::errc{} || end != value.data() + value.size()) return std::nullopt;
  return parsed;
}

bool structurallyValidJson(const std::string& json) {
  int braces = 0;
  int brackets = 0;
  bool inString = false;
  bool escaped = false;
  for (const char character : json) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        inString = false;
      }
      continue;
    }
    if (character == '"') {
      inString = true;
    } else if (character == '{') {
      ++braces;
    } else if (character == '}') {
      if (--braces < 0) return false;
    } else if (character == '[') {
      ++brackets;
    } else if (character == ']') {
      if (--brackets < 0) return false;
    }
  }
  return !inString && !escaped && braces == 0 && brackets == 0;
}

std::optional<long> integerField(const std::string& object, const char* name) {
  const std::regex expression(std::string(R"(")") + name + R"("\s*:\s*(-?[0-9]+))");
  std::smatch match;
  if (!std::regex_search(object, match, expression)) return std::nullopt;
  try {
    return std::stol(match[1].str());
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<bool> booleanField(const std::string& object, const char* name) {
  const std::regex expression(std::string(R"(")") + name + R"("\s*:\s*(true|false))");
  std::smatch match;
  if (!std::regex_search(object, match, expression)) return std::nullopt;
  return match[1].str() == "true";
}

std::optional<AsioQuirkRegistry::Type> parseType(const std::string& value) {
  if (value == "sample-type-mapping") return AsioQuirkRegistry::Type::SampleTypeMapping;
  if (value == "dsd-minimum-buffer") return AsioQuirkRegistry::Type::DsdMinimumBuffer;
  if (value == "dsd-control-order") return AsioQuirkRegistry::Type::DsdControlOrder;
  if (value == "dsd-callback-cadence") return AsioQuirkRegistry::Type::DsdCallbackCadence;
  return std::nullopt;
}

std::optional<AudioSampleFormat> parseDsdFormat(const std::string& value) {
  if (value == "dsd-lsb1") return AudioSampleFormat::DsdInt8Lsb1;
  if (value == "dsd-msb1") return AudioSampleFormat::DsdInt8Msb1;
  if (value == "dsd-ner8") return AudioSampleFormat::DsdInt8Ner8;
  return std::nullopt;
}

std::optional<AsioSampleFormatMapping> parseMapping(const std::string& value) {
  const size_t divider = value.find("->");
  if (divider == std::string::npos || value.find("->", divider + 2) != std::string::npos) return std::nullopt;
  const auto reported = parseDsdFormat(value.substr(0, divider));
  const auto interpreted = parseDsdFormat(value.substr(divider + 2));
  if (!reported || !interpreted || *reported == *interpreted) return std::nullopt;
  return AsioSampleFormatMapping{.reported = *reported, .interpreted = *interpreted};
}

std::optional<AsioNativeDsdControlOrder> parseControlOrder(const std::string& value) {
  if (value == "format-first") return AsioNativeDsdControlOrder::FormatFirst;
  if (value == "rate-first") return AsioNativeDsdControlOrder::RateFirst;
  if (value == "rate-only") return AsioNativeDsdControlOrder::RateOnly;
  return std::nullopt;
}

bool validValue(AsioQuirkRegistry::Type type, const std::string& value) {
  switch (type) {
    case AsioQuirkRegistry::Type::SampleTypeMapping:
      return parseMapping(value).has_value();
    case AsioQuirkRegistry::Type::DsdMinimumBuffer:
      if (const auto frames = parseLong(value)) return *frames >= 1 && *frames <= 32768;
      return false;
    case AsioQuirkRegistry::Type::DsdControlOrder:
      return parseControlOrder(value).has_value();
    case AsioQuirkRegistry::Type::DsdCallbackCadence:
      if (const auto count = parseLong(value)) return *count >= 2 && *count <= 8;
      return false;
  }
  return false;
}

std::string typeName(AsioQuirkRegistry::Type type) {
  switch (type) {
    case AsioQuirkRegistry::Type::SampleTypeMapping:
      return "sample-type-mapping";
    case AsioQuirkRegistry::Type::DsdMinimumBuffer:
      return "dsd-minimum-buffer";
    case AsioQuirkRegistry::Type::DsdControlOrder:
      return "dsd-control-order";
    case AsioQuirkRegistry::Type::DsdCallbackCadence:
      return "dsd-callback-cadence";
  }
  return "unknown";
}

template <typename Value>
void appendSorted(std::ostringstream* output, const std::vector<Value>& values) {
  std::vector<Value> sorted = values;
  std::sort(sorted.begin(), sorted.end());
  sorted.erase(std::unique(sorted.begin(), sorted.end()), sorted.end());
  for (const Value& value : sorted) *output << value << ',';
}

}  // namespace

AsioQuirkRegistry AsioQuirkRegistry::fromJson(const std::string& json) {
  AsioQuirkRegistry registry;
  if (json.empty() || json.size() > 65536 || !structurallyValidJson(json)) return registry;
  const std::regex schema(R"("schemaVersion"\s*:\s*([0-9]+))");
  std::smatch schemaMatch;
  if (!std::regex_search(json, schemaMatch, schema)) return registry;
  if (schemaMatch[1].str() != std::to_string(kSchemaVersion)) return registry;
  const size_t entriesKey = json.find("\"entries\"");
  if (entriesKey == std::string::npos || json.find('[', entriesKey) == std::string::npos) return registry;

  registry.compatible_ = true;
  const bool globallyDisabled = [] {
    const char* value = std::getenv("TWILIGHT_DISABLE_ASIO_QUIRKS");
    return value && std::string_view(value) == "1";
  }();
  registry.disabled_ = globallyDisabled;

  // Match flat entry objects while allowing braces inside quoted CLSIDs or
  // other string fields. A naive object expression would drop every entry
  // because a CLSID itself contains braces.
  const std::regex object(R"(\{(?:[^{}"]|"(?:\\.|[^"\\])*")*\})");
  for (std::sregex_iterator it(json.begin(), json.end(), object), end; it != end; ++it) {
    const std::string candidate = it->str();
    const auto clsid = stringField(candidate, "clsid");
    const auto minVersion = integerField(candidate, "minVersion");
    const auto maxVersion = integerField(candidate, "maxVersion");
    const auto fingerprint = stringField(candidate, "capabilityFingerprint");
    const auto typeText = stringField(candidate, "type");
    const auto source = stringField(candidate, "source");
    const auto enabled = booleanField(candidate, "enabled");
    const auto value = stringField(candidate, "value");
    if (!clsid || !minVersion || !maxVersion || !fingerprint || !typeText || !source || !enabled || !value ||
        !*enabled || fingerprint->empty() || source->empty() || *minVersion < 0 || *maxVersion < *minVersion) {
      continue;
    }
    const auto normalized = clsidFromDeviceId("asio:" + *clsid);
    const auto type = parseType(*typeText);
    if (!normalized || !type || !validValue(*type, *value)) continue;
    registry.entries_.push_back(
        Entry{.clsid = *normalized, .minVersion = *minVersion, .maxVersion = *maxVersion,
              .fingerprint = *fingerprint, .type = *type, .source = *source, .value = *value});
  }
  return registry;
}

AsioQuirkRegistry AsioQuirkRegistry::builtIn() {
  // Compatibility exceptions enter the release only with a linked evidence
  // artifact. There are intentionally no speculative vendor-name rules.
  return fromJson(R"({"schemaVersion":1,"entries":[]})");
}

std::string AsioQuirkRegistry::capabilityFingerprint(const AsioDeviceInfo& device) {
  std::ostringstream fingerprint;
  fingerprint << "channels=" << device.outputChannels << ";pcm=";
  appendSorted(&fingerprint, device.supportedSampleRates);
  fingerprint << ";formats=";
  std::vector<int> formats;
  formats.reserve(device.sampleFormats.size());
  for (const auto format : device.sampleFormats) formats.push_back(static_cast<int>(format));
  appendSorted(&fingerprint, formats);
  fingerprint << ";native=" << (device.nativeDsdCapable ? 1 : 0) << ':';
  appendSorted(&fingerprint, device.nativeDsdSampleRates);
  fingerprint << ";buffer=" << device.minBufferSize << ',' << device.maxBufferSize << ','
              << device.preferredBufferSize << ',' << device.bufferGranularity;
  return fingerprint.str();
}

AsioQuirkApplication AsioQuirkRegistry::apply(const AsioDeviceInfo& device) const {
  AsioQuirkApplication application;
  application.fingerprint = capabilityFingerprint(device);
  if (!compatible_) {
    application.registryState = "ignored-incompatible-schema";
    return application;
  }
  if (disabled_) {
    application.registryState = "disabled";
    return application;
  }
  const auto clsid = clsidFromDeviceId(device.id);
  if (!clsid || !device.capabilityProbed) {
    application.registryState = "no-probed-clsid";
    return application;
  }

  std::set<Type> appliedTypes;
  for (const Entry& entry : entries_) {
    if (entry.clsid != *clsid || device.driverVersion < entry.minVersion ||
        device.driverVersion > entry.maxVersion || entry.fingerprint != application.fingerprint ||
        !appliedTypes.insert(entry.type).second) {
      continue;
    }
    switch (entry.type) {
      case Type::SampleTypeMapping:
        application.sampleFormatMapping = parseMapping(entry.value);
        break;
      case Type::DsdMinimumBuffer:
        application.dsdMinimumBufferFrames = *parseLong(entry.value);
        break;
      case Type::DsdControlOrder:
        application.dsdControlOrder = *parseControlOrder(entry.value);
        break;
      case Type::DsdCallbackCadence:
        application.dsdCadenceConfirmCallbacks = static_cast<uint32_t>(*parseLong(entry.value));
        break;
    }
    application.applied.push_back(typeName(entry.type) + "@" + entry.source);
  }
  application.registryState = application.applied.empty() ? "no-match" : "applied";
  return application;
}

}  // namespace twilight::audio
