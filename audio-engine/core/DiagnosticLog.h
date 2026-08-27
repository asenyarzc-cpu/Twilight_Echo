#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>

namespace twilight::audio {

enum class DiagLevel {
  Info,
  Warning,
  Error
};

const char* diagnosticLevelName(DiagLevel level);

// ISO-8601 UTC ("2026-08-27T12:34:56.789Z") for an epoch-millisecond value.
std::string diagnosticIsoTimestamp(uint64_t epochMs);

// Bounded process-wide ring of engine events that feed the diagnostics export.
// Route decisions, DSD probe failures and PCM fallbacks land here with
// timestamps and levels, so an exported report can answer "what did the engine
// decide, why, and in which order" without the low-level TAE_ASIO_TRACE_PATH
// environment tracing being enabled.
class DiagnosticLog {
 public:
  struct Entry {
    uint64_t sequence = 0;
    uint64_t epochMs = 0;
    DiagLevel level = DiagLevel::Info;
    std::string event;
    std::string message;
    std::string detailsJson;
  };

  static DiagnosticLog& instance();

  void append(DiagLevel level, const std::string& event, const std::string& message,
              const std::string& detailsJson = "{}");

  // JSON array of the newest entries with sequence > sinceSequence, oldest
  // first. nextSequence (when non-null) receives the value to pass on the next
  // call so callers only ever see new events.
  std::string toJson(uint64_t sinceSequence, size_t maxEntries, uint64_t* nextSequence) const;

  // The sequence the next appended entry will receive.
  uint64_t nextSequence() const;

  void clearForTests();

 private:
  DiagnosticLog() = default;

  mutable std::mutex mutex_;
  std::deque<Entry> entries_;
  uint64_t sequence_ = 0;
};

}  // namespace twilight::audio
