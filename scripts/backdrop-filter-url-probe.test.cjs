/**
 * One-shot capability probe: does this Chromium honour an SVG filter reference in
 * `backdrop-filter`, and if so does `feDisplacementMap` work on backdrop input?
 *
 * This decides an architecture, not a detail. The liquid glass surfaces currently
 * carry `backdrop-filter: blur(...)` and `filter: url(#te-lg-*)` on the same
 * element. `filter` only ever sees the element's own painted output — a few
 * translucent gradients — so the refraction is mathematically real and visually
 * nil. If `backdrop-filter: url(...)` is honoured, the compositor hands the real
 * backdrop to the existing chain and the effect works with a near one-line change.
 *
 * `@supports` cannot answer this: Chromium may parse the value and silently
 * ignore it. So the probe is pixel-level, over a high-frequency checkerboard
 * (a smooth gradient cannot reveal a displacement).
 *
 * Every probed element sits over an identical checkerboard phase — offsets are
 * whole multiples of the tile — so a region diff against the unfiltered control
 * is meaningful without any pattern alignment work.
 *
 * A `blur()` region is probed alongside as an environment sanity check. Offscreen
 * compositing could disable backdrop-filter wholesale, which would make a
 * negative `url()` result a false negative rather than an answer.
 */

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const electronEnvironment = { ...process.env }
delete electronEnvironment.ELECTRON_RUN_AS_NODE

/** Checkerboard tile in px. The pattern repeats every `TILE * 2`. */
const TILE = 8

/** Probe region size, playbar-like: a wide strip with a generous rim. */
const REGION = { width: 240, height: 72 }

/**
 * Top-left of each probe region. Every offset from `control` is a whole multiple
 * of the pattern period (`TILE * 2`), so each region sees a byte-identical
 * backdrop and a region diff needs no pattern alignment.
 *
 * Row one answers "is `url()` honoured on its own". Row two answers the question
 * that actually decides the bug: the shipped rule is not a bare `url()`, it is
 * `blur() saturate() url()`. A declaration Chromium cannot parse as a whole is
 * dropped entirely, which would take the blur down with it — and the app
 * screenshot does show unblurred text through the bar.
 */
const REGION_ORIGIN = {
  control: { x: 104, y: 320 },
  blur: { x: 424, y: 320 },
  invert: { x: 744, y: 320 },
  displace: { x: 1064, y: 320 },
  control2: { x: 104, y: 480 },
  mixedInvert: { x: 424, y: 480 },
  mixedBlurSat: { x: 744, y: 480 },
  mixedDisplace: { x: 1064, y: 480 },
  // Row three: the shapes the app actually ships. See ROW THREE below.
  control3: { x: 104, y: 640 },
  lensChain: { x: 424, y: 640 },
  maskedChain: { x: 744, y: 640 },
  // The shipped *order*: the playbar runs the lens before blur/saturate so the
  // chain is handed the sharp backdrop. See LENS FIRST below.
  lensFirst: { x: 1064, y: 640 }
}

/** Matches the shipped playbar declaration's leading functions. */
const MIXED_PREFIX = 'blur(6px) saturate(140%)'

