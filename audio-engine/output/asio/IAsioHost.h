#pragma once

#include "../../core/AudioTypes.h"
#include "AsioQuirkTypes.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace twilight::audio {

enum class AsioHostEvent {
  DriverReset,
  DriverRestart,
  DeviceLost,
  /** The stream is no longer usable and must be rebuilt. */
  BufferFailure,
  /**
   * A transient driver-side load event (ASIO Overload / LatenciesChanged).
   *
   * Purely informational: the stream stays valid, so this is counted and
   * surfaced but never triggers recovery. Rebuilding on it converts a momentary
   * glitch into a certain multi-hundred-millisecond dropout, and a short burst
   * of them would trip the recovery rate limiter into its 10 s cooldown - a
   * CPU spike would take audio down for far longer than the spike itself.
   */
  Xrun,
  HelperFailure
};

enum class AsioDsdPacking : uint8_t {
  None,
  Lsb1,
  Msb1,
  Ner8
};

struct AsioChannelFormat {
  AudioSampleFormat logicalFormat = AudioSampleFormat::Float32Interleaved;
  uint8_t containerBits = 32;
  uint8_t validBits = 32;
  bool littleEndian = true;
  bool validBitsAreMostSignificant = false;
  AsioDsdPacking dsdPacking = AsioDsdPacking::None;
};

struct AsioDeviceInfo {
  std::string id;
  std::string name;
  std::string driverName;
  long driverVersion = 0;
  int outputChannels = 0;
  std::vector<int> supportedSampleRates;
  std::vector<int> bitDepths;
  std::vector<AudioSampleFormat> sampleFormats;
  bool dopCapable = false;
  bool nativeDsdCapable = false;
  std::vector<int> dopCarrierSampleRates;
  std::vector<AudioSampleFormat> dopCarrierSampleFormats;
  std::vector<int> nativeDsdSampleRates;
  std::vector<AudioSampleFormat> nativeDsdSampleFormats;
  int defaultSampleRate = 0;
  int defaultBitDepth = 32;
  AudioSampleFormat defaultSampleFormat = AudioSampleFormat::Float32Interleaved;
  long minBufferSize = 0;
  long maxBufferSize = 0;
  long bufferGranularity = 0;
  long preferredBufferSize = 0;
  long outputLatencyFrames = 0;
  uint64_t capabilityVersion = 0;
  bool isDefault = false;
  /**
   * Whether a driver interrogation actually filled the capability fields.
   *
   * The ASIO registry carries identity only, so an unprobed record has
   * `dopCapable` and `nativeDsdCapable` at their false defaults. Reporting that
   * as "this driver cannot do DSD" told users their DAC was incapable when
   * nothing had asked it yet.
   */
  bool capabilityProbed = false;
};

struct AsioOpenConfig {
  std::string deviceId;
  AudioFormat format;
  long bufferSizeFrames = 0;
  std::optional<AsioSampleFormatMapping> sampleFormatMapping;
  AsioNativeDsdControlOrder nativeDsdControlOrder = AsioNativeDsdControlOrder::Default;
  long dsdMinimumBufferFrames = 0;
  uint32_t dsdCadenceConfirmCallbacks = 2;
};

/**
 * Why an open attempt failed, which decides whether another format is worth
 * trying.
 *
 * A driver that cannot be activated or initialized will reject every format
 * identically, so retrying only hides the real error. A driver that refused
 * this particular rate or sample type may well accept the next candidate.
 */
enum class AsioOpenFailureKind : uint8_t {
  None,
  /** Activation, init, or another driver-wide fault. Retrying is pointless. */
  Driver,
  /** This rate/sample type/buffer size was refused. Another may work. */
  Format
};

struct AsioOpenResult {
  AudioFormat actualFormat;
  long bufferSizeFrames = 0;
  long latencyFrames = 0;
  std::string driverName;
  long driverVersion = 0;
  // Native DSD drivers are inconsistent about ASIOFuture(kFutureGetIoFormat).
  // Preserve the negotiation outcome separately from the runtime channel proof.
  std::string nativeDsdNegotiation;
  AsioOpenFailureKind failureKind = AsioOpenFailureKind::None;
};

