import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildVisualizerQualityString,
  formatVisualizerBitrate
} from './audioVisualizerFormatting.ts'

test('visualizer bitrate formatting converts bps to kbps', () => {
  assert.equal(formatVisualizerBitrate(1737220), '1737 kbps')
})

test('visualizer bitrate formatting keeps existing kbps values', () => {
  assert.equal(formatVisualizerBitrate(320), '320 kbps')
})

test('visualizer quality string includes normalized bitrate and source fields', () => {
  assert.equal(
    buildVisualizerQualityString({
      format: 'flac',
      bitDepth: 24,
      sampleRate: 44100,
      bitrate: 1737220
    }),
    'FLAC / 24-bit / 44.1kHz / 1737kbps'
  )
})

test('audio visualizer renderer avoids random low-frequency texture', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(visualizer, /subBinTexture/)
  assert.doesNotMatch(panel, /subBinTexture/)
  assert.doesNotMatch(visualizer, /applyVisualizerSpectralContrast/)
  assert.doesNotMatch(panel, /applyVisualizerSpectralContrast/)
  assert.doesNotMatch(visualizer, /spectralTilt/)
  assert.doesNotMatch(panel, /spectralTilt/)
  assert.doesNotMatch(visualizer, /spectrumValueToAmplitude/)
  assert.doesNotMatch(panel, /spectrumValueToAmplitude/)
})

test('audio visualizer display mapping uses deterministic low-frequency shelf contour', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /const SPECTRUM_BAR_COUNT = 140/)
  assert.match(visualizer, /const SPECTRUM_DISPLAY_GAIN = 1\.32\b/)
  assert.match(visualizer, /const SPECTRUM_DISPLAY_RANGE = 1\.42/)
  assert.match(visualizer, /const SPECTRUM_DISPLAY_GAMMA = 0\.78/)
  assert.match(visualizer, /const SPECTRUM_DISPLAY_HEADROOM = 1/)
  assert.match(visualizer, /const SPECTRUM_CONTRAST_FLOOR = 0\.16/)
  assert.match(visualizer, /const SPECTRUM_CONTRAST_POWER = 0\.68/)
  assert.match(visualizer, /let lowFrequencyContourPhase = 0/)
  assert.match(visualizer, /function updateLowFrequencyContourPhase\(rawBars, deltaSeconds\)/)
  assert.match(visualizer, /function visualizerDisplayLevel\(value\)/)
  assert.match(visualizer, /Math\.min\(SPECTRUM_DISPLAY_RANGE/)
  assert.match(visualizer, /const normalized = ranged \/ SPECTRUM_DISPLAY_RANGE/)
  assert.match(
    visualizer,
    /return Math\.pow\(level, SPECTRUM_DISPLAY_GAMMA\) \* SPECTRUM_DISPLAY_HEADROOM/
  )
  assert.match(visualizer, /function buildLogFrequencyBinCenters\(barCount, sampleRate, fftSize\)/)
  assert.match(
    visualizer,
    /function applyLowFrequencyShelfContour\(rawBars, binCenters, contourPhase\)/
  )
  assert.match(visualizer, /LOW_FREQUENCY_CONTOUR_BASE_DEPTH/)
  assert.match(visualizer, /LOW_FREQUENCY_CONTOUR_FLAT_RANGE/)
  assert.match(
    visualizer,
    /const tertiary = Math\.sin\(\(barIndex \+ 1\) \* 2\.37 \+ phase \* 0\.9\)/
  )
  assert.match(
    visualizer,
    /sourceLevels = applyLowFrequencyShelfContour\(rawComputedBars, binCenters, contourPhase\)/
  )
  assert.match(
    visualizer,
    /sourceLevels = applyLowFrequencyShelfContour\(rawPrecomputedBars, binCenters, contourPhase\)/
  )
  assert.match(visualizer, /lowFrequencyContourPhase: contourPhase/)
  assert.match(visualizer, /const val = visualizerDisplayLevel\(sourceLevels\[i\]\) \* 255/)
  assert.match(visualizer, /const targetHeight = \(val \/ 255\) \* height \* SPECTRUM_HEIGHT_SCALE/)
  assert.doesNotMatch(visualizer, /const targetHeight = \(val \/ 255\) \* \(height - 15\)/)
  assert.doesNotMatch(visualizer, /Math\.random/)
})

