import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('./EqualizerPage.vue', import.meta.url), 'utf8')
const chart = readFileSync(
  new URL('./equalizer/FrequencyResponseChart.vue', import.meta.url),
  'utf8'
)
const opra = readFileSync(new URL('./equalizer/OpraEqPanel.vue', import.meta.url), 'utf8')
const graphic = readFileSync(new URL('./equalizer/GraphicEqPanel.vue', import.meta.url), 'utf8')
const toolbar = readFileSync(
  new URL('./equalizer/FrequencyResponseToolbar.vue', import.meta.url),
  'utf8'
)
const equalizerUi = [page, chart, opra, graphic, toolbar].join('\n')

test('page orchestrates the extracted equalizer domain panels', () => {
  assert.match(page, /import ParametricEqWorkspace/)
  assert.match(page, /import OpraEqPanel/)
  assert.match(page, /import FrequencyResponseChart/)
  assert.match(page, /import FrequencyResponseToolbar/)
  assert.match(page, /import GraphicEqPanel/)
  assert.match(page, /<OpraEqPanel/)
  assert.match(page, /<FrequencyResponseChart/)
  assert.match(page, /<FrequencyResponseToolbar[\s\S]*card/)
  assert.match(page, /<GraphicEqPanel/)
})

test('graphic equalizer preamp and band sliders support 0.1 dB adjustments', () => {
  assert.match(
    graphic,
    /<input[\s\S]*?type="range"[\s\S]*?min="-24"[\s\S]*?max="24"[\s\S]*?step="0\.1"[\s\S]*?:value="props\.preamp"/
  )
  assert.match(
    graphic,
    /<input[\s\S]*?type="range"[\s\S]*?min="-12"[\s\S]*?max="12"[\s\S]*?step="0\.1"[\s\S]*?:value="band\.gain"/
  )
})

