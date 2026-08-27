#include "DiagnosticLog.h"

#include <algorithm>
#include <chrono>
#include <cstdio>

namespace twilight::audio {
namespace {

constexpr size_t kMaxEntries = 512;
constexpr size_t kMaxMessageChars = 512;
constexpr size_t kMaxDetailsChars = 8192;
constexpr size_t kMaxEventChars = 64;

std::string truncated(std::string value, size_t maxChars) {
  if (value.size() <= maxChars) return value;
  value.resize(maxChars);
  return value;
}

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (const char raw : value) {
    const unsigned char ch = static_cast<unsigned char>(raw);
    switch (ch) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (ch < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out += buffer;
        } else {
          out += raw;
        }
    }
  }
  return out;
}

uint64_t nowEpochMs() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

}  // namespace

const char* diagnosticLevelName(DiagLevel level) {
  switch (level) {
    case DiagLevel::Info:
      return "info";
    case DiagLevel::Warning:
      return "warning";
    case DiagLevel::Error:
      return "error";
  }
  return "info";
}

std::string diagnosticIsoTimestamp(uint64_t epochMs) {
  const uint64_t msOfDay = epochMs % 86400000ULL;
  const int64_t days = static_cast<int64_t>(epochMs / 86400000ULL);
  // civil-from-days (Howard Hinnant's algorithm), epoch 1970-01-01.
  const int64_t z = days + 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t y = yoe + era * 400;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t d = doy - (153 * mp + 2) / 5 + 1;
  const int64_t m = mp < 10 ? mp + 3 : mp - 9;
  const int year = static_cast<int>(y + (m <= 2 ? 1 : 0));
  char out[40];
  std::snprintf(out, sizeof(out), "%04d-%02lld-%02lldT%02llu:%02llu:%02llu.%03lluZ", year,
                static_cast<long long>(m), static_cast<long long>(d),
                static_cast<unsigned long long>(msOfDay / 3600000ULL),
                static_cast<unsigned long long>((msOfDay / 60000ULL) % 60ULL),
                static_cast<unsigned long long>((msOfDay / 1000ULL) % 60ULL),
                static_cast<unsigned long long>(msOfDay % 1000ULL));
  return out;
}

DiagnosticLog& DiagnosticLog::instance() {
  static DiagnosticLog log;
  return log;
}

void DiagnosticLog::append(DiagLevel level, const std::string& event, const std::string& message,
                           const std::string& detailsJson) {
  Entry entry;
  entry.epochMs = nowEpochMs();
  entry.level = level;
  entry.event = truncated(event, kMaxEventChars);
  entry.message = truncated(message, kMaxMessageChars);
  entry.detailsJson = truncated(detailsJson, kMaxDetailsChars);
  {
    std::lock_guard lock(mutex_);
    entry.sequence = ++sequence_;
    entries_.push_back(entry);
    while (entries_.size() > kMaxEntries) entries_.pop_front();
  }
}

std::string DiagnosticLog::toJson(uint64_t sinceSequence, size_t maxEntries,
                                  uint64_t* nextSequence) const {
  std::deque<Entry> snapshot;
  {
    std::lock_guard lock(mutex_);
    if (nextSequence) *nextSequence = sequence_;
    for (const Entry& entry : entries_) {
      if (entry.sequence > sinceSequence) snapshot.push_back(entry);
    }
  }
  if (maxEntries > 0 && snapshot.size() > maxEntries) {
    snapshot.erase(snapshot.begin(), snapshot.end() - static_cast<std::ptrdiff_t>(maxEntries));
  }

  std::string json = "[";
  bool first = true;
  for (const Entry& entry : snapshot) {
    if (!first) json += ',';
    first = false;
    json += "{\"sequence\":";
    json += std::to_string(entry.sequence);
    json += ",\"timestamp\":\"";
    json += diagnosticIsoTimestamp(entry.epochMs);
    json += "\",\"level\":\"";
    json += diagnosticLevelName(entry.level);
    json += "\",\"event\":\"";
    json += jsonEscape(entry.event);
    json += "\",\"message\":\"";
    json += jsonEscape(entry.message);
    json += "\",\"details\":";
    json += entry.detailsJson.empty() ? "{}" : entry.detailsJson;
    json += '}';
  }
  json += ']';
  return json;
}

uint64_t DiagnosticLog::nextSequence() const {
  std::lock_guard lock(mutex_);
  return sequence_;
}

void DiagnosticLog::clearForTests() {
  std::lock_guard lock(mutex_);
  entries_.clear();
  sequence_ = 0;
}

}  // namespace twilight::audio
