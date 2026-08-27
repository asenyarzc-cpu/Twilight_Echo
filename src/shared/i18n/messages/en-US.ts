/**
 * English catalog. Key set must match `zh-CN` exactly — `translate.test.ts`
 * asserts it, so a key added to one catalog and forgotten in the other fails
 * the build rather than silently falling back at runtime.
 *
 * These are user-facing strings, not developer log lines: an `explain` says what
 * happened to the samples, a `fix` says what to actually do about it. An empty
 * `fix` means the user genuinely cannot act on it (hardware or format limits) —
 * inventing advice there would be worse than saying nothing.
 */

export const EN_US_MESSAGES: Record<string, string> = {
  // ══ Language setting ═════════════════════════════════════════════════════
  'settings.language.title': 'Language',
  'settings.language.description': 'Language used for the interface and error messages.',
  'settings.language.system': 'Follow system',
  'settings.language.zh-CN': '简体中文',
  'settings.language.en-US': 'English',

  // ══ Shared action labels ═════════════════════════════════════════════════
  // Label/value separator — halfwidth colon plus a space in English.
  'punct.labelSeparator': ': ',
  'action.retry': 'Retry',
  'action.resumePlayback': 'Resume',
  'action.resumeManually': 'Resume manually later',
  'action.openFolder': 'Open containing folder',

  // ══ DSP node names ═══════════════════════════════════════════════════════
  'audio.dspNode.replayGain': 'ReplayGain',
  'audio.dspNode.equalizer': 'Equalizer',
  'audio.dspNode.dynamicEqualizer': 'Dynamic EQ',
  'audio.dspNode.convolver': 'Convolver',
  'audio.dspNode.crossfeed': 'Crossfeed',
  'audio.dspNode.channelMatrix': 'Channel matrix',
  'audio.dspNode.channelStrip': 'Channel strip',
  'audio.dspNode.bassManagement': 'Bass management',
  'audio.dspNode.gate': 'Gate',
  'audio.dspNode.compressor': 'Compressor',
  'audio.dspNode.multibandCompressor': 'Multiband compressor',
  'audio.dspNode.stereoField': 'Stereo field',
  'audio.dspNode.loudnessContour': 'Loudness contour',
  'audio.dspNode.truePeakLimiter': 'True peak limiter',
  'audio.dspNode.nativePlugin': 'Native plugin',
  'audio.dspNode.vst3Plugin': 'VST3 plugin',
  'audio.dspNode.meter': 'Meter',

  // ══ Generic reason fallbacks ═════════════════════════════════════════════
  'audio.reason.dsp_node.label': '{node} is enabled',
  'audio.reason.dsp_node.explain':
    '{node} in the DSP chain is rewriting samples, so the output is no longer bit-identical to the source.',
  'audio.reason.dsp_node.fix': 'Disable {node} in the DSP rack, or switch to direct mode.',
  'audio.reason.unknown.explain':
    'The audio engine reported an unrecognised reason code ({code}). This usually means the engine is newer than the interface — please export an audio diagnostic report and send it in.',

  // ══ Playback controls ════════════════════════════════════════════════════
  'audio.reason.volume_not_unity.label': 'Software volume is not 100%',
  'audio.reason.volume_not_unity.explain':
    'Software volume multiplies every sample by a factor below 1, which changes the sample values. The 70% default protects your hearing, but bit-perfect playback needs unity (100%).',
  'audio.reason.volume_not_unity.fix':
    'Set software volume to 100% and control loudness with the physical knob on your amp or DAC instead.',

  'audio.reason.playback_rate_not_unity.label': 'Playback rate is not 1.0x',
  'audio.reason.playback_rate_not_unity.explain':
    'Any rate other than 1.0x goes through WSOLA pitch-preserving time stretching, which resynthesises the waveform.',
  'audio.reason.playback_rate_not_unity.fix': 'Reset the playback rate to 1.0x.',

  // ══ Processing chain ═════════════════════════════════════════════════════
  'audio.reason.processing_active.label': 'The processing chain is changing samples',
  'audio.reason.processing_active.explain':
    'A processing stage sits after the decoder, so samples are rewritten before they reach the device.',
  'audio.reason.processing_active.fix':
    'Enable direct mode in playback settings, or turn off the individual stages you do not need.',

  'audio.reason.replaygain_active.label': 'ReplayGain is changing samples',
  'audio.reason.replaygain_active.explain':
    'ReplayGain levels loudness using the gain value stored in the file tags. That is a per-sample multiplication, so sample values change.',
  'audio.reason.replaygain_active.fix': 'Set volume normalization to "off" in playback settings.',

  'audio.reason.loudnorm_active.label': 'Loudnorm is changing samples (EBU R128)',
  'audio.reason.loudnorm_active.explain':
    'Loudnorm applies gain based on measured EBU R128 loudness, which changes sample values.',
  'audio.reason.loudnorm_active.fix': 'Set volume normalization to "off" in playback settings.',

  'audio.reason.eq_active.label': 'EQ is changing samples',
  'audio.reason.eq_active.explain':
    'The equalizer applies per-band gain, so the output waveform differs from the source.',
  'audio.reason.eq_active.fix': 'Turn off the equalizer, or disable its node in the DSP rack.',

  'audio.reason.convolver_active.label': 'Convolver is changing samples',
  'audio.reason.convolver_active.explain':
    'The convolver folds an impulse response into the signal (room or headphone correction), which recomputes the output entirely.',
  'audio.reason.convolver_active.fix': 'Disable the convolver in the DSP rack.',

  'audio.reason.crossfeed_active.label': 'Crossfeed is changing channel content',
  'audio.reason.crossfeed_active.explain':
    'Crossfeed blends the left and right channels into each other to emulate speaker listening, which changes channel content.',
  'audio.reason.crossfeed_active.fix': 'Turn off crossfeed, or set its strength to 0.',

  'audio.reason.crossfade_active.label': 'Crossfade is changing playback continuity',
  'audio.reason.crossfade_active.explain':
    'Crossfade overlaps two streams at track boundaries and applies a gain envelope, rewriting samples in the transition and disabling true gapless.',
  'audio.reason.crossfade_active.fix': 'Set crossfade duration to 0 seconds in playback settings.',

  'audio.reason.dsd_output_mode_pcm.label': 'DSD output mode is set to PCM',
  'audio.reason.dsd_output_mode_pcm.explain':
    'The current setting forces DSD to PCM conversion and never attempts native DSD or DoP passthrough.',
  'audio.reason.dsd_output_mode_pcm.fix':
    'Change DSD output mode to "auto" or "native/DoP" in playback settings.',

  // ══ DSP scene / output stage ═════════════════════════════════════════════
  'audio.reason.dsp_scene_requires_pcm.label': 'The DSP scene requires PCM',
  'audio.reason.dsp_scene_requires_pcm.explain':
    'The active DSP scene contains nodes that only process PCM, so DSD must be converted before it can enter the chain.',
  'audio.reason.dsp_scene_requires_pcm.fix':
    'Disable those nodes in the DSP rack, or switch to an empty scene for DSD playback.',

  'audio.reason.output_sample_rate_locked.label': 'Output sample rate is locked',
  'audio.reason.output_sample_rate_locked.explain':
    'The output stage is pinned to {value}. When that differs from the source rate, the audio is resampled and samples are recomputed.',
  'audio.reason.output_sample_rate_locked.fix':
    'Set the output stage target sample rate to "follow device".',

  'audio.reason.output_resampler_active.label': 'Resampler is active',
  'audio.reason.output_resampler_active.explain':
    'The output stage is resampling at {value} quality, so output samples are regenerated by an interpolation algorithm.',
  'audio.reason.output_resampler_active.fix':
    'Set resampler quality to "native" to disable resampling.',

  'audio.reason.output_dither_active.label': 'Dither is active',
  'audio.reason.output_dither_active.explain':
    'The output stage is applying {value} dither. Dither deliberately adds a small amount of noise to improve bit-depth conversion, so samples change.',
  'audio.reason.output_dither_active.fix': 'Set output stage dither to "off".',

  // ══ Output routing / device ══════════════════════════════════════════════
  'audio.reason.shared_mixer.label': 'Shared output goes through the system mixer',
  'audio.reason.shared_mixer.explain':
    'In shared mode audio passes through the system mixer, which handles volume, resampling and mixing. Bit-perfect output is generally not possible there.',
  'audio.reason.shared_mixer.fix':
    'Select an exclusive mode (WASAPI Exclusive / ASIO) in playback settings.',

  'audio.reason.routing_not_auto.label': 'Channel routing is not automatic',
  'audio.reason.routing_not_auto.explain':
    'Channel routing is set to {value}, so samples are redistributed across channels by a matrix.',
  'audio.reason.routing_not_auto.fix': 'Set channel routing back to "auto".',

  'audio.reason.routing_changes_semantics.label': 'Channel routing or channel semantics changed',
  'audio.reason.routing_changes_semantics.explain':
    'The output chain changed the number or meaning of channels (up/downmix, channel remapping), so the output layout no longer matches the source.',
  'audio.reason.routing_changes_semantics.fix':
    'Check the channel matrix in the DSP rack and restore a passthrough layout.',

  'audio.reason.plugin_path.label': 'The device path includes a plugin or mixing layer',
  'audio.reason.plugin_path.explain':
    'The selected device is virtual or plugin-based (for example ALSA plug, or a virtual sound card), so audio gets processed a second time.',
  'audio.reason.plugin_path.fix':
    'Select the hardware device directly (an ALSA hw: device, for instance) to bypass the plugin layer.',

  'audio.reason.hog_mode_failed.label': 'Could not acquire CoreAudio hog mode exclusive access',
  'audio.reason.hog_mode_failed.explain':
    'Exclusive access was denied — usually another application holds the device. Playback fell back to shared mode.',
  'audio.reason.hog_mode_failed.fix':
    'Quit other applications playing audio, then reselect the device.',

  'audio.reason.sample_rate_unsupported.label': 'The device does not support the requested rate',
  'audio.reason.sample_rate_unsupported.explain':
    'The device rejected the source sample rate, so audio was resampled to the nearest supported rate.',
  'audio.reason.sample_rate_unsupported.fix':
    'Check the available rates in the driver panel; some DACs need a firmware mode switch for high rates.',

  'audio.reason.device_not_found.label': 'The backend could not find the requested device',
  'audio.reason.device_not_found.explain':
    'The stored device does not exist in the current backend — it may be unplugged, disabled, or its driver is not loaded.',
  'audio.reason.device_not_found.fix':
    'Refresh the device list in playback settings and pick the output device again.',

  'audio.reason.format_not_supported.label': 'The device does not support the requested format',
  'audio.reason.format_not_supported.explain':
    'The device rejected the requested bit depth or sample format, so playback fell back to a format it accepts.',
  'audio.reason.format_not_supported.fix':
    'Choose a different bit depth in output settings; in exclusive mode the available formats come from the driver.',

  'audio.reason.pcm_converted.label': 'PCM format or sample rate was converted',
  'audio.reason.pcm_converted.explain':
    'The source PCM rate or bit depth differs from the format the device actually opened, so a conversion happened in between.',
  'audio.reason.pcm_converted.fix':
    'Match the device format to the source, or use an exclusive mode that follows the source rate automatically.',

  'audio.reason.integer_passthrough_unavailable.label':
    'Source and device formats differ, so PCM passthrough is unavailable',
  'audio.reason.integer_passthrough_unavailable.explain':
    'Integer passthrough requires the source and device sample formats to match bit for bit. They do not, so a conversion path was used.',
  'audio.reason.integer_passthrough_unavailable.fix':
    'Pick an exclusive device that supports the source bit depth; a 24-in-32 packed exclusive device can pass 24-bit sources through.',

  'audio.reason.backend_not_output_perfect.label':
    'The current output path does not claim bit-perfect capability',
  'audio.reason.backend_not_output_perfect.explain':
    'This output backend offers no bit-exact passthrough guarantee (shared-mode WASAPI, for example).',
  'audio.reason.backend_not_output_perfect.fix':
    'Switch to WASAPI Exclusive, ASIO, or CoreAudio hog mode.',

  'audio.reason.output_not_perfect.label': 'The output chain is not verified as passthrough',
  'audio.reason.output_not_perfect.explain':
    'The engine has not gathered enough evidence to prove this chain is bit-exact. The chain may well be fine — it is simply unproven.',
  'audio.reason.output_not_perfect.fix': '',

  // ══ Source properties ════════════════════════════════════════════════════
  'audio.reason.source_lossy.label': 'The source is lossy, so source-exact is impossible',
  'audio.reason.source_lossy.explain':
    'Lossy formats (MP3, AAC and so on) decode to a reconstructed waveform; the original samples were discarded at encode time. This is not a player limitation.',
  'audio.reason.source_lossy.fix': '',

  'audio.reason.source_format_differs.label': 'Source format differs from the output chain',
  'audio.reason.source_format_differs.explain':
    'The source file format parameters differ from what the output chain actually uses.',
  'audio.reason.source_format_differs.fix':
    'Let the output device follow the source sample rate and bit depth.',

  // ══ DSD transport ════════════════════════════════════════════════════════
  'audio.reason.dsd_dop.label': 'DSD is being carried over DoP',
  'audio.reason.dsd_dop.explain':
    'DoP (DSD over PCM) packs the DSD bitstream into PCM frames. The DSD data itself stays intact; it just travels over a PCM channel.',
  'audio.reason.dsd_dop.fix': '',

  'audio.reason.dsd_processing_pcm_fallback.label': 'DSD fell back to PCM because processing is on',
  'audio.reason.dsd_processing_pcm_fallback.explain':
    'DSP cannot operate on a DSD bitstream directly, so DSD is converted to PCM before entering the chain.',
  'audio.reason.dsd_processing_pcm_fallback.fix':
    'Turn off DSP processing or enable direct mode so DSD stays native.',

  'audio.reason.dsd_volume_pcm_fallback.label': 'DSD fell back to PCM because volume is not 100%',
  'audio.reason.dsd_volume_pcm_fallback.explain':
    'Software volume multiplies every sample by a gain factor, and a DSD bitstream cannot carry gain directly, so DSD is demodulated to PCM before the volume is applied. This is unrelated to the DSP chain, and direct mode will not clear it — direct mode deliberately leaves volume alone rather than jumping the loudness to full scale.',
  'audio.reason.dsd_volume_pcm_fallback.fix':
    'Set software volume to 100% (unity) and control loudness with the physical knob on your amp or DAC; DSD then returns to native transport.',

  'audio.reason.dsd_high_rate_pcm_fallback.label':
    'DSD fell back to PCM due to rate or driver limits',
  'audio.reason.dsd_high_rate_pcm_fallback.explain':
    'This DSD rate exceeds what the device or driver can carry over native DSD or DoP, so it was converted to PCM.',
  'audio.reason.dsd_high_rate_pcm_fallback.fix':
    'Use a device that supports this rate, or play a lower-rate DSD file such as DSD64/DSD128.',

  'audio.reason.dsd_converted_to_pcm.label': 'DSD is currently converted to PCM',
  'audio.reason.dsd_converted_to_pcm.explain':
    'The DSD bitstream is demodulated to PCM before output.',
  'audio.reason.dsd_converted_to_pcm.fix':
    'Set DSD output mode to "auto" and select an exclusive device that supports DSD.',

  'audio.reason.dsd_probe_failed.label': 'The DSD source probe failed; fell back to PCM',
  'audio.reason.dsd_probe_failed.explain':
    'The engine could not read this DSD file\u2019s stream info before playback (damaged container or unreadable path), so neither native DSD nor DoP was attempted.',
  'audio.reason.dsd_probe_failed.fix':
    'Verify the file opens in another player; if it does, collect the engine logs and report it.',

  'audio.reason.dsd_backend_cannot_carry.label':
    'The active output backend cannot carry DSD; fell back to PCM',
  'audio.reason.dsd_backend_cannot_carry.explain':
    'The active backend (e.g. WASAPI shared mode) cannot transport bit-exact audio, so neither native DSD nor DoP can be established.',
  'audio.reason.dsd_backend_cannot_carry.fix':
    'Switch the audio output to ASIO or WASAPI exclusive mode (with a DSD-capable device).',

  'audio.reason.dsd_source_unsupported.label': 'This DSD source or mode is unsupported',
  'audio.reason.dsd_source_unsupported.explain':
    "This DSD source's container or encoding cannot be played directly right now.",
  'audio.reason.dsd_source_unsupported.fix': '',

  'audio.reason.dop_carrier_mismatch.label': 'DoP carrier format does not match the DSD rate',
  'audio.reason.dop_carrier_mismatch.explain':
    'DoP needs a specific PCM carrier rate (176.4 kHz for DSD64, 352.8 kHz for DSD128). The rate the device opened does not match.',
  'audio.reason.dop_carrier_mismatch.fix':
    'Allow the matching carrier rate in the driver, or switch to native DSD.',

  'audio.reason.dop_passthrough_unproven.label': 'The DoP output path is unproven',
  'audio.reason.dop_passthrough_unproven.explain':
    'The engine could not confirm that DoP frames reached the device unmodified. It may be fine — the evidence is just missing.',
  'audio.reason.dop_passthrough_unproven.fix': '',

  'audio.reason.dop_marker_mismatch.label': 'DoP marker byte check failed',
  'audio.reason.dop_marker_mismatch.explain':
    'DoP marks DSD frames with alternating 0x05/0xFA marker bytes. A failed check means something rewrote them, and the device may play the stream as noise.',
  'audio.reason.dop_marker_mismatch.fix':
    'Make sure no volume or mixing stage sits in the output chain; switch to native DSD if needed.',

  'audio.reason.native_dsd_runtime_unproven.label': 'Native DSD passthrough is unproven',
  'audio.reason.native_dsd_runtime_unproven.explain':
    'The device claims native DSD support, but the engine could not confirm at runtime that the bitstream arrived untouched. Playback is usually fine; only the proof is missing.',
  'audio.reason.native_dsd_runtime_unproven.fix': '',

  'audio.reason.native_dsd_typed_callback_missing.label': 'The driver lacks a native DSD callback',
  'audio.reason.native_dsd_typed_callback_missing.explain':
    'The ASIO driver exposes no DSD-specific data callback, so the engine cannot feed it as a bitstream and fell back to another transport.',
  'audio.reason.native_dsd_typed_callback_missing.fix':
    'Update the ASIO driver to a DSD-capable version, or use DoP instead.',

  'audio.reason.native_dsd_buffer_unit_mismatch.label':
    'The driver counts DSD buffers in a different unit than the engine',
  'audio.reason.native_dsd_buffer_unit_mismatch.explain':
    'The measured callback cadence shows this ASIO driver counts DSD buffer sizes in 1-bit samples instead of packed byte-frames, so continuing the passthrough would write past the buffers. Native DSD was marked unusable and reported honestly.',
  'audio.reason.native_dsd_buffer_unit_mismatch.fix':
    'Switch to DoP transport, or report the buffer-unit behavior to the driver vendor (the engine trace log can be attached).',

  'audio.reason.sacd_iso_unsupported.label': 'The SACD ISO has no playable uncompressed DSD area',
  'audio.reason.sacd_iso_unsupported.explain':
    'The tracks in this SACD image are DST-compressed, or there is no readable DSD area.',
  'audio.reason.sacd_iso_unsupported.fix':
    'Install a provider plugin that decodes DST while preserving DSD.',

  'audio.reason.dst_dsd_provider_unavailable.label':
    'SACD DST needs a DSD-preserving provider, which is unavailable',
  'audio.reason.dst_dsd_provider_unavailable.explain':
    'DST is the lossless compression used on SACD. Decoding it needs a dedicated provider plugin, which is not installed or not enabled.',
  'audio.reason.dst_dsd_provider_unavailable.fix':
    'Install and enable a DST decoding provider on the plugins page.',

  'audio.reason.dst_dsd_provider_failed.label': 'The SACD DST provider failed to decode',
  'audio.reason.dst_dsd_provider_failed.explain':
    'The DST provider is present but errored while decoding — possibly a damaged file or a version mismatch.',
  'audio.reason.dst_dsd_provider_failed.fix':
    'Update the DST provider plugin and verify the image file is intact.',

  // ══ Engine / driver faults ═══════════════════════════════════════════════
  'audio.reason.backend_open_failure.label': 'The output backend failed to open',
  'audio.reason.backend_open_failure.explain':
    'The output device could not be opened. Common causes: another application holds it exclusively, the driver is not ready, or the requested format was rejected.',
  'audio.reason.backend_open_failure.fix':
    'Quit other applications using the sound card, refresh the device list and retry; restart the audio service if needed.',

  'audio.reason.backend_start_failure.label': 'The output backend failed to start',
  'audio.reason.backend_start_failure.explain':
    'The device opened but the stream could not be started.',
  'audio.reason.backend_start_failure.fix':
    'Reselect the output device, or restart the audio service.',

  'audio.reason.buffer_failure.label': 'Output buffering failed or underran',
  'audio.reason.buffer_failure.explain':
    'Audio data did not reach the device buffer in time (an underrun), which causes clicks or stuttering. Usually the buffer is too small or the system is overloaded.',
  'audio.reason.buffer_failure.fix':
    'Increase the output buffer size, or close CPU-heavy background applications.',

  'audio.reason.device_lost.label': 'The output device disconnected and needs recovery',
  'audio.reason.device_lost.explain':
    'The device disappeared mid-playback — unplugged, asleep, or the driver reset.',
  'audio.reason.device_lost.fix':
    'Reconnect the device. The engine retries automatically; you can also restart the audio service manually.',

  'audio.reason.driver_restart.label': 'The driver restarted or reset',
  'audio.reason.driver_restart.explain':
    'The audio driver reset itself and the playback chain was rebuilt.',
  'audio.reason.driver_restart.fix': '',

  'audio.reason.unsupported_asio_sample_type.label': 'Unsupported ASIO sample format',
  'audio.reason.unsupported_asio_sample_type.explain':
    'The ASIO driver reported a sample format the engine cannot handle, so this format is unusable on this device for now.',
  'audio.reason.unsupported_asio_sample_type.fix':
    'Choose a different sample format in the ASIO control panel, or update the driver and retry.',

  'audio.reason.topology_rollback_failed.label': 'Output chain rollback failed',
  'audio.reason.topology_rollback_failed.explain':
    'After an output configuration change failed, the engine tried to roll back to the previous working configuration and that failed too. The audio chain is in an indeterminate state.',
  'audio.reason.topology_rollback_failed.fix': 'Restart the audio service to rebuild the chain.',

  'audio.reason.visualization_inactive.label': 'No visualization samples are available',
  'audio.reason.visualization_inactive.explain':
    'Visualization needs sample data from the processing chain. Passthrough and exclusive DSD paths skip the analysis node, so there is nothing to draw.',
  'audio.reason.visualization_inactive.fix': '',

  // ══ Audio engine errors (structured) ═════════════════════════════════════
  'error.audio.diagnostics_recorder_unavailable':
    'The audio diagnostic recorder is not initialised',
  'error.audio.service_fatal':
    'The audio service could not start: {reason}. Rebuild or reinstall the native audio engine and retry — audio is unavailable until then.',
  'error.audio.service_crashed':
    'The audio service restarted: {reason}. Recovery is under way; playback will not resume automatically.',
  'error.audio.service_start_failed': 'The audio service failed to start',
  'error.audio.service_still_failing': 'The audio service still cannot start',
  'error.audio.service_restarting': 'Restarting the audio service…',
  'error.audio.service_recovered':
    'The audio service recovered. Playback stopped and can be resumed manually.',
  'error.audio.service_recovered_route_pending':
    'The audio service recovered, but the output device or backend did not fully recover{detail}. Reselect an output device to continue.',
  'error.audio.restore_detail': ' ({detail})',
  'error.audio.output_route_not_restored':
    'The audio output device or backend was not fully restored',
  'error.audio.awaiting_route_confirmation': 'Waiting for structured output route recovery',
  'error.audio.unknown_reason': 'unknown reason',
  'error.audio.native_unavailable': 'The native audio engine is unavailable',
  'error.audio.native_unavailable_detail': 'The native audio engine is unavailable: {reason}',
  'error.audio.native_fallback':
    'The native audio engine is unavailable; a temporary playback path is in use: {reason}',
  'error.audio.playback_fallback_switched':
    'Playing {title} failed; switched to the {source} source: {reason}',
  'error.audio.playback_fallback_rematched':
    'Playing {title} failed; rematched to the {source} source',
  'error.audio.current_track': 'the current track',

  // ── Engine throws (main-process ipcError) ────────────────────────────────
  // {detail} is the raw reason from the native engine, usually English; when
  // there is none it becomes "the native audio engine is unavailable".
  'error.audio.engine_not_initialized': 'The native audio engine is not initialised yet',
  'error.audio.dsp_library_not_initialized': 'The DSP asset library is not initialised yet',
  'error.audio.vst3_catalog_not_initialized': 'The VST3 catalog is not initialised yet',
  'error.audio.dsp_asset_kind_invalid': 'Invalid DSP asset type',
  'error.audio.dsp_asset_id_invalid': 'Invalid DSP asset id',
  'error.audio.correction_profile_id_invalid': 'Invalid DSP correction profile id',
  'error.audio.correction_profile_missing': 'That DSP correction profile does not exist',
  'error.audio.exclusive_unsupported': '{backend} does not support exclusive mode',
  'error.audio.exclusive_switch_failed': 'Could not switch exclusive mode: {detail}',
  'error.audio.exclusive_config_failed':
    'Could not apply the exclusive-mode configuration: {detail}',
  'error.audio.device_switch_failed': 'Could not switch the output device: {detail}',
  'error.audio.service_restarted_during_topology':
    'The audio service restarted while the output topology was being updated',
  'error.audio.service_restarted_during_ack':
    'The audio service restarted while the output topology acknowledgement was being read',
  'error.audio.direct_routing_failed': 'Could not apply direct channel routing: {detail}',
  'error.audio.output_reopen_failed':
    'Could not reopen the output with the new configuration: {detail}',
  'error.audio.output_config_failed': 'Could not apply the output configuration: {detail}',
  'error.audio.source_empty': 'The audio source is empty',
  'error.audio.play_failed': 'Playback failed: {detail}',
  'error.audio.stop_failed': 'Could not stop playback: {detail}',
  'error.audio.queue_load_failed': 'Could not load the playback queue: {detail}',
  'error.audio.play_mode_sync_failed': 'Could not sync the play mode: {detail}',
  'error.audio.play_mode_switch_failed': 'Could not switch the play mode: {detail}',

  // ══ Network errors ═══════════════════════════════════════════════════════
  'error.network.timeout': 'The network request timed out',
  'error.network.failed': 'Network connection failed. Check your connection and retry.',
  'error.network.unauthorized': 'Your session expired. Please sign in again.',
  'error.network.rate_limited': 'Too many requests. Please try again shortly.',

  // ══ Generic error fallbacks ══════════════════════════════════════════════
  'error.generic.unknown': 'An unknown error occurred',
  'error.generic.withDetail': '{action} failed: {detail}',

  // ══ Diagnostics panel ════════════════════════════════════════════════════
  'diagnostics.panel.title': 'Output status diagnostics',
  'diagnostics.panel.perfect': 'The output chain is verified bit-exact',
  'diagnostics.panel.blockerCount': '{count} affecting passthrough',
  'diagnostics.panel.noBlockers': 'Nothing detected that affects passthrough',
  'diagnostics.panel.showDetail': 'Show reasons',
  'diagnostics.panel.hideDetail': 'Hide reasons',
  'diagnostics.panel.fixLabel': 'What to do',
  'diagnostics.panel.goToSetting': 'Go to setting',
  'diagnostics.severity.blocking': 'Blocks passthrough',
  'diagnostics.severity.degraded': 'Degraded transport',
  'diagnostics.severity.info': 'Note',
  'diagnostics.origin.player': 'Playback controls',
  'diagnostics.origin.processing': 'Processing chain',
  'diagnostics.origin.dsp-scene': 'DSP scene',
  'diagnostics.origin.output': 'Output device',
  'diagnostics.origin.source': 'Source file',
  'diagnostics.origin.engine': 'Engine/driver',

  // ══ Diagnostics export ═══════════════════════════════════════════════════
  'diagnostics.export.dialogTitle': 'Export audio diagnostics',
  'diagnostics.export.reportTitle': 'Twilight Echo audio diagnostic report',
  'diagnostics.export.generatedAt': 'Generated at',
  'diagnostics.export.conclusion': 'Conclusion',
  'diagnostics.export.conclusionPerfect':
    'The current output chain is verified bit-exact (bit-perfect).',
  'diagnostics.export.conclusionNotPerfect':
    'The current output chain is **not** bit-exact. {count} reason(s) found.',
  'diagnostics.export.conclusionNoPlayback':
    'Nothing was playing when this report was exported, so the following is a configuration snapshot only.',
  'diagnostics.export.currentPlayback': 'Current playback',
  'diagnostics.export.sourceFormat': 'Source format',
  'diagnostics.export.actualOutput': 'Actual output',
  'diagnostics.export.reasonsHeading': 'Reasons in detail',
  'diagnostics.export.whatHappens': 'What happens',
  'diagnostics.export.whatToDo': 'What to do',
  'diagnostics.export.noActionNeeded': 'This one cannot be acted on by the user.',
  'diagnostics.export.environment': 'Environment',
  'diagnostics.export.privacyHeading': 'Privacy',
  'diagnostics.export.privacyNote':
    'This report contains no audio content, no full local paths and no URL query parameters — paths and addresses are reduced to a type, an extension and a one-way fingerprint.',
  'diagnostics.export.rawHeading': 'Raw data (for developers)',
  'diagnostics.export.eventCount': '{count} recorded event(s)',
  'diagnostics.export.timelineHeading': 'Event timeline (warnings/errors + DSD route decisions)',
  'diagnostics.export.timelineEmpty': 'No warning or error events in the timeline.',
  'diagnostics.export.savedNotice': 'Audio diagnostic report exported',
  'diagnostics.export.failed': 'Failed to export the audio diagnostic log'
}
