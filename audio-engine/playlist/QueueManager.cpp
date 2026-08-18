#include "QueueManager.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <numeric>
#include <sstream>

namespace twilight::audio {
namespace {

std::string escapeJson(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
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
        out += ch;
        break;
    }
  }
  return out;
}

std::string unescapeJsonString(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  bool escaped = false;
  for (size_t i = 0; i < value.size(); ++i) {
    const char ch = value[i];
    if (!escaped) {
      if (ch == '\\') {
        escaped = true;
      } else {
        out += ch;
      }
      continue;
    }

    switch (ch) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case '"':
      case '\\':
      case '/':
        out += ch;
        break;
      case 'u':
        out += '?';
        i += std::min<size_t>(4, value.size() - i - 1);
        break;
      default:
        out += ch;
        break;
    }
    escaped = false;
  }
  return out;
}

std::vector<std::string> splitTopLevelObjects(const std::string& json) {
  std::vector<std::string> objects;
  bool inString = false;
  bool escaped = false;
  int depth = 0;
  size_t objectStart = std::string::npos;

  for (size_t i = 0; i < json.size(); ++i) {
    const char ch = json[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        inString = false;
      }
      continue;
    }

    if (ch == '"') {
      inString = true;
      continue;
    }
    if (ch == '{') {
      if (depth == 0) objectStart = i;
      ++depth;
      continue;
    }
    if (ch == '}') {
      --depth;
      if (depth == 0 && objectStart != std::string::npos) {
        objects.push_back(json.substr(objectStart, i - objectStart + 1));
        objectStart = std::string::npos;
      }
    }
  }

  return objects;
}

std::optional<std::string> extractStringField(const std::string& object, const std::string& key) {
  const std::string marker = "\"" + key + "\"";
  size_t pos = object.find(marker);
  if (pos == std::string::npos) return std::nullopt;
  pos = object.find(':', pos + marker.size());
  if (pos == std::string::npos) return std::nullopt;
  pos = object.find('"', pos + 1);
  if (pos == std::string::npos) return std::nullopt;

  std::string raw;
  bool escaped = false;
  for (size_t i = pos + 1; i < object.size(); ++i) {
    const char ch = object[i];
    if (escaped) {
      raw += '\\';
      raw += ch;
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      continue;
    }
    if (ch == '"') return unescapeJsonString(raw);
    raw += ch;
  }
  return std::nullopt;
}

std::optional<double> parseJsonNumber(const char* begin, const char* end) {
  const std::string value(begin, end);
  char* parsedEnd = nullptr;
  errno = 0;
  const double parsed = std::strtod(value.c_str(), &parsedEnd);
  if (errno == ERANGE || parsedEnd != value.c_str() + value.size()) return std::nullopt;
  return parsed;
}

std::optional<double> extractNumberField(const std::string& object, const std::string& key) {
  const std::string marker = "\"" + key + "\"";
  size_t pos = object.find(marker);
  if (pos == std::string::npos) return std::nullopt;
  pos = object.find(':', pos + marker.size());
  if (pos == std::string::npos) return std::nullopt;
  ++pos;
  while (pos < object.size() && std::isspace(static_cast<unsigned char>(object[pos]))) ++pos;

  size_t end = pos;
  while (end < object.size()) {
    const char ch = object[end];
    if (!std::isdigit(static_cast<unsigned char>(ch)) && ch != '.' && ch != '-' && ch != '+' && ch != 'e' &&
        ch != 'E') {
      break;
    }
    ++end;
  }
  if (end == pos) return std::nullopt;

  return parseJsonNumber(object.data() + pos, object.data() + end);
}