test('audio visualizer panel requests precomputed bars instead of posting full spectrum payloads', () => {
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')

  assert.match(panel, /const VISUALIZER_BAR_COUNT = 140/)
  assert.match(panel, /const VISUALIZER_ANALYSIS_POINTS = 4096/)
  assert.match(panel, /visualizerBarCount: VISUALIZER_BAR_COUNT/)
  assert.match(panel, /v\.visualizerBars/)
  assert.match(panel, /bars,/)
  assert.doesNotMatch(panel, /Float32Array\.from\(v\.spectrum\)/)
  assert.doesNotMatch(panel, /data: spectrum/)
})

test('audio visualizer hides synthetic fallback frames instead of presenting them as real FFT data', () => {
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')

  assert.match(
    panel,
    /if \(v\.tapStatus === 'synthetic-fallback'\) \{[\s\S]*postInactiveVisualizationFrame\(\)[\s\S]*return/
  )
  assert.doesNotMatch(
    panel,
    /if \(v\.tapStatus !== 'synthetic-fallback'\) \{[\s\S]*tempoEstimator\.pushFrame/
  )
  assert.match(panel, /const bars = Float32Array\.from\(v\.visualizerBars \?\? \[\]\)/)
  assert.match(panel, /kind: 'spectrum',[\s\S]*bars,[\s\S]*active: v\.active/)
})

test('audio visualizer panel self-schedules sampling without timer backlog', () => {
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')

  assert.match(panel, /const VISUALIZER_ANALYSIS_POINTS = 4096/)
  assert.match(panel, /spectrumPoints: VISUALIZER_ANALYSIS_POINTS/)
  assert.match(panel, /const VISUALIZER_POLL_INTERVAL_MS = 50/)
  assert.match(panel, /function scheduleVisualizationFrame\(delayMs = 0\)/)
  assert.match(panel, /visualizationTimer = window\.setTimeout\(async \(\) => \{/)
  assert.match(panel, /await pollVisualizationFrame\(\)/)
  assert.match(panel, /scheduleVisualizationFrame\(VISUALIZER_POLL_INTERVAL_MS\)/)
  assert.match(panel, /window\.clearTimeout\(visualizationTimer\)/)
  assert.doesNotMatch(panel, /window\.setInterval\(/)
  assert.match(panel, /visualizerBarCount: VISUALIZER_BAR_COUNT/)
  assert.doesNotMatch(panel, /data: spectrum/)
})

test('audio visualizer damps incoming samples without global spectrum pumping', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')

  assert.match(visualizer, /const PRECOMPUTED_BAR_TRANSITION_MS = 48/)
  assert.match(visualizer, /const SPECTRUM_ATTACK_SECONDS = 0\.014/)
  assert.match(visualizer, /const SPECTRUM_DECAY_SECONDS = 0\.16/)
  assert.doesNotMatch(visualizer, /SPECTRUM_GAIN_TARGET_MIX/)
  assert.doesNotMatch(visualizer, /smoothPeakSourceLevel/)
  assert.doesNotMatch(visualizer, /adaptiveDisplayGain/)
  assert.doesNotMatch(visualizer, /visualizerDisplayLevel\(sourceLevel\) \* loudnessScale \* 255/)
  assert.doesNotMatch(visualizer, /const targetLoudnessScale = spectrumLoudnessScale\(\)/)
  assert.match(panel, /const VISUALIZER_POLL_INTERVAL_MS = 50/)
})

test('audio visualizer fixed curve keeps headroom while strong peaks can touch the zero line', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /const SPECTRUM_DISPLAY_RANGE = 1\.42/)
  assert.match(visualizer, /const SPECTRUM_DISPLAY_GAIN = 1\.32\b/)
  assert.match(visualizer, /const level = Math\.min\(1, contrasted \* SPECTRUM_DISPLAY_GAIN\)/)
})

test('audio visualizer uses fixed per-bin mapping so peaks can touch zero without global pumping', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /const SPECTRUM_DISPLAY_RANGE = 1\.42/)
  assert.match(visualizer, /const SPECTRUM_DISPLAY_GAIN = 1\.32\b/)
  assert.doesNotMatch(visualizer, /function expandFrameContrast/)
  assert.doesNotMatch(visualizer, /function smoothAdaptiveDisplayGain/)
  assert.doesNotMatch(visualizer, /SPECTRUM_GAIN_TARGET_MIX/)
  assert.doesNotMatch(visualizer, /sourceFloorLevel/)
  assert.doesNotMatch(visualizer, /adaptiveDisplayGain/)
  assert.match(visualizer, /const val = visualizerDisplayLevel\(sourceLevels\[i\]\) \* 255/)
})

