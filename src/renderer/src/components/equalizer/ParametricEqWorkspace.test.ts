import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ParametricEqWorkspace.vue', import.meta.url), 'utf8')

test('frequency response graph supports adding, selecting, dragging, Q wheel edits, and deletion', () => {
  assert.match(source, /class="parametric-graph-surface"/)
  assert.match(source, /@click\.self="addBand"/)
  assert.match(source, /class="parametric-band-handle"/)
  assert.match(source, /setPointerCapture\(event\.pointerId\)/)
  assert.match(source, /@pointermove\.prevent\.stop="updatePointer"/)
  assert.match(source, /@wheel\.prevent\.stop="adjustQ\(index, \$event\)"/)
  assert.match(source, /emit\('delete', selectedIndex\)/)
  assert.match(source, /emit\('toggle', selectedIndex\)/)
})

test('workspace exposes filter, frequency, gain, and Q controls with gain-type semantics', () => {
  assert.match(source, /v-for="filter in filterTypes"/)
  assert.match(source, /updateNumeric\('frequency', \$event\)/)
  assert.match(source, /updateNumeric\('gain', \$event\)/)
  assert.match(source, /updateNumeric\('q', \$event\)/)
  assert.match(source, /:disabled="!filterUsesGain\(selectedBand\.filterType\)"/)
  assert.match(source, /displayBandGain\(band\)/)
})

test('workspace includes spectrum, hover tooltip, status feedback, responsiveness, and reduced motion', () => {
  assert.match(source, /class="live-spectrum-fill"/)
  assert.match(source, /class="live-spectrum-line"/)
  assert.match(source, /class="band-tooltip"/)
  assert.match(source, /class="stage-status"/)
  assert.match(source, /PARAMETRIC_EQ_MAX_BANDS/)
  assert.match(source, /@media \(max-width: 620px\)/)
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/)
})

test('headphone view renders five independently controlled response categories', () => {
  assert.match(source, /combinedFilterPath: string/)
  assert.match(source, /showMeasuredSource: boolean/)
  assert.match(source, /showTargetResponse: boolean/)
  assert.match(source, /showIndividualFilters: boolean/)
  assert.match(source, /showCombinedFilter: boolean/)
  assert.match(source, /showCorrectedResponse: boolean/)
  assert.match(source, /class="measured-source-line"/)
  assert.match(source, /class="target-response-line"/)
  assert.match(source, /class="individual-band-line headphone-filter"/)
  assert.match(source, /class="combined-filter-line"/)
  assert.match(source, /class="corrected-acoustic-line"/)
})

test('headphone curve controls expose pressed state and emit semantic toggle keys', () => {
  assert.match(source, /class="headphone-curve-controls"/)
  for (const key of ['source', 'target', 'individual', 'combined', 'corrected']) {
    assert.match(source, new RegExp(`emit\\('toggle-headphone-curve', '${key}'\\)`))
  }
  assert.match(source, /R\(f\) = M\(f\) \+ H\(f\)/)
  assert.match(source, /数字前级不计入声学预计/)
})

test('professional analyzer uses logarithmic grid, selected-band focus, and floating precision controls', () => {
  assert.match(source, /frequencyTicks/)
  assert.match(source, /frequencyToPercent\(frequency\)/)
  assert.match(source, /class="selected-band-fill"/)
  assert.match(source, /class="selected-band-focus"/)
  assert.match(source, /class="filter-strip"/)
  assert.match(source, /class="precision-controls"/)
  assert.match(source, /class="knob-face"/)
  assert.match(source, /frequencyKnobProgress/)
})

test('band handles support double-click reset and keyboard precision editing', () => {
  assert.match(source, /@dblclick\.prevent\.stop="resetBandGain\(index\)"/)
  assert.match(source, /@keydown="handleBandKeydown\(index, \$event\)"/)
  assert.match(source, /event\.key === 'ArrowRight'/)
  assert.match(source, /event\.shiftKey/)
  assert.match(source, /emit\('preview', index, \{ gain: 0 \}\)/)
})

test('analyzer keeps a flat signal palette with explicit light and dark instrument tones', () => {
  assert.match(source, /\.parametric-workspace \{[\s\S]*?--eq-surface:\s*#f5f4f0/)
  assert.match(source, /\.parametric-workspace \{[\s\S]*?--eq-text:\s*#1e2022/)
  assert.match(source, /\.parametric-workspace \{[\s\S]*?--eq-response:\s*#22252a/)
  assert.match(source, /\.parametric-workspace \{[\s\S]*?--eq-accent:\s*#e85010/)
  assert.match(
    source,
    /:global\(html\[data-theme='dark'\] \.parametric-workspace\) \{[\s\S]*?--eq-surface:\s*#181a1d/
  )
  assert.match(
    source,
    /:global\(html\[data-theme='dark'\] \.parametric-workspace\) \{[\s\S]*?--eq-response:\s*#eceee9/
  )
  assert.match(
    source,
    /:global\(html\[data-theme='dark'\] \.parametric-workspace\) \{[\s\S]*?--eq-accent:\s*#ff7a1f/
  )
  assert.match(source, /--eq-grid:\s*rgba\(30, 32, 34, 0\.06\)/)
  assert.match(source, /:global\(html\[data-theme='pureWhite'\] \.parametric-graph-surface\)/)
  assert.match(source, /:global\(html\[data-theme='pureWhite'\] \.knob-face\)/)
  assert.match(source, /:global\(html\[data-theme='pureWhite'\] \.output-meter\)/)
  assert.match(source, /:global\(html\[data-theme='pureWhite'\] \.analyzer-footer\)/)
  assert.match(source, /:global\(html\[data-theme='pureWhite'\] \.floating-band-inspector\)/)
  assert.doesNotMatch(source, /:global\(html:not\(\[data-theme='dark'\]\)\)/)

  assert.match(source, /stop-color="var\(--eq-spectrum\)"/)
  assert.match(source, /\.composite-response-line \{[\s\S]*?stroke: var\(--eq-response\)/)
  assert.match(source, /class="output-meter"/)
  assert.match(source, /class="analyzer-footer"/)
  assert.match(source, /class="meter-peak"/)
  assert.match(source, /class="meter-rms"/)
  assert.match(source, /\.floating-band-inspector \{[\s\S]*?background:\s*var\(--eq-surface-soft\)/)
})

test('flat design contract: no shadows or decorative gradients in the workspace styles', () => {
  const styles = Array.from(
    source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi),
    (match) => match[1]
  ).join('\n')
  assert.doesNotMatch(styles, /box-shadow/)
  assert.doesNotMatch(styles, /radial-gradient/)
  assert.doesNotMatch(styles, /linear-gradient/)
  assert.doesNotMatch(styles, /backdrop-filter/)
  assert.doesNotMatch(styles, /drop-shadow/)
})