std::optional<size_t> findTopLevelFieldValue(const std::string& object, const std::string& key) {
  bool inString = false;
  bool escaped = false;
  int depth = 0;
  for (size_t i = 0; i < object.size(); ++i) {
    const char ch = object[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch == '\\') escaped = true;
      else if (ch == '"') inString = false;
      continue;
    }
    if (ch == '{') {
      ++depth;
      continue;
    }
    if (ch == '}') {
      --depth;
      continue;
    }
    if (ch != '"') continue;

    const size_t tokenStart = i + 1;
    size_t tokenEnd = tokenStart;
    bool tokenEscaped = false;
    for (; tokenEnd < object.size(); ++tokenEnd) {
      const char tokenCh = object[tokenEnd];
      if (tokenEscaped) tokenEscaped = false;
      else if (tokenCh == '\\') tokenEscaped = true;
      else if (tokenCh == '"') break;
    }
    if (tokenEnd >= object.size()) return std::nullopt;
    if (depth == 1 && object.compare(tokenStart, tokenEnd - tokenStart, key) == 0) {
      size_t cursor = tokenEnd + 1;
      while (cursor < object.size() && std::isspace(static_cast<unsigned char>(object[cursor]))) ++cursor;
      if (cursor < object.size() && object[cursor] == ':') {
        ++cursor;
        while (cursor < object.size() && std::isspace(static_cast<unsigned char>(object[cursor]))) ++cursor;
        return cursor < object.size() ? std::optional<size_t>(cursor) : std::nullopt;
      }
    }
    i = tokenEnd;
  }
  return std::nullopt;
}

std::optional<double> extractTopLevelNumberField(const std::string& object, const std::string& key) {
  const auto valueStart = findTopLevelFieldValue(object, key);
  if (!valueStart) return std::nullopt;
  size_t end = *valueStart;
  while (end < object.size()) {
    const char ch = object[end];
    if (!std::isdigit(static_cast<unsigned char>(ch)) && ch != '.' && ch != '-' && ch != '+' && ch != 'e' &&
        ch != 'E') break;
    ++end;
  }
  if (end == *valueStart) return std::nullopt;
  const auto value = parseJsonNumber(object.data() + *valueStart, object.data() + end);
  if (!value) return std::nullopt;
  size_t delimiter = end;
  while (delimiter < object.size() && std::isspace(static_cast<unsigned char>(object[delimiter]))) ++delimiter;
  if (delimiter >= object.size() || (object[delimiter] != ',' && object[delimiter] != '}')) return std::nullopt;
  return *value;
}

std::optional<std::string> extractTopLevelObjectField(const std::string& object, const std::string& key) {
  const auto valueStart = findTopLevelFieldValue(object, key);
  if (!valueStart || object[*valueStart] != '{') return std::nullopt;
  bool inString = false;
  bool escaped = false;
  int depth = 0;
  for (size_t i = *valueStart; i < object.size(); ++i) {
    const char ch = object[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch == '\\') escaped = true;
      else if (ch == '"') inString = false;
      continue;
    }
    if (ch == '"') inString = true;
    else if (ch == '{') ++depth;
    else if (ch == '}' && --depth == 0) return object.substr(*valueStart, i - *valueStart + 1);
  }
  return std::nullopt;
}

struct ParsedQueueItem {
  QueueItem item;
  bool valid = true;
};