struct AsioHostDiagnostics {
  std::string processArchitecture;
  bool buildEnabled = false;
  bool environmentDisabled = false;
  int registeredDriverCount32 = 0;
  int registeredDriverCount64 = 0;
  int loadableDriverCount64 = 0;
};

using AsioBufferSwitchCallback = std::function<void(long bufferIndex)>;
using AsioEventCallback = std::function<void(AsioHostEvent event, const std::string& message)>;

class IAsioHost {
 public:
  virtual ~IAsioHost() = default;

  virtual std::vector<AsioDeviceInfo> enumerateDevices() = 0;
  virtual AsioHostDiagnostics diagnostics() const = 0;

  /**
   * Fill in the capability fields the ASIO registry cannot report: output
   * channel count, the sample rates the driver actually accepts, the runtime
   * channel sample type, the buffer-size range, and whether the driver can
   * switch to a DSD I/O format.
   *
   * The registry only exposes driver identity, so without this probe every
   * capability field stays at its default and format selection degenerates to
   * a single guess that the driver is free to reject. Implementations open the
   * driver once, query it, and restore whatever they changed.
   *
   * Returns false when the driver could not be interrogated at all; `info` is
   * then left untouched and callers must fall back to identity-only data.
   */
  virtual bool probeDevice(const std::string& deviceId, AsioDeviceInfo* info, std::string* error) = 0;

  virtual bool open(const AsioOpenConfig& config, AsioOpenResult* result, std::string* error) = 0;
  virtual bool createBuffers(AsioBufferSwitchCallback bufferSwitch, AsioEventCallback eventCallback, std::string* error) = 0;
  virtual bool start(std::string* error) = 0;
  virtual void stop() = 0;
  virtual void close() = 0;

  virtual void* outputBuffer(long channel, long bufferIndex) = 0;
  virtual AudioSampleFormat outputSampleFormat(long channel) const = 0;
  virtual AsioChannelFormat outputChannelFormat(long channel) const = 0;
  virtual bool outputReady() = 0;
  // The buffer size the driver actually accepted; can differ from the open
  // result when createBuffers fell back to the driver's preferred size.
  virtual long activeBufferSize() const = 0;
  virtual void commitOutputBuffer(long bufferIndex, size_t frameCount) {
    (void)bufferIndex;
    (void)frameCount;
  }
  virtual std::string lastCloseError() const { return {}; }
};

std::unique_ptr<IAsioHost> createRealAsioHost();
std::unique_ptr<IAsioHost> createIsolatedAsioHost();

std::vector<int> asioDefaultSampleRateProbeSet();

/**
 * DSD semantic sample rates to probe, ascending, covering DSD64..DSD512 in both
 * the 44.1kHz and 48kHz families.
 *
 * Kept separate from the PCM probe set on purpose. These are the values ASIO
 * DSD drivers expect from CanSampleRate/SetSampleRate once a DSD I/O format is
 * active, and feeding them into PCM rate selection would let a PCM stream
 * negotiate a megahertz "rate". The PCM set tops out in the low megahertz for
 * DoP carriers, so it can never answer whether DSD256 is available — which is
 * why DSD capability has to be probed with its own rate list.
 */
std::vector<int> asioDsdSemanticRateProbeSet();

std::string asioSampleFormatName(AudioSampleFormat format);
std::string enumerateAsioDevicesJson();

/**
 * Device ids of ASIO drivers that a capability probe proved can accept a raw
 * DSD I/O format. Used to auto-discover a DSD-capable route when the main
 * output cannot carry DSD and the user has not pinned one explicitly.
 *
 * Ordering is the enumeration order, so the choice is stable across calls.
 */
std::vector<std::string> asioNativeDsdCapableDeviceIds();

}  // namespace twilight::audio
