# ADR: ASIO helper process isolation

- **Status**: Accepted for AP-101 implementation
- **Date**: 2026-08-31
- **Scope**: Windows x64 ASIO compatibility backend
- **Protocol revision**: 1

## Context

The audio engine already runs outside Electron's main process, and ASIO control calls already run
on a dedicated COM thread. That limits UI stalls, but the third-party driver DLL is still loaded in
the audio service process. A driver access violation, infinite control call, or corrupted callback
can therefore terminate or wedge the whole audio service.

AP-101 adds one more fault boundary. The audio service keeps Twilight Echo's decoder, queue, DSP,
format selection, and diagnostics. A native helper process alone loads the ASIO driver and owns its
COM objects, driver buffers, callback router, and control thread. The helper contains no renderer,
preload, Electron main-process, queue, decoder, or DSP logic.

## Decision

### Process boundary

`AsioBackend` remains the engine-facing output backend. Its default `IAsioHost` becomes an isolated
host proxy. The proxy launches `twilight-asio-helper.exe` from beside the audio-engine binaries.
The helper owns `RealAsioHost`; tests may launch the same server with a fake host fixture.

Registry enumeration, capability probing, open, buffer creation, start, stop, close, and format
restoration all cross this boundary. No ASIO driver method is called from the audio service.

### Versioned control protocol

The parent creates a named shared-memory mapping plus request and response events before launch.
Both sides validate a magic value, protocol version, structure size, limits, and monotonically
increasing request sequence. Revision 1 has these commands:

1. `EnumerateDevices`
2. `GetDiagnostics`
3. `ProbeDevice`
4. `Open`
5. `CreateBuffers`
6. `Start`
7. `Stop`
8. `Close`
9. `Shutdown`

Only one control request may be outstanding. The parent publishes a complete fixed-layout request,
signals the request event, then waits for the matching response sequence or helper process exit.
Unknown commands, malformed counts, oversize strings, or a version mismatch fail closed with
`asio_helper_protocol_error`.

### Deadlines

Control waits are bounded and cancellation is destructive because a timed-out driver call cannot be
made trustworthy in place:

| Operation                                 |                     Deadline |
| ----------------------------------------- | ---------------------------: |
| launch/handshake                          |                          5 s |
| enumerate/probe/open/create buffers/start |                         12 s |
| stop/close/shutdown                       |                          3 s |
| callback heartbeat after start            | max(2 s, 8 callback periods) |

On any deadline breach the parent terminates the helper, closes its process/event/mapping handles,
marks the host unusable, and reports `asio_helper_control_timeout` or
`asio_helper_callback_stalled`. It does not retry or recreate the stream automatically.

### Shared render buffer ownership

The mapping contains two preallocated output buffer sets and a bounded callback notification ring.
The audio service owns writes to a buffer set. The helper callback owns reads after the parent
publishes that set's committed generation. Ownership returns to the parent after the helper copies
the committed bytes to the driver's corresponding buffer and publishes the callback index.

The helper callback performs only bounded memory copies, fixed-size silence fill, interlocked loads
and stores, and `outputReady`. It does not allocate, lock, wait on an event, issue a control request,
touch disk or network, or call Electron IPC. If the next generation is not ready, it writes silence
and increments the shared underrun counter instead of reading a buffer being modified.

PCM silence is zero. Native DSD silence uses the channel format's idle byte. The parent explicitly
commits the number of frames it rendered, which preserves the existing conservative DSD buffer-unit
probe without guessing whether a driver reports bytes or one-bit samples.

### Exit and failure state machine

| Trigger                       | Helper action                                                                | Parent action                                          | Playback result     | Stable reason                       |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------- | ----------------------------------- |
| normal `Stop`/`Close`         | stop, dispose buffers, restore retained PCM format/rate, release COM objects | close mapping session; helper may remain for later use | stopped             | none                                |
| normal `Shutdown`             | perform `Close`, publish stopped, exit 0                                     | wait boundedly, close all handles                      | stopped             | none                                |
| control timeout/hang          | may remain stuck                                                             | terminate helper and close shared resources            | immediate safe stop | `asio_helper_control_timeout`       |
| unexpected exit/crash         | OS closes driver/process handles                                             | observe process exit and close shared resources        | immediate safe stop | `asio_helper_process_exited`        |
| externally killed             | no cleanup code is assumed                                                   | observe process exit and close shared resources        | immediate safe stop | `asio_helper_process_exited`        |
| callback heartbeat stops      | no callback progress                                                         | terminate helper and close shared resources            | immediate safe stop | `asio_helper_callback_stalled`      |
| driver/device rejects open    | close attempted session; restore any attempted DSD switch                    | return failure without starting                        | remains stopped     | `asio_helper_device_rejected`       |
| PCM format/rate restore fails | close remaining driver objects and report failure                            | keep ASIO unavailable for this session                 | remains stopped     | `asio_helper_format_restore_failed` |
| malformed protocol            | stop accepting commands and exit                                             | terminate if needed and close mapping                  | remains stopped     | `asio_helper_protocol_error`        |

Helper process failure is surfaced as an output render failure rather than a device-invalidated
event. This is deliberate: device-invalidated events may use the engine's existing automatic default
device recovery, while AP-101 requires no automatic resume after helper failure. Queue and position
remain available to the application, but playback stays stopped until the user explicitly retries
ASIO or selects WASAPI Shared/Exclusive.

### Diagnostics and fallback

The stable reason is written to `OutputInfo.perfectReasonCode`, with the detailed driver or Windows
message in `capabilityReason` and diagnostics `lastError`. The existing output settings remain the
only fallback control surface; the helper never changes backend or device selection itself.

### Packaging and legal boundary

Windows staging requires `twilight-asio-helper.exe` beside `twilight-audio-engine.dll` and
`twilight_audio_node.node`. Its full non-system PE import closure is staged and verified like the
other native runtime binaries. A release with ASIO enabled but no helper fails staging and artifact
verification.

The helper compiles only the repository's independent ABI contract and Windows system interfaces.
No ASIO SDK header, source, archive, binary, path, or build option is introduced. The existing
`verify:asio-sdk-free` and cross-ABI gates remain required.

## Consequences

- A defective ASIO driver can terminate or wedge only the helper; Electron main and the audio
  service remain alive.
- Render delivery gains one shared-buffer ownership handoff but no blocking IPC in the driver
  callback.
- A helper failure is intentionally audible as a stop, never as an automatic resume on an
  unverified route.
- ASIO now depends on one required staged executable and its runtime dependency closure.
- Real-device ASIO behavior remains opt-in evidence; fake lifecycle tests prove isolation mechanics,
  not hardware compatibility.