ParsedQueueItem parseQueueItem(const std::string& object) {
  ParsedQueueItem parsed;
  QueueItem& item = parsed.item;
  item.id = extractStringField(object, "id").value_or("");
  item.title = extractStringField(object, "title").value_or(extractStringField(object, "name").value_or(""));
  item.artist = extractStringField(object, "artist").value_or("");
  item.album = extractStringField(object, "album").value_or("");
  item.codec = extractStringField(object, "codec").value_or(extractStringField(object, "format").value_or(""));
  item.source = extractStringField(object, "audioSource")
                    .value_or(extractStringField(object, "filePath")
                                  .value_or(extractStringField(object, "streamUrl")
                                                .value_or(extractStringField(object, "source").value_or(""))));
  item.durationSeconds = extractNumberField(object, "duration").value_or(0.0);
  item.sampleRate = static_cast<int>(extractNumberField(object, "sampleRate").value_or(0.0));
  item.bitrate = static_cast<int64_t>(extractNumberField(object, "bitrate").value_or(0.0));
  item.bitDepth = static_cast<int>(extractNumberField(object, "bitDepth").value_or(0.0));
  if (auto measured = extractNumberField(object, "measuredIntegratedLufs")) {
    item.measuredIntegratedLufs = *measured;
  }
  if (auto measured = extractNumberField(object, "measuredTruePeakDb")) {
    item.measuredTruePeakDb = *measured;
  }
  if (auto value = extractNumberField(object, "replayGainTrackGainDb")) {
    item.replayGainTrackGainDb = *value;
  }
  if (auto value = extractNumberField(object, "replayGainAlbumGainDb")) {
    item.replayGainAlbumGainDb = *value;
  }
  if (auto value = extractNumberField(object, "replayGainTrackPeak")) {
    item.replayGainTrackPeak = *value;
  }
  if (auto value = extractNumberField(object, "replayGainAlbumPeak")) {
    item.replayGainAlbumPeak = *value;
  }
  if (auto value = extractNumberField(object, "r128TrackGainDb")) {
    item.r128TrackGainDb = *value;
  }
  if (auto value = extractNumberField(object, "r128AlbumGainDb")) {
    item.r128AlbumGainDb = *value;
  }
  const auto nestedCueRangeStart = findTopLevelFieldValue(object, "cueRange");
  const auto nestedCueRange = extractTopLevelObjectField(object, "cueRange");
  const bool hasFlatCueField =
      findTopLevelFieldValue(object, "cueStartSeconds").has_value() ||
      findTopLevelFieldValue(object, "cueEndSeconds").has_value() ||
      findTopLevelFieldValue(object, "cuePregapSeconds").has_value() ||
      findTopLevelFieldValue(object, "cueVirtualPregapSeconds").has_value() ||
      findTopLevelFieldValue(object, "cueSourcePregapSeconds").has_value();
  bool cueFieldsWellTyped = true;
  if (nestedCueRange) {
    item.cueStartSeconds = extractTopLevelNumberField(*nestedCueRange, "startSeconds");
    item.cueEndSeconds = extractTopLevelNumberField(*nestedCueRange, "endSeconds");
    const auto pregap = extractTopLevelNumberField(*nestedCueRange, "pregapSeconds");
    const auto virtualPregap = extractTopLevelNumberField(*nestedCueRange, "virtualPregapSeconds");
    const auto sourcePregap = extractTopLevelNumberField(*nestedCueRange, "sourcePregapSeconds");
    cueFieldsWellTyped =
        (!findTopLevelFieldValue(*nestedCueRange, "pregapSeconds") || pregap) &&
        (!findTopLevelFieldValue(*nestedCueRange, "virtualPregapSeconds") || virtualPregap) &&
        (!findTopLevelFieldValue(*nestedCueRange, "sourcePregapSeconds") || sourcePregap);
    item.cuePregapSeconds = pregap.value_or(0.0);
    item.cueVirtualPregapSeconds = virtualPregap.value_or(0.0);
    item.cueSourcePregapSeconds = sourcePregap.value_or(0.0);
  } else if (hasFlatCueField) {
    item.cueStartSeconds = extractTopLevelNumberField(object, "cueStartSeconds");
    item.cueEndSeconds = extractTopLevelNumberField(object, "cueEndSeconds");
    const auto pregap = extractTopLevelNumberField(object, "cuePregapSeconds");
    const auto virtualPregap = extractTopLevelNumberField(object, "cueVirtualPregapSeconds");
    const auto sourcePregap = extractTopLevelNumberField(object, "cueSourcePregapSeconds");
    cueFieldsWellTyped =
        (!findTopLevelFieldValue(object, "cuePregapSeconds") || pregap) &&
        (!findTopLevelFieldValue(object, "cueVirtualPregapSeconds") || virtualPregap) &&
        (!findTopLevelFieldValue(object, "cueSourcePregapSeconds") || sourcePregap);
    item.cuePregapSeconds = pregap.value_or(0.0);
    item.cueVirtualPregapSeconds = virtualPregap.value_or(0.0);
    item.cueSourcePregapSeconds = sourcePregap.value_or(0.0);
  }
  if (nestedCueRangeStart || hasFlatCueField) {
    constexpr double kMaxSafeInteger = 9007199254740991.0;
    parsed.valid = cueFieldsWellTyped && (nestedCueRange.has_value() || !nestedCueRangeStart) &&
                   item.cueStartSeconds && item.cueEndSeconds &&
                   std::isfinite(*item.cueStartSeconds) && std::isfinite(*item.cueEndSeconds) &&
                   *item.cueStartSeconds >= 0.0 && *item.cueEndSeconds > *item.cueStartSeconds &&
                   *item.cueEndSeconds <= kMaxSafeInteger &&
                   std::isfinite(item.cuePregapSeconds) && item.cuePregapSeconds >= 0.0 &&
                   std::isfinite(item.cueVirtualPregapSeconds) && item.cueVirtualPregapSeconds >= 0.0 &&
                   std::isfinite(item.cueSourcePregapSeconds) && item.cueSourcePregapSeconds >= 0.0 &&
                   item.cueSourcePregapSeconds <= *item.cueStartSeconds;
  }
  if (item.id.empty()) item.id = item.source;
  if (item.title.empty()) item.title = item.id;
  return parsed;
}