test('graphic sliders preview locally and commit once per gesture', () => {
  // Applying to the engine on every @input issued overlapping async round trips
  // (setAudioProcessing + setDspScenes). Out-of-order responses overwrote the
  // shared state, leaving the board on an earlier gain than the user dragged to
  // while the DSP scene kept the later one.
  assert.match(graphic, /@input="\s*emit\('preview-band', index, \{ gain:/)
  assert.match(graphic, /@input="emit\('preview-preamp',/)
  assert.equal(graphic.match(/@change="emit\('commit'\)"/g)?.length, 2)
  assert.doesNotMatch(graphic, /update-band|update-preamp/)

  assert.match(page, /@preview-band="stageBandPatch"/)
  assert.match(page, /@preview-preamp="stagePreamp"/)
  assert.match(page, /<GraphicEqPanel[\s\S]*?@commit="commitStagedBands"/)

  // The commit must snapshot bands before awaiting, or an in-flight response
  // overwrites this gesture's edit before the patch is built.
  assert.match(
    page,
    /const bands = cloneBands\(audioProcessing\.value\.eqBands\)\s*\n\s*\/\/ Serialize commits/
  )
  // Serialized so a slow earlier response cannot land after a faster later one.
  assert.match(page, /commitChain = commitChain\s*\n?\s*\.then\(/)
  // A settled rejection would make every later slider release fail.
  assert.match(page, /\.catch\(\(error\) => \{/)
})

test('staging a different band lands the queued patch instead of retargeting it', () => {
  assert.match(page, /if \(pendingBandIndex >= 0 && pendingBandIndex !== index\)/)
  assert.match(page, /function flushStagedEdit\(\): void/)
})

test('theme modes change only equalizer presentation and use stable chart classes', () => {
  assert.equal(chart.match(/class="equalizer-spectrum-line"/g)?.length, 1)
  assert.equal(chart.match(/class="equalizer-spectrum-area"/g)?.length, 1)
  assert.match(page, /ParametricEqWorkspace/)
  assert.match(equalizerUi, /data-te-equalizer-panel='tinted'/)
  assert.match(equalizerUi, /data-te-equalizer-slider='solid'/)
  assert.match(equalizerUi, /data-te-equalizer-knob='dot'/)
  assert.match(equalizerUi, /data-te-equalizer-spectrum='area'/)
  assert.match(equalizerUi, /data-te-equalizer-button='outline'/)
  assert.match(equalizerUi, /data-te-visible-equalizer-grid='false'/)
  assert.match(equalizerUi, /data-te-visible-equalizer-frequency-guides='false'/)
  assert.match(equalizerUi, /data-te-visible-equalizer-spectrum='false'/)
})

test('OPRA compensation is reflected in the plotted response curve', () => {
  assert.match(
    page,
    /const displayEqBands = computed\([\s\S]*?opraCompensationEnabled\.value[\s\S]*?headphoneCompensation\.value\.bands/
  )
  assert.match(page, /computeCompositeResponse\(\s*displayEqBands\.value,\s*displayEqPreamp\.value/)
  assert.match(page, /mode: displayEqMode\.value/)
})

test('DSP chart splits manual, OPRA, and effective total response curves', () => {
  assert.match(
    page,
    /const manualResponsePath = computed\([\s\S]*?computeCompositeResponse\(audioProcessing\.value\.eqBands, audioProcessing\.value\.eqPreamp/
  )
  assert.match(
    page,
    /const opraResponsePath = computed\([\s\S]*?computeCompositeResponse\([\s\S]*?headphoneCompensation\.value\.bands,[\s\S]*?headphoneCompensation\.value\.preampDb/
  )
  assert.match(chart, /class="equalizer-manual-response-line"/)
  assert.match(chart, /class="equalizer-opra-response-line"/)
  assert.equal(chart.match(/>总 DSP 合成<\/span>/g)?.length, 1)
  assert.match(page, /:response-path="responsePath"/)
  assert.match(page, /:meter-peak-db="visualizationData\.peakDb"/)
  assert.match(page, /:meter-rms-db="visualizationData\.rmsDb"/)
})

test('OPRA estimated source deviation is explicitly non-measured and excludes preamp', () => {
  assert.match(
    page,
    /computeEstimatedSourceDeviation\(headphoneCompensation\.value\.bands, responseOptions\.value\)/
  )
  assert.match(chart, /class="equalizer-estimated-deviation-line"/)
  assert.equal(chart.match(/相对隐含目标 0 dB · 非实测/g)?.length, 1)
  assert.match(chart, /排除前级增益，不代表实测频响/)
})

test('AutoEq CSV import switches to a distinct headphone response view with precise data semantics', () => {
  assert.match(page, /window\.api\.audioEngine\.importFrequencyResponse\(\)/)
  assert.match(page, /type ResponseView = 'dsp' \| 'headphone'/)
  assert.equal(toolbar.match(/>\s*DSP 响应\s*<\/button>/g)?.length, 2)
  assert.equal(toolbar.match(/>\s*耳机频响\s*<\/button>/g)?.length, 2)
  assert.match(toolbar, /AutoEq smoothed 列/)
  assert.match(toolbar, /AutoEq raw 列/)
  assert.doesNotMatch(equalizerUi, /原始测量/)
})

test('headphone comparison exposes source, target, individual, combined, and corrected curves', () => {
  assert.match(page, /computeFrequencyResponseComparison\(/)
  assert.match(
    page,
    /computeCompositeResponse\(displayEqBands\.value, 0,[\s\S]*?mode: displayEqMode\.value/
  )
  assert.match(chart, /源频响 M\(f\)/)
  assert.match(chart, /目标曲线 T\(f\)/)
  assert.match(chart, /单个滤波 Hn\(f\)/)
  assert.match(chart, /合并滤波 H\(f\)/)
  assert.match(chart, /滤波结果 R\(f\)/)
  assert.match(chart, /class="equalizer-measured-source-line"/)
  assert.match(chart, /class="equalizer-target-response-line"/)
  assert.match(chart, /class="equalizer-combined-filter-line"/)
  assert.match(chart, /class="equalizer-corrected-acoustic-line"/)
  assert.match(chart, /R\(f\) = M\(f\) \+ H\(f\) · 排除数字前级 · 预计值，非校正后实测/)
})

test('headphone curves have independent accessible visibility controls in both EQ workspaces', () => {
  for (const state of [
    'showMeasuredSource',
    'showTargetResponse',
    'showIndividualFilters',
    'showCombinedFilter',
    'showCorrectedResponse'
  ]) {
    assert.match(page, new RegExp(`const ${state} = ref\\(true\\)`))
    assert.match(chart, new RegExp(`:aria-pressed="props\\.${state}"`))
  }
  assert.match(page, /@toggle-headphone-curve="toggleHeadphoneCurve"/)
  assert.match(
    page,
    /:band-response-paths="\s*responseView === 'headphone' \? headphoneBandResponsePaths : bandResponsePaths\s*"/
  )
})

test('scene EQ keeps OPRA parameters but obeys DSP and equalizer bypass switches', () => {
  assert.match(page, /node\.enabled = nextSettings\.dspEnabled && nextSettings\.eqEnabled/)
  assert.doesNotMatch(
    page,
    /node\.enabled = nextSettings\.eqEnabled \|\| opraCompensationEnabled\.value/
  )
  assert.match(
    page,
    /bands: opraCompensationEnabled\.value\s*\? \[\.\.\.cloneBands\(headphoneCompensation\.value\.bands\), \.\.\.cloneBands\(nextSettings\.eqBands\)\]/
  )
})

test('applying or disabling OPRA re-syncs the DSP scene', () => {
  assert.equal(page.match(/await syncActiveSceneEq\(audioProcessing\.value\)/g)?.length, 2)
})

test('OPRA-stacked scene bands never overwrite the manual editor state', () => {
  assert.match(page, /if \(opraCompensationEnabled\.value\) return/)
})

test('parametric editor exposes direct manipulation and throttled DSP commits', () => {
  assert.match(page, /import ParametricEqWorkspace/)
  assert.match(page, /@add="addBand"/)
  assert.match(page, /@preview="stageBandPatch"/)
  assert.match(page, /@commit="commitStagedBands"/)
  assert.match(page, /@delete="deleteBand"/)
  assert.match(page, /@toggle="toggleBandEnabled"/)
  assert.match(page, /window\.requestAnimationFrame/)
  assert.match(page, /runEqApply/)
})

test('parametric page keeps one Chinese heading without duplicate English labels', () => {
  assert.match(page, /class="tab-pane active parametric-pane"/)
  assert.equal(page.match(/<header class="parametric-page-header">/g)?.length, 1)
  assert.match(page, /<h1>参数均衡器<\/h1>/)
  assert.match(page, />32 频段 · 实时处理</)
  assert.doesNotMatch(page, />DSP \/ EQUALIZATION</)
  assert.doesNotMatch(page, />32 BAND · REAL-TIME</)
  assert.doesNotMatch(page, /class="parametric-toolbar-label">ANALYZER SOURCE/)
  assert.match(page, /\.parametric-pane \{[\s\S]*?gap: 10px/)
  assert.match(toolbar, /\.parametric-toolbar-card \{[\s\S]*?border-radius: 8px/)
  assert.match(page, /@media \(max-width: 620px\)/)
  assert.match(toolbar, /@media \(max-width: 620px\)/)
  assert.match(page, /:global\(html\[data-theme='pureWhite'\] \.parametric-pane\)/)
  assert.match(toolbar, /:global\(html\[data-theme='pureWhite'\] \.parametric-toolbar-card\)/)
  assert.doesNotMatch(equalizerUi, /:global\(html:not\(\[data-theme='dark'\]\)\)/)
})

test('parametric editor reuses native player visualization data and cleans up animation work', () => {
  assert.match(page, /const \{ visualizationData, isPlaying \} = playerStore/)
  assert.match(page, /spectrumToPath\(smoothedSpectrum/)
  assert.match(page, /watch\(\[spectrumVisible, responseView, isPlaying\]/)
  assert.match(page, /onBeforeUnmount/)
  assert.match(page, /cancelAnimationFrame\(spectrumAnimationFrame\)/)
})

test('equalizer state writes go through the store action instead of detaching storeToRefs', () => {
  assert.match(page, /audioOutputDspStore\.applyAudioProcessingState\(/)
  // Reassigning the storeToRefs audioProcessing would detach it from the
  // player store and freeze the graph/sliders while audio still changes.
  assert.doesNotMatch(
    page,
    /audioProcessing\.value\s*=\s*(appSettings\.value\.audioProcessing|settings|{)/
  )
})
