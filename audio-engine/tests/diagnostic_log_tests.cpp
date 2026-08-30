#include "../core/DiagnosticLog.h"

#include <cassert>
#include <cstdio>
#include <string>

namespace {

using twilight::audio::DiagnosticLog;
using twilight::audio::diagnosticIsoTimestamp;
using twilight::audio::DiagLevel;

void testIsoTimestamp() {
  assert(diagnosticIsoTimestamp(0) == "1970-01-01T00:00:00.000Z");
  assert(diagnosticIsoTimestamp(1787788800000ULL) == "2026-08-27T00:00:00.000Z");
  assert(diagnosticIsoTimestamp(1787792461001ULL) == "2026-08-27T01:01:01.001Z");
  assert(diagnosticIsoTimestamp(86399999ULL) == "1970-01-01T23:59:59.999Z");
}

void testAppendAndToJsonShape() {
  auto& log = DiagnosticLog::instance();
  log.clearForTests();
  log.append(DiagLevel::Error, "dsd_probe_failed", "Unable to open DSD source",
             "{\"source\":\"<local-file:dff:abcd>\"}");
  log.append(DiagLevel::Info, "dsd_route_engaged", "mode=native backend=asio rate=2822400");

  uint64_t next = 0;
  const std::string json = log.toJson(0, 0, &next);
  assert(next == 2);
  assert(json.rfind("[{\"sequence\":1,", 0) == 0);
  assert(json.find("\"timestamp\":\"") != std::string::npos);
  assert(json.find("\"level\":\"error\"") != std::string::npos);
  assert(json.find("\"level\":\"info\"") != std::string::npos);
  assert(json.find("\"event\":\"dsd_probe_failed\"") != std::string::npos);
  assert(json.find("\"message\":\"Unable to open DSD source\"") != std::string::npos);
  assert(json.find("\"details\":{\"source\":\"<local-file:dff:abcd>\"}") != std::string::npos);
  assert(json.find("\"details\":{}") != std::string::npos);
  assert(json.find("dsd_route_engaged") != std::string::npos);
}

void testPollOnlyReturnsNewEntries() {
  auto& log = DiagnosticLog::instance();
  log.clearForTests();
  log.append(DiagLevel::Info, "one", "first");
  uint64_t next = 0;
  std::string json = log.toJson(0, 0, &next);
  assert(next == 1);
  assert(json.find("\"event\":\"one\"") != std::string::npos);

  log.append(DiagLevel::Warning, "two", "second");
  json = log.toJson(next, 0, &next);
  assert(next == 2);
  assert(json.find("\"event\":\"two\"") != std::string::npos);
  assert(json.find("\"event\":\"one\"") == std::string::npos);

  json = log.toJson(next, 0, &next);
  assert(json == "[]");
}

void testRingIsBounded() {
  auto& log = DiagnosticLog::instance();
  log.clearForTests();
  for (int i = 0; i < 700; ++i) {
    log.append(DiagLevel::Info, "tick", "tick " + std::to_string(i));
  }
  uint64_t next = 0;
  const std::string json = log.toJson(0, 0, &next);
  assert(next == 700);
  // Only the newest 512 survive; the first survivor is tick 188.
  assert(json.find("\"message\":\"tick 187\"") == std::string::npos);
  assert(json.find("\"message\":\"tick 188\"") != std::string::npos);
  assert(json.find("\"message\":\"tick 699\"") != std::string::npos);

  // Since-sequence filtering applies to what remains.
  const std::string tail = log.toJson(698, 0, &next);
  assert(tail.find("\"event\":\"tick\"") != std::string::npos);
  assert(tail.find("\"message\":\"tick 698\"") != std::string::npos);
  assert(tail.find("\"message\":\"tick 697\"") == std::string::npos);
}

void testMaxEntriesCapsNewest() {
  auto& log = DiagnosticLog::instance();
  log.clearForTests();
  for (int i = 0; i < 10; ++i) {
    log.append(DiagLevel::Info, "cap", "cap " + std::to_string(i));
  }
  const std::string json = log.toJson(0, 3, nullptr);
  assert(json.find("\"message\":\"cap 7\"") != std::string::npos);
  assert(json.find("\"message\":\"cap 8\"") != std::string::npos);
  assert(json.find("\"message\":\"cap 9\"") != std::string::npos);
  assert(json.find("\"message\":\"cap 6\"") == std::string::npos);
}

void testEscapesMessageForJson() {
  auto& log = DiagnosticLog::instance();
  log.clearForTests();
  log.append(DiagLevel::Warning, "quote\"back\\slash", "line1\nline2 \"quoted\"");
  const std::string json = log.toJson(0, 0, nullptr);
  assert(json.find("\"event\":\"quote\\\"back\\\\slash\"") != std::string::npos);
  assert(json.find("\"message\":\"line1\\nline2 \\\"quoted\\\"\"") != std::string::npos);
  assert(json.find('\n') == std::string::npos);
}

void testTruncatesOversizedFields() {
  auto& log = DiagnosticLog::instance();
  log.clearForTests();
  log.append(DiagLevel::Error, "big", std::string(4096, 'x'), std::string(16384, 'y'));
  const std::string json = log.toJson(0, 0, nullptr);
  assert(json.size() < 4096 + 16384);
  assert(json.find(std::string(513, 'x')) == std::string::npos);
}

}  // namespace

int main() {
  testIsoTimestamp();
  testAppendAndToJsonShape();
  testPollOnlyReturnsNewEntries();
  testRingIsBounded();
  testMaxEntriesCapsNewest();
  testEscapesMessageForJson();
  testTruncatesOversizedFields();
  std::printf("diagnostic_log_tests passed\n");
  return 0;
}
