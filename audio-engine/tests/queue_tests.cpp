#include "../playlist/QueueManager.h"

#include <cassert>
#include <string>

using namespace twilight::audio;

namespace {

const char* kQueueJson =
    "[{\"id\":\"a\",\"audioSource\":\"a.flac\",\"duration\":1.5},"
    "{\"id\":\"b\",\"source\":\"b.flac\",\"duration\":2.5},"
    "{\"id\":\"c\",\"filePath\":\"c.flac\",\"duration\":3.5}]";

void testLoadAndUpcoming() {
  QueueManager queue;
  std::string error;
  assert(queue.loadFromJson(kQueueJson, 1, &error));
  assert(queue.currentIndex() == 1);
  assert(queue.current()->source == "b.flac");
  assert(queue.upcoming()->source == "c.flac");
  assert(queue.upcomingJson().find("\"source\":\"c.flac\"") != std::string::npos);
}

void testSequentialAdvanceStopsAtQueueEnd() {
  QueueManager queue;
  std::string error;
  assert(queue.loadFromJson(kQueueJson, 2, &error));
  auto next = queue.advanceAfterEnd();
  assert(!next);
  assert(queue.currentIndex() == 2);
  assert(!queue.upcoming());
  assert(queue.upcomingJson() == "null");
}

void testSequentialManualNextStillWraps() {
  QueueManager queue;
  std::string error;
  assert(queue.loadFromJson(kQueueJson, 2, &error));
  auto next = queue.next();
  assert(next);
  assert(queue.currentIndex() == 0);
  assert(next->source == "a.flac");
}

void testRepeatAdvanceKeepsCurrentTrack() {
  QueueManager queue;
  std::string error;
  assert(queue.loadFromJson(kQueueJson, 1, &error));
  queue.setPlayMode(PlayMode::Repeat);
  auto next = queue.advanceAfterEnd();
  assert(next);
  assert(queue.currentIndex() == 1);
  assert(next->source == "b.flac");
}

void testRepeatManualNextUsesPlaylistOrder() {
  QueueManager queue;
  std::string error;
  assert(queue.loadFromJson(kQueueJson, 1, &error));
  queue.setPlayMode(PlayMode::Repeat);
  auto next = queue.next();
  assert(next);
  assert(queue.currentIndex() == 2);
  assert(next->source == "c.flac");
  auto previous = queue.previous();
  assert(previous);
  assert(queue.currentIndex() == 1);
  assert(previous->source == "b.flac");
}

void testAddRemoveAndInvalidInput() {
  QueueManager queue;
  std::string error;
  assert(!queue.loadFromJson("{\"source\":\"bad.flac\"}", 0, &error));
  assert(queue.empty());
  assert(queue.addFromJson("{\"source\":\"one.flac\"}", &error));
  assert(queue.addFromJson("{\"streamUrl\":\"two.flac\"}", &error));
  assert(queue.currentIndex() == 0);
  assert(queue.removeAt(0));
  assert(queue.currentIndex() == 0);
  assert(queue.current()->source == "two.flac");
  assert(!queue.removeAt(4));
}

void testSingleFileCueRangesKeepDistinctQueueIdentity() {
  QueueManager queue;
  std::string error;
  const char* cueQueue =
      "[{\"id\":\"cue-1\",\"source\":\"disc.flac\",\"duration\":60,"
      "\"cueRange\":{\"startSeconds\":0,\"endSeconds\":60,\"pregapSeconds\":0},"
      "\"replayGainTrackGainDb\":-3},"
      "{\"id\":\"cue-2\",\"source\":\"disc.flac\",\"duration\":58,"
      "\"cueRange\":{\"startSeconds\":60,\"endSeconds\":118,\"pregapSeconds\":2,"
      "\"virtualPregapSeconds\":2,\"sourcePregapSeconds\":1.5},"
      "\"replayGainTrackGainDb\":-9}]";
  assert(queue.loadFromJson(cueQueue, 1, &error));
  assert(queue.currentIndex() == 1);
  const auto current = queue.current();
  assert(current);
  assert(current->source == "disc.flac");
  assert(current->cueStartSeconds && *current->cueStartSeconds == 60.0);
  assert(current->cueEndSeconds && *current->cueEndSeconds == 118.0);
  assert(current->cuePregapSeconds == 2.0);
  assert(current->cueVirtualPregapSeconds == 2.0);
  assert(current->cueSourcePregapSeconds == 1.5);
  assert(current->replayGainTrackGainDb && *current->replayGainTrackGainDb == -9.0);
  const std::string serialized = QueueManager::itemToJson(current);
  assert(serialized.find("\"cueStartSeconds\":60") != std::string::npos);
  assert(serialized.find("\"cueEndSeconds\":118") != std::string::npos);
  assert(serialized.find("\"cuePregapSeconds\":2") != std::string::npos);
  assert(serialized.find("\"cueVirtualPregapSeconds\":2") != std::string::npos);
  assert(serialized.find("\"cueSourcePregapSeconds\":1.5") != std::string::npos);
  QueueManager reloaded;
  assert(reloaded.loadFromJson("[" + serialized + "]", 0, &error));
  assert(reloaded.current()->cueStartSeconds && *reloaded.current()->cueStartSeconds == 60.0);
}

void testMalformedCueRangesFailClosedInsteadOfBecomingWholeFilePlayback() {
  QueueManager queue;
  std::string error;
  assert(!queue.loadFromJson(
      "[{\"source\":\"disc.flac\",\"cueRange\":{\"startSeconds\":60,\"endSeconds\":20,"
      "\"pregapSeconds\":-1}}]",
      0,
      &error));
  assert(queue.empty());
  assert(error.find("CUE range") != std::string::npos);
  assert(!queue.addFromJson("{\"source\":\"disc.flac\",\"cueRange\":null}", &error));
  assert(!queue.loadFromJson(
      "[{\"source\":\"disc.flac\",\"cueRange\":{\"startSeconds\":0,\"endSeconds\":60,"
      "\"pregapSeconds\":\"2\"}}]",
      0,
      &error));
  assert(!queue.loadFromJson(
      "[{\"source\":\"disc.flac\",\"cueRange\":{\"note\":\"\\\"startSeconds\\\":0,"
      "\\\"endSeconds\\\":60\"}}]",
      0,
      &error));
  assert(!queue.loadFromJson(
      "[{\"source\":\"disc.flac\",\"cueRange\":{\"startSeconds\":1e9999,\"endSeconds\":60}}]",
      0,
      &error));
  assert(!queue.loadFromJson(
      "[{\"source\":\"disc.flac\",\"cueRange\":{\"startSeconds\":0oops,\"endSeconds\":60}}]",
      0,
      &error));
}

void testCueFieldsInsideUserStringsCannotForgeNativeRanges() {
  QueueManager queue;
  std::string error;
  assert(queue.loadFromJson(
      "[{\"source\":\"disc.flac\",\"title\":\"quoted \\\"startSeconds\\\":60,"
      "\\\"endSeconds\\\":120\"}]",
      0,
      &error));
  const auto current = queue.current();
  assert(current);
  assert(!current->cueStartSeconds);
  assert(!current->cueEndSeconds);
}

void testShuffleAddKeepsCurrentTrackStable() {
  QueueManager queue;
  std::string error;
  assert(queue.loadFromJson(kQueueJson, 1, &error));
  queue.setPlayMode(PlayMode::Shuffle);
  assert(queue.currentIndex() == 1);
  // Adding tracks must not reshuffle the current item out from under an
  // active playback session.
  for (int added = 0; added < 8; ++added) {
    const std::string item = "{\"source\":\"extra" + std::to_string(added) + ".flac\"}";
    assert(queue.addFromJson(item, &error));
    assert(queue.currentIndex() == 1);
    assert(queue.current()->source == "b.flac");
  }
}

}  // namespace

int main() {
  testLoadAndUpcoming();
  testSequentialAdvanceStopsAtQueueEnd();
  testSequentialManualNextStillWraps();
  testRepeatAdvanceKeepsCurrentTrack();
  testRepeatManualNextUsesPlaylistOrder();
  testAddRemoveAndInvalidInput();
  testShuffleAddKeepsCurrentTrackStable();
  testSingleFileCueRangesKeepDistinctQueueIdentity();
  testMalformedCueRangesFailClosedInsteadOfBecomingWholeFilePlayback();
  testCueFieldsInsideUserStringsCannotForgeNativeRanges();
  return 0;
}