function probePageSource() {
  const region = (id, value) => {
    const { x, y } = REGION_ORIGIN[id]
    const filter = value ? `backdrop-filter:${value};-webkit-backdrop-filter:${value};` : ''
    return `<div class="probe" id="${id}" style="left:${x}px;top:${y}px;${filter}"></div>`
  }

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
  /* High-frequency 2D pattern: displacement of a smooth ramp is invisible. */
  body {
    background-color: #ff0000;
    background-image:
      repeating-conic-gradient(#ff0000 0% 25%, #0000ff 0% 50%);
    background-size: ${TILE * 2}px ${TILE * 2}px;
  }
  .probe {
    position: absolute;
    width: ${REGION.width}px;
    height: ${REGION.height}px;
    /* No own background: an opaque fill would hide the backdrop entirely. */
    background: transparent;
  }
</style></head>
<body>
  <svg width="0" height="0" aria-hidden="true"><defs>
    <!-- A-level: an effect that cannot be mistaken for anything else. -->
    <filter id="te-probe-invert" x="-20%" y="-20%" width="140%" height="140%"
            color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="
        -1 0 0 0 1
        0 -1 0 0 1
        0 0 -1 0 1
        0 0 0 1 0" />
    </filter>
    <!-- B-level: does feDisplacementMap act on backdrop input at all? Turbulence
         stands in for the baked rim map; the question is the primitive, not the
         map's shape. -->
    <filter id="te-probe-displace" x="-20%" y="-20%" width="140%" height="140%"
            color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2"
                    seed="7" result="NOISE" />
      <feDisplacementMap in="SourceGraphic" in2="NOISE" scale="30"
                         xChannelSelector="R" yChannelSelector="B" />
    </filter>

    <!-- ROW THREE: the shapes the app actually ships.

         The turbulence chains above answer whether the *primitive* works, but
         they miss how the real chains are built: an 'feImage' carrying a
         runtime-baked data URL, three displaced channels, then a tail that
         masks the result. This row exists because an earlier version of this
         probe passed every check while the app rendered no glass at all —
         'feTurbulence' never exercised the masking tail.

         'lensChain' is the shipped shape: displace, recombine, done.
         'maskedChain' is the shape that shipped broken — identical except it
         ends by masking the refraction against an feImage-derived alpha. On the
         backdrop path that composite resolves to nothing, and Chromium responds
         by discarding the entire backdrop-filter and painting the raw backdrop.
         Blur and all. -->
    <filter id="te-probe-lens" x="-35%" y="-35%" width="170%" height="170%"
            color-interpolation-filters="sRGB">
      <feImage class="te-probe-map" x="0" y="0" width="100%" height="100%"
               result="MAP" preserveAspectRatio="none" />
      <feDisplacementMap in="SourceGraphic" in2="MAP" scale="44"
                         xChannelSelector="R" yChannelSelector="B" result="RD" />
      <feColorMatrix in="RD" type="matrix"
                     values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="RC" />
      <feDisplacementMap in="SourceGraphic" in2="MAP" scale="40"
                         xChannelSelector="R" yChannelSelector="B" result="GD" />
      <feColorMatrix in="GD" type="matrix"
                     values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="GC" />
      <feDisplacementMap in="SourceGraphic" in2="MAP" scale="36"
                         xChannelSelector="R" yChannelSelector="B" result="BD" />
      <feColorMatrix in="BD" type="matrix"
                     values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="BC" />
      <feBlend in="GC" in2="BC" mode="screen" result="GB" />
      <feBlend in="RC" in2="GB" mode="screen" />
    </filter>

    <filter id="te-probe-masked" x="-35%" y="-35%" width="170%" height="170%"
            color-interpolation-filters="sRGB">
      <feImage class="te-probe-map" x="0" y="0" width="100%" height="100%"
               result="MAP" preserveAspectRatio="none" />
      <feColorMatrix in="MAP" type="matrix"
                     values="0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0 0 0 1 0"
                     result="EI" />
      <feComponentTransfer in="EI" result="EDGE_MASK">
        <feFuncA type="table" tableValues="0 0.19 1" />
      </feComponentTransfer>
      <feDisplacementMap in="SourceGraphic" in2="MAP" scale="44"
                         xChannelSelector="R" yChannelSelector="B" result="D" />
      <!-- The line that silently disabled every glass surface. -->
      <feComposite in="D" in2="EDGE_MASK" operator="in" />
    </filter>
  </defs></svg>

  <!-- Row one: each function alone. -->
  ${region('control', '')}
  ${region('blur', 'blur(6px)')}
  ${region('invert', 'url(#te-probe-invert)')}
  ${region('displace', 'url(#te-probe-displace)')}

  <!-- Row two: the shipped shape — a mixed list. mixedBlurSat is the tell: it
       carries the same prefix with no url(), so if mixedInvert shows nothing
       while mixedBlurSat blurs, the mixed list is being dropped wholesale. -->
  ${region('control2', '')}
  ${region('mixedInvert', `${MIXED_PREFIX} url(#te-probe-invert)`)}
  ${region('mixedBlurSat', MIXED_PREFIX)}
  ${region('mixedDisplace', `${MIXED_PREFIX} url(#te-probe-displace)`)}

  <!-- Row three: the real chain shapes, against a runtime-baked feImage map.
       'lensFirst' carries the same chain with the function order the playbar
       ships: a mixed list whose url() comes *before* blur/saturate. A list
       Chromium refuses in that order is dropped whole, taking the blur with it. -->
  ${region('control3', '')}
  ${region('lensChain', `${MIXED_PREFIX} url(#te-probe-lens)`)}
  ${region('maskedChain', `${MIXED_PREFIX} url(#te-probe-masked)`)}
  ${region('lensFirst', `url(#te-probe-lens) ${MIXED_PREFIX}`)}

  <script>
    /* A trimmed copy of buildDisplacementPixels. Kept in sync only in shape: the
       question here is how Chromium treats a chain fed by an feImage data URL,
       not whether the lens profile is numerically exact. */
    function roundedRectSDF(x, y, hw, hh, r) {
      const qx = Math.abs(x) - hw + r
      const qy = Math.abs(y) - hh + r
      return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
    }
    function sdfNormal(x, y, hw, hh, r) {
      const qx = Math.abs(x) - hw + r
      const qy = Math.abs(y) - hh + r
      const sx = x < 0 ? -1 : 1
      const sy = y < 0 ? -1 : 1
      if (qx > 0 && qy > 0) {
        const l = Math.hypot(qx, qy)
        return { x: (sx * qx) / l, y: (sy * qy) / l }
      }
      if (qx > qy) return { x: sx, y: 0 }
      return { x: 0, y: sy }
    }
    function liquidRel(t) {
      const n = Math.pow(Math.min(1, Math.max(0, 1 - t)), 1.75)
      return 1 - Math.pow(1 - Math.pow(1 - n, 1.25), 2)
    }
    function buildMap(w, h, r) {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      const img = ctx.createImageData(w, h)
      const d = img.data
      const hw = w / 2
      const hh = h / 2
      for (let y = 0; y < h; y++) {
        const py = y + 0.5 - hh
        for (let x = 0; x < w; x++) {
          const px = x + 0.5 - hw
          const sd = roundedRectSDF(px, py, hw, hh, r)
          let ox = 0
          let oy = 0
          let mag = 0
          if (sd <= 0 && r > 0) {
            const dist = Math.min(r, Math.max(0, r + sd))
            const rel = liquidRel(Math.min(1, -sd / r))
            mag = (dist / r) * (1 - rel)
            const n = sdfNormal(px, py, hw, hh, r)
            ox = -n.x * mag
            oy = -n.y * mag
          }
          const p = (y * w + x) * 4
          d[p] = (ox * 0.5 + 0.5) * 255
          d[p + 1] = (oy * 0.5 + 0.5) * 255
          d[p + 2] = (oy * 0.5 + 0.5) * 255
          d[p + 3] = mag * 255
        }
      }
      ctx.putImageData(img, 0, 0)
      return canvas.toDataURL()
    }

    const mapUrl = buildMap(${REGION.width}, ${REGION.height}, 22)
    for (const node of document.querySelectorAll('feImage.te-probe-map')) {
      node.setAttribute('href', mapUrl)
      node.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', mapUrl)
    }
    // The harness waits on this: an feImage still decoding would read as a
    // chain that does nothing, which is the exact failure being tested for.
    const decoder = new Image()
    decoder.onload = () => { window.__teProbeReady = true }
    decoder.onerror = () => { window.__teProbeReady = 'decode-failed' }
    decoder.src = mapUrl
  </script>
</body>
</html>`
}

function runnerSource() {
  const geometry = JSON.stringify({ REGION, REGION_ORIGIN })

  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
const geometry = ${geometry}
const userDataDir = process.env.TWILIGHT_ELECTRON_USER_DATA_DIR || ''
if (userDataDir) {
  app.setPath('userData', userDataDir)
  app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataDir, 'cache'))
}

/** Mean BGRA of a region, plus the max per-pixel delta against a reference. */
function regionStats(bitmap, imageWidth, scale, id) {
  const origin = geometry.REGION_ORIGIN[id]
  const x0 = Math.round(origin.x * scale)
  const y0 = Math.round(origin.y * scale)
  const w = Math.round(geometry.REGION.width * scale)
  const h = Math.round(geometry.REGION.height * scale)
  const pixels = []
  let sumR = 0
  let sumG = 0
  let sumB = 0
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = (y * imageWidth + x) * 4
      // NativeImage.toBitmap() is BGRA.
      const b = bitmap[p]
      const g = bitmap[p + 1]
      const r = bitmap[p + 2]
      pixels.push(r, g, b)
      sumR += r
      sumG += g
      sumB += b
    }
  }
  const count = w * h
  const mean = [sumR / count, sumG / count, sumB / count]
  // Mean absolute deviation from the region's own mean. This is the metric that
  // catches a *dropped* declaration, which a diff against an unfiltered control
  // cannot: a chain that resolves to nothing makes Chromium paint the raw
  // backdrop, so the region is byte-identical to no-filter-at-all. On the
  // checkerboard the raw pattern reads ~14-18 while any real blur reads ~1.
  let deviation = 0
  for (let i = 0; i < pixels.length; i += 3) {
    deviation +=
      (Math.abs(pixels[i] - mean[0]) +
        Math.abs(pixels[i + 1] - mean[1]) +
        Math.abs(pixels[i + 2] - mean[2])) /
      3
  }
  return { pixels, mean, count, contrast: deviation / count }
}

function compare(reference, candidate) {
  let maxDelta = 0
  let differing = 0
  for (let i = 0; i < reference.pixels.length; i += 3) {
    const d = Math.max(
      Math.abs(reference.pixels[i] - candidate.pixels[i]),
      Math.abs(reference.pixels[i + 1] - candidate.pixels[i + 1]),
      Math.abs(reference.pixels[i + 2] - candidate.pixels[i + 2])
    )
    if (d > maxDelta) maxDelta = d
    if (d > 8) differing++
  }
  return {
    maxDelta,
    differingRatio: differing / (reference.pixels.length / 3),
    meanDelta: [
      Math.abs(reference.mean[0] - candidate.mean[0]),
      Math.abs(reference.mean[1] - candidate.mean[1]),
      Math.abs(reference.mean[2] - candidate.mean[2])
    ]
  }
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  })
  window.webContents.on('console-message', (_event, _level, message) =>
    console.error('RENDERER', message)
  )
  try {
    await window.loadFile(path.resolve(target))
    // The row-three maps are baked in-page on a canvas; wait for the decode
    // before screenshotting or the feImage chains sample nothing.
    let mapReady = 'pending'
    for (let attempt = 0; attempt < 40; attempt++) {
      mapReady = await window.webContents.executeJavaScript('String(window.__teProbeReady)')
      if (mapReady === 'true') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Give the compositor time to settle; backdrop-filter is a compositor effect.
    await new Promise((resolve) => setTimeout(resolve, 900))
    // The computed value is the parse verdict: a list Chromium cannot parse is
    // dropped, and the property reads back 'none'. That alone distinguishes
    // "mixed list rejected" from "mixed list accepted but ineffective".
    const parsed = await window.webContents.executeJavaScript(
      \`JSON.stringify(Object.fromEntries(
        ${JSON.stringify(Object.keys(REGION_ORIGIN))}.map((id) => [
          id,
          getComputedStyle(document.getElementById(id)).backdropFilter
        ]).concat([
          ['supportsUrl', String(CSS.supports('backdrop-filter', 'url(#te-probe-invert)'))],
          ['supportsMixed', String(CSS.supports('backdrop-filter', '${MIXED_PREFIX} url(#te-probe-invert)'))]
        ])
      ))\`
    )
    const image = await window.webContents.capturePage()
    const size = image.getSize()
    const bitmap = image.toBitmap()
    const scale = size.width / 1440

    const stats = {}
    for (const id of Object.keys(geometry.REGION_ORIGIN)) {
      stats[id] = regionStats(bitmap, size.width, scale, id)
    }

    console.log(
      'PROBE_RESULT ' +
        JSON.stringify({
          scale,
          imageSize: size,
          parsed: JSON.parse(parsed),
          controlMean: stats.control.mean,
          blur: compare(stats.control, stats.blur),
          invert: compare(stats.control, stats.invert),
          displace: compare(stats.control, stats.displace),
          // Row two shares its own control so a stray background phase
          // difference between rows cannot masquerade as a filter effect.
          mixedInvert: compare(stats.control2, stats.mixedInvert),
          mixedBlurSat: compare(stats.control2, stats.mixedBlurSat),
          mixedDisplace: compare(stats.control2, stats.mixedDisplace),
          rowControlDelta: compare(stats.control, stats.control2),
          // Row three: contrast, not difference, is the metric. A dropped
          // declaration paints the raw backdrop, so its contrast matches the
          // unfiltered control exactly; a chain that merely looks different
          // still shows the blur's flattened contrast.
          contrast: Object.fromEntries(
            ['control3', 'lensChain', 'maskedChain', 'lensFirst'].map((id) => [id, stats[id].contrast])
          ),
          lensChain: compare(stats.control3, stats.lensChain),
          maskedChain: compare(stats.control3, stats.maskedChain),
          lensFirst: compare(stats.control3, stats.lensFirst),
          mapReady
        })
    )
    app.exit(0)
  } catch (error) {
    console.error('PROBE_ERROR', error && (error.stack || error.message || String(error)))
    app.exit(1)
  }
})
`
}

test('backdrop-filter url() capability probe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-backdrop-probe-'))
  try {
    const htmlPath = join(root, 'probe.html')
    const runnerPath = join(root, 'runner.cjs')
    await writeFile(htmlPath, probePageSource(), 'utf8')
    await writeFile(runnerPath, runnerSource(), 'utf8')

    const electronPath = require('electron')
    const { stdout, stderr } = await execFileAsync(
      electronPath,
      ['--no-sandbox', runnerPath, htmlPath],
      {
        env: { ...electronEnvironment, TWILIGHT_ELECTRON_USER_DATA_DIR: join(root, 'user-data') },
        timeout: 90_000,
        maxBuffer: 32 * 1024 * 1024
      }
    )

    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('PROBE_RESULT '))
    assert.ok(line, `probe produced no result.\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    const result = JSON.parse(line.slice('PROBE_RESULT '.length))

    // A backdrop effect that is known to work must register, otherwise a negative
    // url() result says nothing about Chromium and everything about this harness.
    const blurWorks = result.blur.differingRatio > 0.02
    t.diagnostic(`computed backdrop-filter values: ${JSON.stringify(result.parsed)}`)
    t.diagnostic(`blur (sanity):   ${JSON.stringify(result.blur)}`)
    t.diagnostic(`url(#invert):    ${JSON.stringify(result.invert)}`)
    t.diagnostic(`url(#displace):  ${JSON.stringify(result.displace)}`)
    assert.ok(
      blurWorks,
      `backdrop-filter: blur() had no pixel effect, so this harness cannot answer the url() question: ${JSON.stringify(result.blur)}`
    )

    t.diagnostic(`mixed blur+sat:  ${JSON.stringify(result.mixedBlurSat)}`)
    t.diagnostic(`mixed +invert:   ${JSON.stringify(result.mixedInvert)}`)
    t.diagnostic(`mixed +displace: ${JSON.stringify(result.mixedDisplace)}`)

    const urlHonoured = result.invert.differingRatio > 0.02
    const displacementHonoured = result.displace.differingRatio > 0.02
    // The shipped rule is a mixed list. If Chromium cannot parse the whole value
    // it drops the declaration, taking the blur with it — which is what the app
    // screenshot looks like.
    const mixedBlurWorks = result.mixedBlurSat.differingRatio > 0.02
    const mixedInvertWorks = result.mixedInvert.differingRatio > 0.02
    const mixedSurvives = result.mixedDisplace.differingRatio > 0.02

    /* ROW THREE — the shapes the app actually ships.

       Contrast is the metric here, not difference from a control. When a chain
       resolves to nothing, Chromium discards the whole backdrop-filter and
       paints the raw backdrop, so the region comes back byte-identical to the
       unfiltered control: every difference-based check reads "no effect" and
       cannot tell that apart from "effect applied but subtle". Contrast can:
       the raw checkerboard reads an order of magnitude above any real blur. */
    const rawContrast = result.contrast.control3
    const lensContrast = result.contrast.lensChain
    const maskedContrast = result.contrast.maskedChain
    const lensFirstContrast = result.contrast.lensFirst
    // Halfway between "blurred" (~1) and "raw pattern" (~14-18) on a log scale.
    const droppedThreshold = rawContrast * 0.5

    t.diagnostic(`map decode:      ${result.mapReady}`)
    t.diagnostic(`contrast raw:    ${rawContrast.toFixed(2)} (no filter)`)
    t.diagnostic(`contrast lens:   ${lensContrast.toFixed(2)} (shipped chain)`)
    t.diagnostic(`contrast masked: ${maskedContrast.toFixed(2)} (feComposite vs feImage alpha)`)
    t.diagnostic(`contrast first:  ${lensFirstContrast.toFixed(2)} (url() ahead of blur)`)

    const lensApplies = lensContrast < droppedThreshold
    const maskedIsDropped = maskedContrast >= droppedThreshold
    const lensFirstApplies = lensFirstContrast < droppedThreshold

    console.log(
      [
        '',
        '=== backdrop-filter url() probe ===',
        `environment sanity (blur):       ${blurWorks ? 'OK' : 'FAILED'}`,
        `A. bare url() honoured:          ${urlHonoured ? 'YES' : 'NO'}`,
        `B. bare feDisplacementMap:       ${urlHonoured ? (displacementHonoured ? 'YES' : 'NO') : 'n/a (A failed)'}`,
        `C. mixed blur()+saturate():      ${mixedBlurWorks ? 'OK' : 'FAILED'}`,
        `D. mixed list + url(#invert):    ${mixedInvertWorks ? 'YES' : 'NO — declaration dropped'}`,
        `E. mixed list + url(#displace):  ${mixedSurvives ? 'YES' : 'NO'}`,
        `CSS.supports (bare url):         ${result.parsed.supportsUrl}`,
        `CSS.supports (mixed list):       ${result.parsed.supportsMixed}`,
        `computed mixed value kept:       ${result.parsed.mixedDisplace}`,
        '',
        '--- real chain shapes (feImage + baked map) ---',
        `F. shipped lens chain applies:   ${lensApplies ? 'YES' : 'NO — CHAIN IS A NO-OP'}`,
        `G. feImage-masked chain dropped: ${maskedIsDropped ? 'YES (as expected)' : 'no longer reproduces'}`,
        `H. url() ahead of blur applies:  ${lensFirstApplies ? 'YES' : 'NO — ORDER IS REJECTED'}`,
        '',
        mixedInvertWorks
          ? '=> mixed list survives; the playbar rule is structurally fine.'
          : '=> mixed list is DROPPED. Split into a nested layer: blur/saturate on one element, url() on a child.',
        ''
      ].join('\n')
    )

    assert.equal(
      result.mapReady,
      'true',
      'the baked displacement map never decoded, so the feImage chains prove nothing'
    )

    // The regression this probe exists to catch. If the shipped chain shape ever
    // stops applying, every glass surface silently loses blur *and* refraction —
    // which is exactly what shipped, and what no unit test could see.
    assert.ok(
      lensApplies,
      `the shipped lens chain is a no-op on the backdrop path: contrast ${lensContrast.toFixed(2)} ` +
        `is indistinguishable from the unfiltered backdrop (${rawContrast.toFixed(2)}). ` +
        'Chromium discards the entire backdrop-filter when a primitive resolves to an empty result.'
    )

    // Pins the root cause so the finding cannot quietly rot. If Chromium ever
    // starts honouring this shape, the masking tail becomes a legitimate option
    // again and this assertion is the signal to revisit that decision.
    assert.ok(
      maskedIsDropped,
      'masking refraction against an feImage-derived alpha no longer breaks the chain. ' +
        'Chromium behaviour changed; the constraint documented in LiquidGlassDefs.vue can be relaxed.'
    )

    /* LENS FIRST — the order the playbar ships.
       Behind `blur()` the chain is handed an already-smoothed backdrop, and
       displacing a smooth field resamples to the colour it started from, so the
       refraction is invisible however large the amplitude. The playbar therefore
       runs `url() blur() saturate()`. If Chromium ever rejects a list in that
       order it drops the declaration whole and the surface loses its blur too. */
    assert.ok(
      lensFirstApplies,
      `url() ahead of blur() is not honoured: contrast ${lensFirstContrast.toFixed(2)} matches the ` +
        `unfiltered backdrop (${rawContrast.toFixed(2)}), so the whole declaration was dropped. ` +
        'Move the playbar back to a blur-first list and refract in a nested layer instead.'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
