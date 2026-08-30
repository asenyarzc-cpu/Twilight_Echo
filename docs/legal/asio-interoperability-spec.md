# ASIO Interoperability Specification

Status: experimental contract frozen for hardware validation; not approved for release enablement

Scope: internal Windows x64 compatibility contract.

Contract revision: `3`.

Revision 1 defines a two-buffer output path, a single active session, little-endian PCM formats
(Int16, packed Int24, Int24-in-Int32, Int32, and Float32), callback routing, and the
control-thread lifecycle. Each channel supplies `logicalFormat`, `containerBits`, `validBits`,
endianness, alignment, and DSD-packing metadata. Unsupported formats fail with
`unsupported_asio_sample_type`.

Revision 2 adds the Native DSD I/O-format extension for an explicit raw DSD open only. It does not
change the existing virtual method order. The extension calls the existing `future()` virtual slot
with the following Windows x64 data contract:

| Field or selector              | Value                                                            |
| ------------------------------ | ---------------------------------------------------------------- |
| request block size / alignment | 512 bytes / 4 bytes                                              |
| `formatType`                   | signed 32-bit integer at offset 0                                |
| reserved bytes                 | 508 bytes at offset 4; caller zeroes all bytes before every call |
| PCM format type                | `0`                                                              |
| DSD format type                | `1`                                                              |
| set I/O format selector        | `0x23111961`                                                     |
| get I/O format selector        | `0x23111983`                                                     |
| can-do I/O format selector     | `0x23112004`                                                     |
| success                        | error value `0` or `0x3f4847a0`                                  |

The request block is represented internally as `AsioIoFormat`. Its `sizeof`, alignment, and field
offsets are part of `audio-engine/output/asio/abi/asio-abi-manifest.json` and are asserted by both
Windows toolchains. No SDK header or source is stored, included, or compiled by this project.

All ASIO control calls accept both success values. A driver that returns the alternate positive
success value must not be treated as having rejected a format or rate.

For a Native DSD request, the control thread must use this sequence before buffers are created:

1. Read and retain the current PCM sample rate and I/O format. The current format must report PCM.
2. Call can-do for DSD, set DSD, then get and require DSD as the active format.
3. Call can-sample-rate and set-sample-rate for the raw DSD transport rate.
4. Re-read the buffer-size range and re-choose the buffer size. A driver's valid buffer range in
   DSD mode may differ from its PCM-mode range (observed in the field: createBuffers rejecting
   PCM-mode sizes with ASE_InvalidParameter after the DSD switch). A failed re-read or an invalid
   re-read range keeps the PCM-mode choice rather than failing the open.
5. Read back the transport rate and query every output channel. Every channel must report the exact
   requested raw DSD sample type.
6. Only then create buffers and start. Runtime proof still requires a successful typed raw DSD
   callback, so an open alone is not `nativeDsdRuntimeState=proven`.

Revision 3 adds step 4 only; the revision-2 data layout and selector contract are unchanged.

When can-do reported DSD support but both set attempts were refused, the negotiation failure text
must note that another audio client likely holds the device: that refusal shape is
field-verified as a multi-client format lock (the same driver accepts every switch the moment
the other client closes), not as missing DSD capability.

No Native DSD probe runs during device enumeration or while the driver is already playing. The
whole request runs on the bounded ASIO control command; a timeout marks the session unhealthy and
the audio service recovery path owns process isolation. A missing extension, non-PCM initial state,
format mismatch, rate mismatch, or channel mismatch fails the Native DSD open and lets the normal
Native DSD -> DoP -> PCM selection path report its fallback honestly.

After any successful or attempted DSD format switch, close first stops and disposes buffers, then
restores the retained PCM I/O format, restores the retained PCM sample rate, clears callback state,
and releases the COM interface. The restoration attempt is required even when the DSD set call
returns an error, because a driver may have partially changed state before reporting failure.

The fake driver must cover successful can/get/set, unsupported format, exact DSD channel type,
transport-rate verification, and PCM restoration. `pnpm run test:asio-cross-abi` validates that
MSVC's fake DLL and the MinGW host agree on the revision-2 layout and can complete that round trip.
This is implementation evidence, not a substitute for real-device proof or a release decision.