std::string itemsToJson(const std::vector<QueueItem>& items) {
  std::ostringstream json;
  json << "[";
  for (size_t i = 0; i < items.size(); ++i) {
    if (i > 0) json << ",";
    json << QueueManager::itemToJson(items[i]);
  }
  json << "]";
  return json.str();
}

}  // namespace

bool QueueManager::loadFromJson(const std::string& queueJson, int startIndex, std::string* error) {
  rawQueueJson_ = queueJson.empty() ? "[]" : queueJson;
  items_.clear();

  if (!rawQueueJson_.empty() && rawQueueJson_.front() != '[') {
    if (error) *error = "播放队列格式无效";
    rawQueueJson_ = "[]";
    rebuildPlayOrder();
    return false;
  }

  for (const std::string& object : splitTopLevelObjects(rawQueueJson_)) {
    ParsedQueueItem parsed = parseQueueItem(object);
    if (!parsed.valid) {
      if (error) *error = "Invalid CUE range in playback queue";
      items_.clear();
      orderPosition_ = -1;
      rebuildPlayOrder();
      return false;
    }
    if (!parsed.item.source.empty()) items_.push_back(std::move(parsed.item));
  }

  if (items_.empty()) {
    orderPosition_ = -1;
    rebuildPlayOrder();
    return true;
  }

  startIndex = std::clamp(startIndex, 0, static_cast<int>(items_.size() - 1));
  rebuildPlayOrder();
  auto it = std::find(playOrder_.begin(), playOrder_.end(), startIndex);
  orderPosition_ = it == playOrder_.end() ? 0 : static_cast<int>(std::distance(playOrder_.begin(), it));
  return true;
}

bool QueueManager::addFromJson(const std::string& itemJson, std::string* error) {
  ParsedQueueItem parsed = parseQueueItem(itemJson);
  if (!parsed.valid) {
    if (error) *error = "Invalid CUE range in playback queue item";
    return false;
  }
  if (parsed.item.source.empty()) {
    if (error) *error = "队列项目缺少音频地址";
    return false;
  }
  items_.push_back(std::move(parsed.item));
  rawQueueJson_ = itemsToJson(items_);
  rebuildPlayOrder();
  if (orderPosition_ < 0) orderPosition_ = 0;
  return true;
}

