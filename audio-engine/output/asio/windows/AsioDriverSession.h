#pragma once

#include "../IAsioHost.h"
#include "AsioCallbackRouter.h"
#include "AsioControlThread.h"
#include "AsioDriverCatalog.h"

#include <memory>
#include <string>

namespace twilight::audio::asio_windows {

class AsioDriverSession final {
 public:
  AsioDriverSession(AsioDriverEntry entry, std::shared_ptr<AsioControlThread> controlThread);
  ~AsioDriverSession();

  bool open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error);

  /**
   * Interrogate the driver for its real capabilities without creating buffers
   * or starting a stream. Restores the driver's original sample rate and I/O
   * format before returning so a probe never disturbs a later open().
   */
  bool probe(AsioDeviceInfo* info, std::string* error);

  bool createBuffers(
      AsioBufferSwitchCallback bufferSwitch,
      AsioEventCallback eventCallback,
      std::string* error);
  bool start(std::string* error);
  void stop();
  void close();
  void* outputBuffer(long channel, long bufferIndex) const;
  AsioChannelFormat outputChannelFormat(long channel) const;
  bool outputReady();
  // The size the driver actually accepted; can differ from the open result
  // when createBuffers fell back to the driver's preferred size.
  long activeBufferSize() const;

 private:
  struct State;

  AsioDriverEntry entry_;
  std::shared_ptr<AsioControlThread> controlThread_;
  std::shared_ptr<State> state_;
};

}  // namespace twilight::audio::asio_windows