test('audio visualizer panel sends mixed metadata and live bpm updates', () => {
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(panel, /new AudioTempoEstimator/)
  assert.match(panel, /tempoEstimator\.pushFrame/)
  assert.match(panel, /referenceBpm: currentMetadataBpm/)
  assert.match(panel, /kind: 'bpm'/)
  assert.match(panel, /source: tempo\.source/)
  assert.match(panel, /function getPrimaryTrackBpm\(/)
  assert.match(panel, /track\?\.bpmAnalysis\?\.bpm/)
  assert.match(panel, /const primaryBpm = getPrimaryTrackBpm\(track\)/)
  assert.match(panel, /const metadataBpm = primaryBpm/)
  assert.match(panel, /bpm: formatVisualizerBpm\(primaryBpm\)/)
  assert.match(panel, /tempo\.source === 'analyzing' && currentMetadataBpm/)
  assert.match(panel, /tempo\.source === 'analyzing' && lastPostedTempo\.bpm/)
  assert.match(visualizer, /case 'bpm':/)
  assert.match(visualizer, /function updateBpmDisplay\(value, source/)
  assert.match(visualizer, /updateBpmDisplay\(msg\.bpm, msg\.source/)
})

test('audio visualizer shows the current album in the header source label', () => {
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(panel, /album: track\.album/)
  assert.match(visualizer, /id="display-album">From: --<\/span>/)
  assert.match(
    visualizer,
    /document\.getElementById\('display-album'\)\.innerText = `From: \$\{track\.album \|\| '--'\}`/
  )
  assert.doesNotMatch(visualizer, /<span class="source-text">From: 20<\/span>/)
})

test('audio visualizer re-grants durable covers and only reveals successfully loaded artwork', () => {
  const panel = readFileSync(new URL('./AudioVisualizerPanel.vue', import.meta.url), 'utf8')
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(
    panel,
    /const resolvedCover = useCover\([\s\S]*currentTrack\.value\?\.cover \?\? null[\s\S]*currentTrack\.value\?\.coverSource \?\? null[\s\S]*\)/
  )
  assert.match(visualizer, /let albumCoverRequestId = 0/)
  assert.match(visualizer, /function updateAlbumCover\(url\)/)
  assert.match(visualizer, /const requestId = \+\+albumCoverRequestId/)
  assert.match(visualizer, /const candidate = new Image\(\)/)
  assert.match(visualizer, /candidate\.onload = \(\) => \{[\s\S]*requestId !== albumCoverRequestId/)
  assert.match(visualizer, /currentImage\.replaceWith\(candidate\)/)
  assert.match(visualizer, /candidate\.style\.visibility = 'visible'/)
  assert.match(visualizer, /candidate\.onerror = \(\) => \{[\s\S]*removeAttribute\('src'\)/)
  assert.match(visualizer, /case 'cover': \{[\s\S]*updateAlbumCover\(msg\.url\)/)
  assert.match(visualizer, /id="album-cover-img" src="" alt=""/)
  assert.doesNotMatch(visualizer, /albumCoverImg\.style\.visibility = 'visible'/)
})

test('audio visualizer render loops are bounded and avoid per-frame bar allocations', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /let playheadAnimationFrame = 0/)
  assert.match(visualizer, /const PRECOMPUTED_BAR_TRANSITION_MS = 48/)
  assert.match(visualizer, /const SPECTRUM_ATTACK_SECONDS = 0\.014/)
  assert.match(visualizer, /const SPECTRUM_DECAY_SECONDS = 0\.16/)
  assert.match(visualizer, /function startPlayheadLoop\(\)/)
  assert.match(visualizer, /if \(playheadAnimationFrame !== 0\) return/)
  assert.match(visualizer, /playheadAnimationFrame = requestAnimationFrame\(updatePlayhead\)/)
  assert.match(visualizer, /function stopPlayheadLoop\(\)/)
  assert.match(visualizer, /cancelAnimationFrame\(playheadAnimationFrame\)/)
  assert.doesNotMatch(
    visualizer,
    /function renderSpectrumFrame\(now\) \{[\s\S]*let sourceLevels = new Float32Array/
  )
  assert.doesNotMatch(
    visualizer,
    /function renderSpectrumFrame\(now\) \{[\s\S]*const displayDebugBars = new Float32Array/
  )
})

test('audio visualizer left artwork scales up within viewport bounds', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /--left-panel-offset: clamp\(18px, 2\.4vw, 42px\)/)
  assert.match(visualizer, /--radar-size: min\(100%, calc\(100vh - 230px\)\)/)
  assert.match(visualizer, /--album-art-scale: 66%/)
  assert.match(visualizer, /padding-inline: clamp\(12px, 1\.6vw, 28px\) var\(--left-panel-offset\)/)
  assert.match(visualizer, /width: var\(--radar-size\)/)
  assert.match(visualizer, /max-width: 600px/)
  assert.match(visualizer, /width: var\(--album-art-scale\)/)
  assert.doesNotMatch(visualizer, /width: 59\.5%/)
})

test('audio visualizer keeps transport buttons contained on compact viewports', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )
  const compactLayoutStart = visualizer.indexOf('@media (max-width: 900px)')

  assert.notEqual(compactLayoutStart, -1)

  const compactLayout = visualizer.slice(compactLayoutStart)
  assert.match(compactLayout, /\.left-panel \{[\s\S]*transform: none;/)
  assert.match(
    compactLayout,
    /\.controls-container \{[\s\S]*margin-top: clamp\(20px, 4\.25vw, 38px\)/
  )
  assert.match(compactLayout, /\.controls-container \{[\s\S]*gap: clamp\(8px, 2vw, 18px\)/)
  assert.match(compactLayout, /\.btn-circle \{[\s\S]*flex: 0 0 clamp\(44px, 7\.1vw, 64px\)/)
  assert.match(
    compactLayout,
    /\.btn-circle\.play-pause \{[\s\S]*flex-basis: clamp\(52px, 8vw, 72px\)/
  )
})
test('audio visualizer metadata typography follows target hierarchy without recoloring', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.doesNotMatch(visualizer, /--info-ink/)
  assert.doesNotMatch(visualizer, /--info-muted/)
  assert.match(visualizer, /\.track-title \{[\s\S]*font-size: clamp\(38px, 3\.05vw, 48px\)/)
  assert.match(visualizer, /\.track-title \{[\s\S]*font-weight: 400/)
  assert.match(visualizer, /\.track-title \{[\s\S]*color: var\(--text-primary\)/)
  assert.match(visualizer, /\.track-title \{[\s\S]*height: 2\.1em/)
  assert.match(visualizer, /\.track-title \{[\s\S]*overflow: hidden/)
  assert.match(visualizer, /\.track-title \{[\s\S]*-webkit-line-clamp: 2/)
  assert.match(visualizer, /\.track-title\.single-line \{[\s\S]*align-items: center/)
  assert.match(visualizer, /\.track-title\.single-line \{[\s\S]*justify-content: flex-start/)
  assert.match(visualizer, /\.track-title\.single-line \{[\s\S]*text-align: left/)
  assert.match(visualizer, /\.track-title\.single-line \{[\s\S]*white-space: nowrap/)
  assert.match(visualizer, /function syncTitleLineClass\(\)/)
  assert.match(visualizer, /titleEl\.classList\.remove\('single-line'\)/)
  assert.match(visualizer, /titleEl\.classList\.toggle\('single-line', lineTops\.size <= 1\)/)
  assert.match(visualizer, /updateHzLabels\(\);?\s*syncTitleLineClass\(\);?/)
  assert.match(
    visualizer,
    /document\.getElementById\('display-title'\)\.innerText = track\.title \|\| '--';?\s*syncTitleLineClass\(\);?/
  )
  assert.match(visualizer, /\.track-artist \{[\s\S]*font-size: 18px/)
  assert.match(visualizer, /\.track-artist::before \{[\s\S]*content: 'By'/)
  assert.match(visualizer, /\.quality-container \{[\s\S]*padding-top: 52px/)
  assert.match(
    visualizer,
    /\.stats-grid-row \{[\s\S]*border-top: 1\.5px solid rgba\(0, 0, 0, 0\.18\)/
  )
  assert.match(visualizer, /\.stats-grid-row \{[\s\S]*padding: 16px 0 18px 0/)
  assert.doesNotMatch(visualizer, /\.stats-grid-row \{[^}]*border-bottom/)
  assert.match(visualizer, /\.stat-col:not\(:last-child\) \{[\s\S]*border-right/)
  assert.match(visualizer, /\.stat-value\.mono \{[\s\S]*font-size: 23px/)
})

test('audio visualizer spectrum area grows upward without moving the timeline down', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /\.spectrum-outer-container \{[\s\S]*--spectrum-top-growth: 24px/)
  assert.match(
    visualizer,
    /\.spectrum-outer-container \{[\s\S]*flex: 0 0 calc\(250px \+ var\(--spectrum-top-growth\)\)/
  )
  assert.match(
    visualizer,
    /\.spectrum-outer-container \{[\s\S]*height: calc\(250px \+ var\(--spectrum-top-growth\)\)/
  )
  assert.match(
    visualizer,
    /\.spectrum-outer-container \{[\s\S]*margin-bottom: calc\(20px - var\(--spectrum-top-growth\)\)/
  )
  assert.match(
    visualizer,
    /\.spectrum-outer-container \{[\s\S]*transform: translateY\(calc\(-1 \* var\(--spectrum-top-growth\)\)\)/
  )
})

test('audio visualizer uses the full vertical viewport in fullscreen mode', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /\.right-panel \{[^}]*min-height: 0/)
  assert.match(visualizer, /\.right-panel \{[^}]*height: 100%/)
  assert.match(visualizer, /\.bottom-metrics-row \{[^}]*margin-top: auto/)
  assert.doesNotMatch(visualizer, /\.bottom-metrics-row \{[^}]*margin-top: 10px/)
})

test('audio visualizer has slow cover and playback orbit layers', () => {
  const visualizer = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(visualizer, /class="album-orbit-system"/)
  assert.match(visualizer, /\.left-panel \{[\s\S]*z-index: 0/)
  assert.match(visualizer, /\.left-panel \{[\s\S]*transform: translateY\(28px\)/)
  assert.match(visualizer, /\.album-orbit-system \{[\s\S]*inset: -30%[\s\S]*z-index: 0/)
  assert.match(visualizer, /\.right-panel \{[\s\S]*z-index: 2/)
  assert.match(visualizer, /\.album-orbit-ring\.ring-2 \{[\s\S]*inset: 6%/)
  assert.match(visualizer, /\.album-orbit-ring\.ring-3 \{[\s\S]*inset: 13\.4%/)
  assert.match(visualizer, /\.album-orbit-ring\.ring-4 \{[\s\S]*inset: 20\.8%/)
  assert.match(visualizer, /\.album-orbit-ring\.ring-5 \{[\s\S]*inset: 28\.2%/)
  assert.match(visualizer, /\.album-orbit-ring\.ring-6 \{[\s\S]*inset: 35\.6%/)
  assert.doesNotMatch(visualizer, /class="album-orbit-ring dashed ring-1"/)
  assert.match(visualizer, /class="album-orbit-ring solid ring-2 time-ticks"/)
  assert.match(visualizer, /class="album-track-runner"/)
  assert.match(visualizer, /class="album-orbit-ring solid ring-4"/)
  assert.match(visualizer, /class="album-orbit-ring solid ring-6"/)
  assert.match(visualizer, /\.album-orbit-ring \{[\s\S]*border: 1px solid rgba\(0, 0, 0, 0\.22\)/)
  assert.match(visualizer, /\.album-orbit-ring\.time-ticks::before/)
  assert.match(visualizer, /repeating-conic-gradient/)
  assert.match(visualizer, /inset: 0/)
  assert.match(visualizer, /transparent 0\.28deg 30deg/)
  assert.match(visualizer, /#000 calc\(100% - 15px\) calc\(100% - 7px\)/)
  assert.match(visualizer, /animation: tick-ring-drift 52s linear infinite/)
  assert.match(visualizer, /body\.is-playing \.album-orbit-ring\.time-ticks::before/)
  assert.match(visualizer, /\.album-track-runner \{[\s\S]*inset: 6%/)
  assert.match(visualizer, /animation: outer-track-run 44s linear infinite/)
  assert.match(visualizer, /body\.is-playing \.album-track-runner/)
  assert.match(visualizer, /@keyframes tick-ring-drift/)
  assert.match(visualizer, /@keyframes outer-track-run/)
  assert.match(visualizer, /transform: rotate\(-360deg\)/)
  assert.doesNotMatch(visualizer, /\.album-track-runner::after/)
  assert.doesNotMatch(visualizer, /runner-core-counter/)
  assert.equal((visualizer.match(/class="album-orbit-ring solid ring-/g) ?? []).length, 3)
  assert.equal((visualizer.match(/class="album-orbit-ring dashed ring-/g) ?? []).length, 2)
  assert.match(visualizer, /class="album-cover-motion"/)
  assert.match(visualizer, /class="album-cover-badge"/)
  assert.match(visualizer, /\.album-cover-motion \{[\s\S]*inset: -58%/)
  assert.doesNotMatch(visualizer, /album-radar-ring/)
  assert.doesNotMatch(visualizer, /album-cover-arc/)
  assert.doesNotMatch(visualizer, /album-orbit-ring inner/)
  assert.doesNotMatch(visualizer, /album-orbit-ring middle/)
  assert.doesNotMatch(visualizer, /cx="250" cy="250" r="244"/)
  assert.doesNotMatch(visualizer, /cx="250" cy="250" r="226"/)
  assert.doesNotMatch(visualizer, /cx="250" cy="250" r="195"/)
  assert.doesNotMatch(visualizer, /cx="250" cy="250" r="135"/)
  assert.match(visualizer, /class="control-orbit-system"/)
  assert.match(visualizer, /class="control-orbit-node red/)
  assert.match(visualizer, /class="control-orbit-node gray/)
  assert.match(visualizer, /\.controls-container \{[\s\S]*margin-top: 58px/)
  assert.match(visualizer, /\.controls-container \{[\s\S]*gap: 52px/)
  assert.match(visualizer, /\.controls-container \{[\s\S]*max-width: 430px/)
  assert.match(visualizer, /\.control-orbit-system \{[\s\S]*width: 500px/)
  assert.match(visualizer, /\.control-orbit-track\.inner \{[\s\S]*width: 94px/)
  assert.match(
    visualizer,
    /\.control-orbit-track\.inner \{[\s\S]*border-color: rgba\(0, 0, 0, 0\.14\)/
  )
  assert.match(visualizer, /\.control-orbit-track\.outer \{[\s\S]*width: 142px/)
  assert.match(
    visualizer,
    /\.control-orbit-track\.outer \{[\s\S]*border-color: rgba\(0, 0, 0, 0\.16\)/
  )
  assert.doesNotMatch(visualizer, /\.control-orbit-track\.outer::before/)
  assert.doesNotMatch(visualizer, /control-ring-drift/)
  assert.doesNotMatch(visualizer, /\.control-orbit-track\.main/)
  assert.doesNotMatch(visualizer, /class="control-orbit-track main"/)
  assert.match(visualizer, /\.control-orbit-node\.gray::before \{[\s\S]*rgba\(72, 74, 78, 0\.68\)/)
  assert.match(
    visualizer,
    /\.control-orbit-node \{[\s\S]*animation: orbit-spin 22s linear infinite/
  )
  assert.match(visualizer, /\.control-orbit-node \{[\s\S]*animation-play-state: paused/)
  assert.match(
    visualizer,
    /body\.is-playing \.control-orbit-node \{[\s\S]*animation-play-state: running/
  )
  assert.doesNotMatch(visualizer, /class="control-orbit-node [^"]*slow/)
  assert.doesNotMatch(visualizer, /class="control-orbit-node [^"]*drift/)
  assert.match(visualizer, /--orbit-radius: 71px/)
  assert.doesNotMatch(visualizer, /--orbit-radius: 56px/)
  assert.doesNotMatch(visualizer, /--orbit-radius: 92px/)
  assert.equal((visualizer.match(/class="control-orbit-node red/g) ?? []).length, 3)
  assert.equal((visualizer.match(/class="control-orbit-node gray/g) ?? []).length, 3)
  assert.doesNotMatch(visualizer, /\.control-orbit-track\.prev/)
  assert.doesNotMatch(visualizer, /\.control-orbit-track\.next/)
  assert.doesNotMatch(visualizer, /class="control-orbit-track prev"/)
  assert.doesNotMatch(visualizer, /class="control-orbit-track next"/)
  assert.match(visualizer, /\.controls-ring \{[\s\S]*width: 480px/)
  assert.match(visualizer, /\.btn-circle \{[\s\S]*width: 74px/)
  assert.match(visualizer, /\.btn-circle\.play-pause \{[\s\S]*width: 84px/)
  assert.match(visualizer, /\.btn-circle\.play-pause svg \{[\s\S]*width: 32px/)
  assert.match(visualizer, /M11 5 3 12l8 7V5Zm10 0-8 7 8 7V5Z/)
  assert.match(visualizer, /m3 5 8 7-8 7V5Zm10 0 8 7-8 7V5Z/)
  assert.match(visualizer, /animation: orbit-spin 22s linear infinite/)
  assert.doesNotMatch(visualizer, /animation-duration: var\(--orbit-idle-duration/)
  assert.doesNotMatch(visualizer, /animation-duration: 60s/)
  assert.doesNotMatch(visualizer, /animation-duration: 75s/)
  assert.match(visualizer, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(visualizer, /offset-path/)
  assert.doesNotMatch(visualizer, /Math\.random/)
  assert.doesNotMatch(visualizer, /class="album-orbit-node red/)
  assert.doesNotMatch(visualizer, /class="album-edge-node red/)
  assert.doesNotMatch(visualizer, /class="album-orbit-node neutral/)
  assert.doesNotMatch(visualizer, /class="album-orbit-tick"/)
  assert.doesNotMatch(visualizer, /class="album-edge-node neutral/)
  assert.doesNotMatch(visualizer, /class="album-edge-tick"/)
  assert.doesNotMatch(visualizer, /class="control-orbit-node neutral/)
  assert.doesNotMatch(visualizer, /drawRadarTicks/)
})