bool QueueManager::removeAt(int index) {
  if (index < 0 || index >= static_cast<int>(items_.size())) return false;
  const int current = currentIndex();
  items_.erase(items_.begin() + index);
  rebuildPlayOrder();
  if (items_.empty()) {
    orderPosition_ = -1;
  } else {
    setCurrentIndex(std::clamp(current >= index ? current - 1 : current, 0, static_cast<int>(items_.size() - 1)));
  }
  rawQueueJson_ = itemsToJson(items_);
  return true;
}

void QueueManager::setPlayMode(PlayMode mode) {
  if (playMode_ == mode) return;
  const int current = currentIndex();
  playMode_ = mode;
  rebuildPlayOrder();
  setCurrentIndex(current);
}

PlayMode QueueManager::playMode() const {
  return playMode_;
}

std::string QueueManager::playModeId() const {
  return playModeToId(playMode_);
}

bool QueueManager::empty() const {
  return items_.empty();
}

int QueueManager::currentIndex() const {
  if (orderPosition_ < 0 || orderPosition_ >= static_cast<int>(playOrder_.size())) return -1;
  return playOrder_[static_cast<size_t>(orderPosition_)];
}

void QueueManager::setCurrentIndex(int index) {
  if (items_.empty()) {
    orderPosition_ = -1;
    return;
  }
  index = std::clamp(index, 0, static_cast<int>(items_.size() - 1));
  auto it = std::find(playOrder_.begin(), playOrder_.end(), index);
  orderPosition_ = it == playOrder_.end() ? 0 : static_cast<int>(std::distance(playOrder_.begin(), it));
}

std::optional<QueueItem> QueueManager::current() const {
  const int index = currentIndex();
  if (index < 0 || index >= static_cast<int>(items_.size())) return std::nullopt;
  return items_[static_cast<size_t>(index)];
}

std::optional<QueueItem> QueueManager::upcoming() const {
  const int index = queueIndexAtOrderOffset(1, true, false);
  if (index < 0 || index >= static_cast<int>(items_.size())) return std::nullopt;
  return items_[static_cast<size_t>(index)];
}

std::optional<QueueItem> QueueManager::findBySource(const std::string& source) const {
  if (source.empty()) return std::nullopt;
  for (const auto& item : items_) {
    if (item.source == source) return item;
  }
  return std::nullopt;
}

std::optional<QueueItem> QueueManager::next() {
  const int index = queueIndexAtOrderOffset(1, false, true);
  if (index < 0) return std::nullopt;
  setCurrentIndex(index);
  return current();
}

std::optional<QueueItem> QueueManager::previous() {
  const int index = queueIndexAtOrderOffset(-1, false, true);
  if (index < 0) return std::nullopt;
  setCurrentIndex(index);
  return current();
}

std::optional<QueueItem> QueueManager::advanceAfterEnd() {
  const int index = queueIndexAtOrderOffset(1, true, false);
  if (index < 0) return std::nullopt;
  setCurrentIndex(index);
  return current();
}

std::string QueueManager::queueJson() const {
  return rawQueueJson_;
}

std::string QueueManager::upcomingJson() const {
  return itemToJson(upcoming());
}

PlayMode QueueManager::parsePlayMode(const std::string& mode) {
  if (mode == "repeat") return PlayMode::Repeat;
  if (mode == "shuffle") return PlayMode::Shuffle;
  return PlayMode::Sequential;
}

std::string QueueManager::playModeToId(PlayMode mode) {
  switch (mode) {
    case PlayMode::Repeat:
      return "repeat";
    case PlayMode::Shuffle:
      return "shuffle";
    case PlayMode::Sequential:
    default:
      return "sequential";
  }
}

std::string QueueManager::itemToJson(const std::optional<QueueItem>& item) {
  if (!item) return "null";
  std::ostringstream json;
  json << "{"
       << "\"id\":\"" << escapeJson(item->id) << "\","
       << "\"source\":\"" << escapeJson(item->source) << "\","
       << "\"title\":\"" << escapeJson(item->title) << "\","
       << "\"artist\":\"" << escapeJson(item->artist) << "\","
       << "\"album\":\"" << escapeJson(item->album) << "\","
       << "\"duration\":" << item->durationSeconds << ","
       << "\"codec\":\"" << escapeJson(item->codec) << "\","
       << "\"sampleRate\":" << item->sampleRate << ","
       << "\"bitrate\":" << item->bitrate << ","
       << "\"bitDepth\":" << item->bitDepth;
  if (item->measuredIntegratedLufs) {
    json << ",\"measuredIntegratedLufs\":" << *item->measuredIntegratedLufs;
  }
  if (item->measuredTruePeakDb) {
    json << ",\"measuredTruePeakDb\":" << *item->measuredTruePeakDb;
  }
  if (item->replayGainTrackGainDb) {
    json << ",\"replayGainTrackGainDb\":" << *item->replayGainTrackGainDb;
  }
  if (item->replayGainAlbumGainDb) {
    json << ",\"replayGainAlbumGainDb\":" << *item->replayGainAlbumGainDb;
  }
  if (item->replayGainTrackPeak) {
    json << ",\"replayGainTrackPeak\":" << *item->replayGainTrackPeak;
  }
  if (item->replayGainAlbumPeak) {
    json << ",\"replayGainAlbumPeak\":" << *item->replayGainAlbumPeak;
  }
  if (item->r128TrackGainDb) {
    json << ",\"r128TrackGainDb\":" << *item->r128TrackGainDb;
  }
  if (item->r128AlbumGainDb) {
    json << ",\"r128AlbumGainDb\":" << *item->r128AlbumGainDb;
  }
  if (item->cueStartSeconds && item->cueEndSeconds) {
    json << ",\"cueStartSeconds\":" << *item->cueStartSeconds
         << ",\"cueEndSeconds\":" << *item->cueEndSeconds
         << ",\"cuePregapSeconds\":" << item->cuePregapSeconds
         << ",\"cueVirtualPregapSeconds\":" << item->cueVirtualPregapSeconds
         << ",\"cueSourcePregapSeconds\":" << item->cueSourcePregapSeconds;
  }
  json << "}";
  return json.str();
}

void QueueManager::rebuildPlayOrder() {
  // Snapshot the current item BEFORE iota resets the order map — after the
  // reset playOrder_[orderPosition_] no longer names the playing track, so
  // reading currentIndex() later would stabilize the wrong item.
  const int current = currentIndex();
  playOrder_.resize(items_.size());
  std::iota(playOrder_.begin(), playOrder_.end(), 0);

  if (playMode_ == PlayMode::Shuffle && playOrder_.size() > 1) {
    std::shuffle(playOrder_.begin(), playOrder_.end(), rng_);
    if (current >= 0) {
      auto it = std::find(playOrder_.begin(), playOrder_.end(), current);
      if (it != playOrder_.end()) std::iter_swap(playOrder_.begin(), it);
    }
  }

  if (items_.empty()) {
    orderPosition_ = -1;
  } else {
    // Keep pointing at the same item after the reshuffle. Without this, a
    // shuffle-mode rebuild (e.g. addToQueue) left orderPosition_ naming a
    // random other track while nothing was playing.
    setCurrentIndex(current >= 0 ? current : 0);
  }
}

int QueueManager::queueIndexAtOrderOffset(int offset, bool honorRepeat, bool allowWrap) const {
  if (items_.empty() || playOrder_.empty()) return -1;
  if (honorRepeat && playMode_ == PlayMode::Repeat) return currentIndex();

  const int count = static_cast<int>(playOrder_.size());
  const int base = orderPosition_ < 0 ? 0 : orderPosition_;
  const int rawNext = base + offset;
  if (!allowWrap && (rawNext < 0 || rawNext >= count)) return -1;
  int next = rawNext % count;
  if (next < 0) next += count;
  return playOrder_[static_cast<size_t>(next)];
}

}  // namespace twilight::audio
