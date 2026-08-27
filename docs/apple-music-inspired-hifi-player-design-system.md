# Apple Music Inspired HiFi Player — Design System

> **Status:** Engineering-ready v1.0 · **Audience:** Product, Design, iOS/macOS/Web Engineering · **Scope:** Player experience for a high-end HiFi music player
>
> **Document intent:** Convert the _design principles behind_ Apple Music — not its pixel output — into explicit engineering constraints. Every rule in this document must be falsifiable by a developer without design support.

---

## 中文摘要（TL;DR）

这份规范的目标不是"复刻 Apple Music 的外观"，而是提炼 Apple 在产品中反复使用的五条底层原则，并转成工程可执行约束：

1. **内容即主角**：专辑封面、歌词、音频波形占据视觉焦点，UI 控制层退居次席，重 UI 不得压封面。
2. **音乐时间线驱动一切**：歌词滚动、逐字高亮、频谱动画都由音频时钟驱动，而不是由滚动事件或定时器驱动。
3. **材质是功能层，不是装饰**：Liquid Glass 只用于导航与浮空控件，禁止用在正文、封面与歌词背景上。
4. **动效必须"可响应、可打断、有意义"**：所有交互动效基于物理弹簧与即时响应；无意义动画一律禁止。
5. **克制是高级感的来源**：单一焦点、足够留白、低频色彩、绝不信息过载。

文档中每条规则标注信息来源：🟢 官方（Apple 文档/WWDC/新闻稿）、🟡 实测（Apple Music 产品行为）、🔵 推断（Apple 未公开，由我们给出的工程化方案）。

---

## Source Legend

| Badge            | Meaning                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 **Official**  | Apple HIG, Developer Documentation, WWDC25 Session 219 / 356, WWDC18 Session 803, Apple Newsroom, Apple Support                              |
| 🟡 **Observed**  | Behavior visible in shipped Apple Music product (publicly observable, not disclosed by Apple)                                                |
| 🔵 **Inference** | Apple has not publicly disclosed this implementation. This spec defines our engineering standard, grounded in the official principles above. |

---

# Chapter 1: Core Philosophy

## 1.1 Why Apple Music _feels_ expensive

Apple Music's premium feel does **not** come from glass, gradients, or blur. It comes from a consistent, repeatable answer to one question:

> **Who is the hero of this screen, and is everything else arranged to prove it?**

The observable system behind that answer has five pillars:

### 1.1.1 Information hierarchy — one hero per screen

Every Apple Music surface has exactly one dominant element: the album artwork in Now Playing, the current lyric line in the lyrics view, the queue list in Up Next. Everything else is arranged on a strict visual budget. When Apple updated its design system, the instruction was explicit: _"Instead of relying on decoration, hierarchy should be expressed through layout and grouping."_ 🟢 (WWDC25 Session 356)

**Engineering consequence:** a screen must be renderable as a single "hero rectangle" plus a constrained set of "supporting elements". If a screen cannot be described that way, it is over-designed and must be simplified before implementation.

### 1.1.2 Whitespace is structural, not empty

Apple Music's Now Playing screen keeps transport controls at the bottom, metadata at a fixed distance, and lets the artwork breathe. Space is used to _separate interactive regions_, which is exactly how the HIG frames grouping: _"use negative space, background shapes, colors, materials, or separator lines to show when elements are related and to separate information into distinct areas."_ 🟢 (HIG Layout)

**Engineering consequence:** spacing is a token system (see §8.0). Two regions must never be separated by ad-hoc padding; separation values come from the scale (8/12/16/24/32) and must survive Dynamic Type, window resizing, and landscape.

### 1.1.3 Dynamic feedback — the interface must never feel late

From WWDC18: _"Our tools depend on the latency… we work so hard to reduce latency"_; interfaces must support _interruption and redirection_ and _spatial consistency_. 🟢 A button that waits 300 ms to react, or a lyrics line that snaps instead of gliding, reads as "cheap" even at 120 fps.

**Engineering consequence:** every interactive element has a mandatory **press response ≤ 60 ms after touch-down** (visual feedback, not action). Every animation must be interruptible: when input changes mid-animation, the animation retargets from the current value — never restarts from the beginning.

### 1.1.4 Musical emotion is carried by content, not chrome

Apple Music expresses the mood of a song through the **album artwork**, the **lyrics**, and the **background gradient derived from the artwork** — not through decorative UI. Controls stay monochromatic so they cannot compete. 🟢 HIG Color: _"If your app features colorful backgrounds or visually rich content, prefer a monochromatic appearance for toolbars and tab bars."_

**Engineering consequence:** the UI color palette is derived, not fixed. Background gradients and UI accent colors are computed from the current artwork's palette, with a mandatory luminance gate (§7.7). Hard-coded brand colors are banned inside the player surface.

### 1.1.5 Content-first principle

The Liquid Glass system exists to _let content shine through_: _"Liquid Glass forms a distinct functional layer… floating above your content to bring structure and clarity, without ever stealing focus."_ 🟢 (WWDC25 Session 356) Controls float above content; content is never buried under chrome.

**Engineering consequence:** any element that overlaps artwork or lyrics must be (a) transient, (b) material-backed, or (c) dismissed automatically on idle. Persistent chrome is prohibited inside the Now Playing surface.

## 1.2 Principle → Example → Engineering Constraint

| #   | Principle                    | Example (Apple Music)                                              | Engineering Constraint                                                                                            |
| --- | ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| P1  | Content is the hero          | Album artwork dominates the Now Playing screen                     | Never place heavy UI above artwork. Controls must not exceed ~12% of screen area and must fade/recede at rest.    |
| P2  | One focal point per state    | Lyrics view: current line is the only fully-opaque, scaled element | Exactly one lyric line at opacity 1.0 and scale >1.0 at any time.                                                 |
| P3  | Silence is structural        | Huge empty space between artwork and controls                      | Spacing only from the scale tokens (§8.0); no ad-hoc padding in code.                                             |
| P4  | Instant response             | Play button flexes on touch-down                                   | Press feedback ≤60 ms; haptics optional but must not be the only feedback (HIG Motion).                           |
| P5  | Motion is interruptible      | Scrubbing the progress bar retargets instantly                     | All animations use springs; interrupting an animation must continue from the current value (no reset).            |
| P6  | Emotion comes from the music | Background gradient + spectrum follow the song                     | UI color/animation parameters are functions of audio features (artwork palette, FFT energy, tempo), never random. |
| P7  | Controls are servants        | Transport bar is monochrome, floats over the artwork gradient      | Use system monochrome symbols; accent color only for the play state and the primary action.                       |
| P8  | Legibility always wins       | Lyrics remain readable over any artwork                            | Contrast gate: UI surfaces must pass 4.5:1 for text, 3:1 for glyphs (WCAG AA), enforced by the palette engine.    |
| P9  | The music is the clock       | Lyrics scroll and highlight exactly with the audio                 | UI timeline must be driven by the audio clock, not by scroll events or `Timer`s (§4.5).                           |
| P10 | Restraint is a brand         | Apple Music never celebrates its own UI                            | One animation per interaction, ≤ 500 ms for feedback; anything longer must be scrubbable or cancelable.           |

## 1.3 Axioms for reviewers

1. If an element does not carry information, afford an action, or express the music, delete it.
2. If two elements compete for the eye, one of them is wrong.
3. If a transition takes longer than a breath (~0.5 s), it must be interruptible.
4. If a feature needs decoration to look good, the hierarchy — not the decoration — needs fixing.

---

# Chapter 2: Information Architecture

## 2.1 Player screen layer tree

The Now Playing surface is a strict stack. Layers never merge; they only occlude and reveal.

```text
Player Screen
│
├── Background Layer          z=0      (artwork-derived gradient, ambient motion)
│
├── Artwork Layer             z=10     (hero artwork card, reflection, depth shadow)
│
├── Metadata Layer            z=20     (title / artist / album, quality badge)
│
├── Lyrics Layer              z=30     (time-synced lyrics, full-bleed mode)
│
├── Control Layer             z=40     (transport, progress, volume — Liquid Glass)
│
└── Gesture Layer             z=50     (scroll, scrub, dismiss, tap-to-toggle chrome)
```

## 2.2 Layer specification

Layer values are the _contract_; implementations must honor the relative order and the interaction priority. `z` here is the conceptual order in a single view tree; on macOS/iPad (multi-column) the same order applies per column.

| Layer      | z   | Blur (background contribution)                    | Opacity (rest → active)                 | Interaction priority                                        | Notes                                                                                         |
| ---------- | --- | ------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Background | 0   | 40–80 pt on artwork-sourced gradient 🔵           | 1.0 → 0.85 when chrome expands          | 0 — never intercepts                                        | Renders at 1 fps ambient drift; **no** beat-synced pulsing (see §10 DON'T)                    |
| Artwork    | 10  | 0 (sharp); shadow soft 30–60 pt 🔵                | 1.0                                     | 1 — tap: cycle view mode; drag-down: dismiss; pinch: expand | Aspect preserved; no letterbox. GPU-cached (blurred copy for background, sharp copy for hero) |
| Metadata   | 20  | 0 (text sits on artwork or background)            | 1.0                                     | 2 — tap title/artist: jump to album/artist                  | Max 3 lines; typography from §8.0                                                             |
| Lyrics     | 30  | 0 — **never** glass-backed (🔵 rationale in §3.3) | current line 1.0, past 0.7, future 0.45 | 3 — vertical scroll, tap line = seek                        | Driven by audio clock (§4.5); scroll position is an output, never an input                    |
| Control    | 40  | Liquid Glass Regular (auto-adaptive) 🟢           | 0.9 at rest → 1.0 on interaction        | 4 — transport, scrub, volume                                | Transient: auto-recedes after 3 s idle in immersive mode                                      |
| Gesture    | 50  | n/a                                               | n/a                                     | 5 — system-gesture arbitration                              | Must never compete with system edge gestures (HIG: don't fight the system)                    |

## 2.3 Interaction rules

- **Tap artwork** toggles between Artwork mode and Lyrics mode (or expands in immersive modes). 🟡 Observed
- **Drag down** on artwork (or anywhere in lyrics mode) dismisses the player with a matched-geometry transition back to the mini-player. 🟡 Observed
- **Horizontal scrub** on the progress bar is direct manipulation: the finger controls position 1:1, with a live preview timestamp. 🟡 Observed
- **Tap a lyric line** seeks playback to that line's start time. 🟢 Official (Apple Support: "Jump to a certain verse… select any line")
- **Three-finger/edge gestures** are reserved for the system; our layers must leave 16 pt+ margins at screen edges where system gestures live. 🟢 (HIG Layout / safe areas)

## 2.4 Navigation states (single logical flow)

```text
Mini Player ──tap──▶ Now Playing (artwork)
                         │  tap artwork
                         ▼
                   Lyrics (immersive)
                         │  tap line
                         ▼
                   Seek + resume sync
                         │
                         └── drag-down ──▶ Mini Player (matched geometry)
```

Every transition is a **matched geometry** animation (shared element: artwork frame, mini-player artwork). 🟢 HIG: _"When content is intentionally grouped, it should stay together, even as the layout adapts."_

## 2.5 Adaptive layout

| Context                         | Artwork size                                      | Metadata position       | Controls                                       |
| ------------------------------- | ------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| iPhone portrait (compact width) | 70–85% width, centered                            | below artwork           | bottom, single row + volume                    |
| iPhone landscape                | left column, 45–55% height                        | right column, upper     | right column, lower                            |
| iPad / desktop (regular width)  | center, up to 40% of column width                 | below, left-aligned     | bottom bar; sidebar optional at ≥ 700 pt width |
| Mac full-screen player          | center-left; artwork up to 50% of viewport height | alongside, left-aligned | bottom + toolbar with Liquid Glass 🟢          |

**Constraint:** layout is driven by size classes and Dynamic Type — never by device ID. `SafeArea` must be respected; on iPhone the status bar may hide only in immersive lyrics mode (HIG allows hiding for media depth). 🟢

---

# Chapter 3: Liquid Glass Rules

## 3.1 What Liquid Glass is (and is not)

🟢 Liquid Glass is a **dynamic material**, not a blur filter. Apple defines it as a _"new digital meta-material that dynamically bends and shapes light"_ — it uses **lensing** (bending/concentrating light) rather than the scattering of older blur materials, and it adapts continuously to what is behind it: shadow strength over text, tint amount, light/dark appearance, and even geometry (morphing between shapes). (WWDC25 Session 219; HIG Materials)

Three behaviors are non-negotiable engineering targets if you build a custom approximation:

1. **Adaptivity** — the material's tint/shadow/luminosity must respond to the content scrolling underneath, and it must be able to switch between light and dark appearance based on background luminance. 🟢
2. **Lensing over scattering** — edges should subtly _bend_ the background (refraction feel) rather than uniformly blur it. 🟢 (Apple explicitly contrasts lensing with scattering)
3. **Fluidity** — materialized elements modulate light in/out instead of fading with opacity; pressed elements _illuminate from within_, and shapes morph into each other during transitions. 🟢

> ⚠️ Apple has not published the exact numeric parameters (blur radius, refraction strength, shadow opacity) of Liquid Glass. 🔵 The parameter table below is our engineering standard, tuned to reproduce the _perceived_ behavior with conventional platform materials where Liquid Glass APIs are unavailable (React Native, Flutter, Web).

## 3.2 Material parameter spec 🔵

Wherever the platform provides Liquid Glass (`SwiftUI .glassEffect`, macOS/iOS system bars), **use the system material and do not override its parameters**. The table is for custom approximations and cross-platform ports.

| Parameter          | Resting (small controls, e.g. toolbar buttons) | Expanded (menus, sheets, sidebars)                                | Notes                                                                                                              |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Blur radius        | 24–32 pt                                       | 40–60 pt                                                          | Larger surface ⇒ thicker material, deeper blur (WWDC25: menus/sheets feel thicker) 🟢-informed                     |
| Luminosity shift   | −8% … +8% (adaptive to background)             | −12% … +12%                                                       | Must follow background luminance; light/dark flip allowed only for elements < ~400 pt tall (nav bars, tab bars) 🟢 |
| Tint               | 0 (clear) … 30% of accent                      | accent 15–40%                                                     | Tint strength maps to content brightness underneath (colored-glass behavior) 🟢                                    |
| Shadow             | opacity 8–20%, blur 12–24 pt, offset 0–4 pt    | opacity 15–30%, blur 24–48 pt, offset 4–8 pt                      | Shadow opacity must **rise when text scrolls underneath** 🟢                                                       |
| Corner radius      | capsule (r = h/2) or fixed 14–18 pt            | concentric: parent radius − padding (WWDC25 §356 shape system) 🟢 | Never mix radius families within one control                                                                       |
| Refraction         | 1–3 pt edge displacement                       | 2–5 pt                                                            | Simulated with an inner stroke + displaced background copy when no real-time refraction is possible                |
| Specular highlight | top-edge 0.5–1 pt, white 20–40%                | 1–2 pt                                                            | Must follow the geometry, not be a static gradient                                                                 |
| Press response     | illuminate + flex within 60 ms 🟢              | —                                                                 | Material lights from the touch point outward 🟢                                                                    |

**Contrast gate:** text/symbols on glass must hold WCAG AA against _both_ the material and the worst-case content beneath it. If the content behind a Clear element is bright, Apple requires a dark dimming layer at **35% opacity** (or localized dimming for small elements). 🟢 (HIG Materials)

## 3.3 Where glass is allowed — and where it is forbidden

### Allowed

| Surface                           | Variant                                        | Why                                                         |
| --------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| Toolbar / navigation bars         | Regular (auto) 🟢                              | Functional navigation layer                                 |
| Floating transport controls       | Regular, interactive                           | Controls are the functional layer over content              |
| Menus, popovers, action sheets    | Regular, thicker when expanded 🟢              | Content containers that originate from their source element |
| Sidebar (Mac/iPad)                | Regular                                        | Navigation layer                                            |
| Slider/toggle _while interacting_ | Regular knob 🟢                                | Transient interactivity emphasis                            |
| Mini player                       | Clear over artwork, Regular over content lists | Media-rich background (Clear conditions met) 🟢             |

### Forbidden

| Surface                                                         | Why                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Main content** (tables, cards, lists)                         | _"Don't use Liquid Glass in the content layer"_ 🟢                                                |
| **Album artwork**                                               | Glass on the hero destroys the hero; artwork must stay sharp                                      |
| **Lyrics background**                                           | Lyrics are content; glass behind text reduces legibility and competes with the current-line focus |
| **Glass on glass**                                              | _"Always avoid glass on glass"_ 🟢 — top elements must use fills/transparency/vibrancy instead    |
| **Decorative accents** (borders, badges, non-functional shapes) | _"Use Liquid Glass effects sparingly"_ 🟢                                                         |

**One glass family per app.** Regular and Clear variants _"should never be mixed"_ as a styling choice. 🟢 (WWDC25 219)

## 3.4 Scroll edge effects

Where content scrolls beneath glass, use the platform's scroll-edge effect instead of a background/border:

- **Soft** — gradual dissolve, for interactive elements like buttons; default. 🟢
- **Hard** — uniform stronger boundary, for pinned headers or text-only controls; mostly macOS. 🟢

Rules: exactly **one** edge effect per scroll view (per pane on iPad/macOS Split View), heights consistent between panes; edge effects are **not decorative** — they exist only where floating UI overlaps scrolling content. 🟢

## 3.5 Tinting rules

1. Glass has **no inherent color**; it takes color from the content behind it. 🟢
2. Color on glass is reserved for functional emphasis: selected tab, primary action (e.g. Play), status. 🟢
3. To emphasize a primary action, color the **background**, not the symbol or text. 🟢
4. If artwork is colorful, toolbars/tab bars stay **monochromatic**; pick the accent from the palette with sufficient differentiation. 🟢
5. If you tint, tint strength adapts to the brightness of the content underneath (colored glass behavior). 🟢

## 3.6 Engineering constraints

| #   | Constraint                                                                                                              | Rationale                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| G1  | Use system components/APIs where they exist (`glassEffect`, `GlassEffectContainer`, system bars)                        | 🟢 System components pick up Liquid Glass + accessibility automatically             |
| G2  | Combine custom glass effects in **one** `GlassEffectContainer` per screen; limit effects on screen                      | 🟢 Performance: containers let shapes morph and share rendering                     |
| G3  | Apply the effect to the **control**, never to its inner views                                                           | 🟢 (WWDC25 356)                                                                     |
| G4  | Never implement glass as a static PNG or fixed gradient                                                                 | Violates adaptivity; fails "settings" (Reduce Transparency) and dark/light contexts |
| G5  | Support Reduce Transparency / Increase Contrast: glass degrades to opaque surfaces automatically                        | 🟢 HIG: materials adapt to accessibility settings                                   |
| G6  | Performance budget: glass is expensive. Keep live glass surfaces ≤ 4 per screen; pre-render blurred artwork backgrounds | 🔵 (pragmatic target)                                                               |

---

# Chapter 4: Apple Music Lyrics System Analysis

## 4.1 What Apple has officially disclosed

- Time-synced lyrics appear **line-by-line**, and with Apple Music Sing, **beat-by-beat**. 🟢 (Apple Support; App Store description)
- Lyrics "dance to the rhythm of the vocals"; background vocal lines animate **independently**; Duet view splits vocalists to opposite sides of the screen. 🟢 (Apple Newsroom, Dec 6 2022)
- Users can tap any line to jump to that verse. 🟢 (Apple Support)
- Lyrics are one of the most-used features of the service ("consistently one of the most popular features"). 🟢 (Apple Newsroom)
- iOS 26 adds lyrics translation and pronunciation, with per-script size control (Settings > Apps > Music > Larger Text). 🟢 (Apple Support)

## 4.2 What Apple has **not** publicly disclosed

> ⚠️ **Apple has not publicly disclosed this implementation.** Specifically: the lyric timestamp format and granularity, the scroll physics, the word-highlight easing, the sync error-correction strategy, and the background-vocal rendering algorithm are not documented. Everything below in §4.3–§4.6 is 🔵 Inference (from observable product behavior) and is our engineering specification.

## 4.3 Observed product behavior (baseline) 🟡

1. Lyrics scroll automatically, keeping the current line centered-ish in the viewport; scrolling is smooth, not stepped.
2. The current line is larger, fully opaque; past lines are dimmed; future lines are dimmer still.
3. Within the current line, syllables/words fill left-to-right with a highlight that tracks the vocals.
4. With multiple simultaneous vocal lines (backing vocals), secondary lines highlight independently, at reduced emphasis.
5. Scrubbing the progress bar re-targets the lyric position and highlight immediately (no catch-up animation).
6. When a song lacks time-synced lyrics, a static full-lyrics view is shown instead. 🟢 (Apple Support)

## 4.4 Data model

```typescript
// lyric-types.ts — contract for the lyrics pipeline

interface LyricWord {
  text: string
  startTime: number // seconds, relative to track start; audio-clock domain
  endTime: number // seconds; must be > startTime
  confidence?: number // 0..1; <0.6 → render as static, no karaoke fill
}

interface LyricLine {
  words: LyricWord[]
  startTime: number // derived: words[0].startTime (validate)
  endTime: number // derived: words.at(-1).endTime (validate)
  vocalTrack?: 'main' | 'backing' | 'duetLeft' | 'duetRight' // Sing mode
  translation?: string // localized target-language line
  pronunciation?: string // phonetic line
}

interface LyricDocument {
  language: string
  lines: LyricLine[]
  version: number
  // Validation invariants (enforced at ingest):
  // 1. lines sorted by startTime, non-overlapping (tolerance 10 ms)
  // 2. each word within its line's [startTime, endTime]
  // 3. max gap between words ≤ 800 ms (else insert "hold" word with empty text)
  // 4. startTime >= 0; duration <= track duration + 500 ms
}
```

**Validation rules** (enforced by a `LyricsValidator`, run offline and at load):

| Rule                                  | Tolerance | Action on failure                                                                                            |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| Line times monotonic, non-overlapping | 10 ms     | Clamp/repair; quarantine line if unresolvable                                                                |
| Word times within line                | 10 ms     | Extend line bounds                                                                                           |
| Word gap                              | ≤ 800 ms  | Insert hold segment (fill pauses the same way Apple Music keeps the fill steady during instrumental gaps 🟡) |
| Track-duration bound                  | +500 ms   | Drop trailing out-of-range words                                                                             |
| Missing word timings                  | —         | Fall back to line-level highlight (whole-line fill)                                                          |

## 4.5 Rendering architecture

```text
Audio Clock (authoritative: AVPlayer.currentTime / CMTime / audio frame counter)
        │  emits time t, rate, isPlaying, seeking
        ▼
Lyrics Sync Engine (pure function: t → active line index + per-word progress)
        │  no view logic, no timers, unit-testable
        ▼
Animation Timeline (maps sync output to visual state per line/word; eases, holds)
        │  60/120 fps via display link, render-on-demand on change
        ▼
Text Renderer (attributed text, gradient mask or shader; layout is stable)
```

### Why the audio timeline must drive the lyrics — not scroll events

| Approach                                    | Failure mode                                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scroll-driven (`onScroll` → compute line)   | Scroll is initiated by the user or by inertia; it is **input**, not truth. Highlighting becomes a function of finger velocity, rubber-banding, and animation state — it desyncs from audio on every interruption, and makes "tap line to seek" ambiguous. |
| `Timer`/`Timer.scheduledTimer` (wall clock) | Wall clocks drift from audio clocks (buffer underruns, A/V offset, playback rate ≠ 1.0 in HiFi gapless/bit-perfect modes).                                                                                                                                |
| **Audio-clock-driven** (this spec)          | The audio clock is the single source of truth. Scroll position is a **rendered output** of sync state. Scrubbing updates one number (time); the whole UI re-derives. No drift by construction.                                                            |

This mirrors Apple's own motion principle: the UI must be _"aligned with the dynamism and continually changing nature"_ of the underlying system — here, the music. 🟢 (WWDC25 219: Liquid Glass reacts to its environment; the same philosophy applies to a timeline-driven surface.)

## 4.6 Sync engine specification

| Concern        | Spec                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clock source   | `CMTime` from the player at 1 kHz resolution; for bit-perfect/gapless HiFi output, use the **audio render frame counter** (`AVAudioTime.hostTime` mapping) when output latency > 20 ms |
| Sync query     | `func state(at t: TimeInterval) -> SyncState` — binary search over lines; pure, no side effects                                                                                        |
| Seek handling  | On `seek`, clamp t, emit single state change; highlight and scroll **retarget instantly** (no tween from old line) 🟡 Observed                                                         |
| Latency budget | visual response to audio ≤ 1 frame (16.7 ms); measured, not assumed                                                                                                                    |
| Hold behavior  | During word gaps > 100 ms, fill stays frozen at its last value (Apple Music holds the fill during instrumental sections 🟡)                                                            |
| Pause          | On pause: freeze fill + scroll; resume: continue from clock (no rewind)                                                                                                                |
| Drift          | If UI frame delivery lags audio clock by > 50 ms sustained, drop intermediate frames (skip-ahead), never re-animate                                                                    |
| Error states   | No lyrics / partially timed / low-confidence words: degrade gracefully to static view or line-level highlight 🟢 (Apple Support: static lyrics shown when time-synced unavailable)     |
| Unit tests     | Given a synthetic clock trace (normal, seeks, rate 0.5×, rate 1.0×, gap-heavy), the engine's emitted state must match a golden snapshot                                                |

---

# Chapter 5: Word-Level Karaoke Animation

## 5.1 The algorithm

For each word in the active line, fill progress is a pure function of the audio clock:

```text
progress(word, t) = clamp((t − word.startTime) / (word.endTime − word.startTime), 0, 1)
lineProgress(line, t) = clamp((t − line.startTime) / (line.endTime − line.startTime), 0, 1)
```

Timeline semantics (matching observed Apple Music behavior 🟡):

| Segment                               | Rule                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `t < word.startTime`                  | word at 0% (unfilled)                                                               |
| `word.startTime ≤ t < word.endTime`   | fill = linear progress, **applied per word** (words fill one-by-one, left-to-right) |
| `t ≥ word.endTime`, next word pending | hold at 100% (word stays filled)                                                    |
| gap between words (no active word)    | hold fill steady — no advance, no reset 🟡                                          |
| line finished, next line pending      | entire line 100%; line itself fades to "past" state per §6.5                        |

## 5.2 Rendering strategies

Four implementations, in ascending fidelity. All four must read the **same** `progress` values — the algorithm is renderer-agnostic.

| Strategy                       | Mechanism                                                                                                           | Pros                                                                     | Cons                                                               | Choose when                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------- |
| **Gradient mask**              | Two text layers; top layer is white, bottom layer is accent; a moving linear-gradient mask reveals the bottom layer | Works everywhere (SwiftUI, RN, Flutter, Web); cheap; sub-line smoothness | Fill is continuous across word boundaries unless you mask per-word | Default                                |
| **Text clipping**              | Per-word `Text` clips to a fill rect (or uses `foregroundStyle` ranges)                                             | True word-level step behavior; crisp edges                               | Needs per-word layout metrics; more views                          | Word-level step + translation modes    |
| **Attributed ranges (native)** | `AttributedString` with per-range fill color/opacity, updated by renderer                                           | Most native feel; Dynamic Type-safe                                      | High-frequency updates require careful coalescing                  | SwiftUI/UIKit with Metal-backed text   |
| **Shader (GPU)**               | Fragment shader receives progress per word rect; draws fill inside glyph coverage                                   | Cheapest at scale; 120 Hz; smooth                                        | Requires glyph layout data (CoreText/Skia); most complex           | High-end HiFi app on desktop/ProMotion |

## 5.3 Animation curve

Apple Music's karaoke fill reads as **linear with the vocals** — it tracks syllable timing rather than easing between words. Our spec:

```text
fill(t) = progress(word, t)                      // linear, no easing on the fill itself
state transitions (line focus/scroll) = spring   // §6.5
```

Do **not** ease the fill (easing makes the highlight drift ahead of the vocalist). The perceived smoothness comes from the _line transitions_ and from 120 Hz frame delivery, not from the fill curve. 🟡 Observed / 🔵

## 5.4 SwiftUI implementation

### 5.4.1 Sync state (pure)

```swift
struct WordProgress: Identifiable {
    let id: Int
    let text: String
    let progress: CGFloat          // 0...1
    let active: Bool
}

struct LyricsSyncEngine {
    let lines: [LyricLine]

    func state(at t: TimeInterval) -> (lineIndex: Int, words: [WordProgress]) {
        guard let idx = activeLineIndex(at: t) else { return (-1, []) }
        let line = lines[idx]
        let words = line.words.map { w in
            WordProgress(
                id: w.id,
                text: w.text,
                progress: clamped((t - w.startTime) / (w.endTime - w.startTime)),
                active: t >= w.startTime && t < w.endTime
            )
        }
        return (idx, words)
    }

    private func activeLineIndex(at t: TimeInterval) -> Int? {
        var lo = 0, hi = lines.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if t < lines[mid].startTime { hi = mid - 1 }
            else if t >= lines[mid].endTime { lo = mid + 1 }
            else { return mid }
        }
        return lo - 1 >= 0 ? lo - 1 : nil   // gap handling: hold last line
    }
}
```

### 5.4.2 Gradient-mask renderer (cross-platform-safe)

```swift
struct KaraokeWord: View {
    let text: String
    let progress: CGFloat                 // 0...1
    var fill: Color = .white
    var base: Color = .white.opacity(0.35)

    var body: some View {
        Text(text)
            .foregroundStyle(base)                       // unfilled appearance
            .overlay(alignment: .leading) {
                Text(text)
                    .foregroundStyle(fill)
                    .mask(
                        LinearGradient(
                            stops: [
                                .init(color: .black, location: 0),
                                .init(color: .black, location: progress),
                                .init(color: .clear, location: progress),
                                .init(color: .clear, location: 1)
                            ],
                            startPoint: .leading, endPoint: .trailing
                        )
                    )
                    .allowsHitTesting(false)
            }
            .fixedSize()
    }
}
```

**Perf note:** the overlay is a duplicate text layer; it is cheap because both layers are text rasterization with a gradient mask. For 120 Hz updates, coalesce to display-link frames and skip when `progress` delta < 0.001.

### 5.4.3 Line view driven by the audio clock

```swift
struct LyricLineView: View {
    let line: LyricLine
    let state: LineVisualState          // current/future/past (§6.5)

    var body: some View {
        HStack(spacing: 10) {
            ForEach(line.words) { w in
                KaraokeWord(text: w.text, progress: state.wordProgress[w.id] ?? 0)
            }
        }
        .scaleEffect(state.scale)
        .opacity(state.opacity)
        .blur(radius: state.blur)
        .animation(.lyricLine, value: state)   // spring, §6.5
    }
}

struct LyricsView: View {
    @State private var t: TimeInterval = 0      // fed by AudioTimelineClock

    var body: some View {
        ScrollViewReader { proxy in
            LazyVStack(spacing: 24) {
                ForEach(lines) { line in
                    LyricLineView(line: line, state: visualState(for: line))
                        .id(line.id)
                }
            }
            .scrollPosition(id: $activeLineID)  // output only; never input to sync
            .scrollIndicators(.hidden)
        }
    }
}
```

## 5.5 React Native implementation (react-native-skia)

```tsx
import { Canvas, LinearGradient, Mask, Rect, Text, Skia } from '@shopify/react-native-skia'

function KaraokeWord({ text, progress }: { text: string; progress: number }) {
  const font = useFont(require('./SF-Pro.ttf'), 28)
  if (!font) return null

  const width = font.measureText(text).width
  const gradient = Skia.Shader.MakeLinearGradient(
    { x: 0, y: 0 },
    { x: width, y: 0 },
    ['white', 'white', 'transparent', 'transparent'],
    [0, progress, progress, 1]
  )

  return (
    <Canvas style={{ width, height: 40 }}>
      {/* base (dim) text */}
      <Text x={0} y={30} text={text} font={font} color="rgba(255,255,255,0.35)" />
      {/* filled text, clipped to gradient */}
      <Mask
        mode="luminance"
        mask={
          <Rect x={0} y={0} width={width} height={40}>
            <LinearGradient
              colors={['black', 'black', 'transparent', 'transparent']}
              positions={[0, progress, progress, 1]}
              start={{ x: 0, y: 0 }}
              end={{ x: width, y: 0 }}
            />
          </Rect>
        }
      >
        <Text x={0} y={30} text={text} font={font} color="white" />
      </Mask>
    </Canvas>
  )
}
```

Word-level "step" (each word turns on individually) is achieved by passing each word its own `progress` — the mask approach naturally produces continuous fill within a word and hard steps between words.

## 5.6 Flutter implementation

```dart
class KaraokeWord extends StatelessWidget {
  const KaraokeWord({super.key, required this.text, required this.progress});
  final String text;
  final double progress; // 0..1

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      shaderCallback: (rect) => LinearGradient(
        colors: [Colors.white, Colors.white, Colors.transparent, Colors.transparent],
        stops: [0, progress.clamp(0, 1), progress.clamp(0, 1), 1],
      ).createShader(rect),
      blendMode: BlendMode.srcATop,
      child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 28)),
    );
  }
}
```

For word-stepped fills, render each word as its own `KaraokeWord` inside a `Row` (same contract as §5.4.2).

## 5.7 Performance budget (all platforms)

| Metric                 | Budget                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sync engine evaluation | ≤ 0.05 ms per frame (binary search; memoize line lookup)                                                           |
| Text re-layout         | 0 — layout is stable; only masks/colors change                                                                     |
| Frame delivery         | 60 fps minimum; 120 fps on ProMotion; frame-skip beyond 50 ms lag                                                  |
| Memory                 | lyric text + 2 render layers per visible line; virtualize offscreen lines (`LazyVStack`/`RecyclerView` equivalent) |
| Reduce Motion          | fill animation disabled → line-level instantaneous highlight (HIG Motion: motion must be optional) 🟢              |

---

# Chapter 6: Motion Design

## 6.1 Motion language

Motion derives from three official sources:

1. **Responsiveness & redirection** — every interaction responds instantly and can be interrupted mid-flight (WWDC18 Session 803). 🟢
2. **Purpose over spectacle** — _"Add motion purposefully… Don't add motion for the sake of adding motion"_; feedback should be _brief and precise_ (HIG Motion). 🟢
3. **Physicality** — Liquid Glass flexes, illuminates, and morphs; motion and material were designed as one (WWDC25 219). 🟢

## 6.2 Motion tokens

Springs are preferred over fixed-duration easing for interactive motion (they are inherently interruptible). Duration tokens are for non-interactive sequences only.

| Token      | Value                         | Used for                                                   |
| ---------- | ----------------------------- | ---------------------------------------------------------- |
| `press`    | response 0.25 s, damping 0.8  | Button/slider press feedback, glass illumination           |
| `snappy`   | response 0.30 s, damping 0.82 | Mini-player expand/collapse, artwork focus                 |
| `standard` | response 0.45 s, damping 0.85 | Page transitions, sheet presentation, lyrics line focus    |
| `gentle`   | response 0.65 s, damping 0.88 | Full-screen immersive transitions, artwork parallax settle |
| `fade-in`  | 0.25 s ease-out               | Component entry (opacity only, non-interactive)            |
| `fade-out` | 0.18 s ease-in                | Component exit, auto-hide chrome                           |

**Interruption rule:** springs retarget from current value on new input; duration-based animations must expose `cancel()` and jump to target state instantly.

## 6.3 Component enter

| Property              | Value                              | Notes                                                           |
| --------------------- | ---------------------------------- | --------------------------------------------------------------- |
| Opacity               | 0 → 1                              | 0.25 s, ease-out                                                |
| Scale                 | 0.96 → 1.0                         | spring `standard`; children never scale independently           |
| Translation           | +8 pt upward → 0                   | only for bottom-anchored controls                               |
| Blur (only for glass) | via material morphing, not opacity | 🟢 Liquid Glass materializes by modulating light, not by fading |
| Stagger               | siblings offset ≤ 40 ms            | never > 80 ms; a 12-item list is not a 12-act play              |

## 6.4 Page transitions — matched geometry

All navigation in the player uses **shared-element / matched geometry** transitions (SwiftUI `matchedGeometryEffect`; React Native `react-native-reanimated` shared transition; Flutter `Hero`):

| Transition                | Source → Destination                                     | Behavior                                                                              |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Mini-player → Now Playing | artwork frame grows; metadata cross-fades upward         | Scale-from-source, spring `standard`; text fades at 50% of duration                   |
| Now Playing → Lyrics      | artwork slides up + scales to 0.86; lyrics fade/slide in | same spring; artwork remains visible at reduced size (Apple Music behavior 🟡)        |
| Lyrics → Now Playing      | exact reverse                                            | Reverse must be _spatially symmetric_ (WWDC18 spatial consistency 🟢)                 |
| Dismiss                   | artwork shrink → mini-player                             | drag-driven: gesture controls progress 1:1; release decides settle (spring) or cancel |

**Constraint:** matched transitions must interpolate **geometry and opacity only**. Never interpolate blur radius on a matched element (it reads as glass and costs GPU).

## 6.5 Lyrics motion states

Exactly as specified by the product brief, with engineering rationale:

| State            | Scale | Opacity | Blur | Spring                              |
| ---------------- | ----- | ------- | ---- | ----------------------------------- |
| **Current line** | 1.05  | 1.0     | 0    | `standard`, retarget on line change |
| **Future lines** | 1.0   | 0.45    | 0    | none (opacity animates 0.2 s)       |
| **Past lines**   | 1.0   | 0.7     | 0    | none                                |
| **Word fill**    | —     | —       | —    | none — linear with audio (§5.3)     |

**Why current line scales instead of just brightening:** scale is a legibility affordance that works across artwork contrast; blur is banned on lyrics (legibility + cost). Opacity alone is insufficient for line focus under bright backgrounds — scale gives a second cue. 🔵

**Engineering notes:**

- `blur: 0` is a _specification_, not an omission: past/future lines must be legible, so they are dimmed by opacity only.
- The current line's scale change must not reflow the layout — scale via transform, not font size (stable layout = no text re-measure, §5.7).
- On line change, scroll the line to viewport center with `scrollPosition`/`ScrollViewReader`, spring `standard`; the scroll animation must be interruptible by user scroll and by rapid line changes.

## 6.6 Cross-platform mapping

| SwiftUI                               | React Native                                                      | Flutter                                      | Web (CSS)                                                          |
| ------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `.spring(response:dampingFraction:)`  | `withSpring(value, { damping: 14, stiffness: 170 })` (reanimated) | `SpringSimulation(damping, stiffness)`       | `cubic-bezier(0.34, 1.2, 0.64, 1)` — spring-like, duration-bounded |
| `matchedGeometryEffect`               | `sharedTransitionTag` (reanimated)                                | `Hero(tag:)`                                 | FLIP technique                                                     |
| `TimelineView(.animation)`            | `useFrameCallback`                                                | `AnimationController` + `Ticker`             | `requestAnimationFrame`                                            |
| `withAnimation(.interactiveSpring())` | `withSpring(..., damping: 8)`                                     | `AnimationController` + `Curves.easeOutBack` | —                                                                  |
| `accessibilityReduceMotion`           | `AccessibilityInfo.isReduceMotionEnabled`                         | `MediaQuery.disableAnimations`               | `prefers-reduced-motion`                                           |

**Motion accessibility:** when Reduce Motion is enabled, all spring/scale transitions collapse to a ≤ 0.15 s cross-fade; karaoke fill becomes instantaneous. Motion must never be the _only_ carrier of information (HIG Motion 🟢).

---

# Chapter 7: Audio-Reactive UI

> ⚠️ **Apple has not publicly disclosed the implementation of audio-reactive UI** (waveforms, spectrum, beat-sync, or artwork color extraction). The pipeline below is 🔵 Inference grounded in Apple's own stated principle that Liquid Glass/UI _responds to its environment_ (WWDC25 219) and that content is the hero.

## 7.1 Design intent

Audio-reactive UI in a HiFi player has exactly one purpose: **make the music legible**. It must:

- translate the _structure_ of audio (beats, energy, spectral shape) into subtle motion;
- never outshine the artwork or lyrics;
- remain calm at rest — a HiFi player at 2 a.m. with a slow ballad must not look like a nightclub.

**Restraint rule:** reactive elements occupy ≤ 15% of the screen, move ≤ 6 pt amplitude, and animate ≤ 60% of the time (attack-decay envelopes, not sustained loops). 🔵

## 7.2 Data sources

| Source                                                                                 | Produces                                 | Used for                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Decoded PCM buffer (AVAudioFile / decoded asset)                                       | waveform peaks at multiple zoom levels   | scrubber waveform, album-art background rhythm |
| Real-time FFT (vDSP / Accelerate; Web Audio AnalyserNode; RN `react-native-audio-api`) | magnitude spectrum in dB                 | spectrum bars/rings, spectral centroid         |
| Onset/tempo detection                                                                  | beat phase, tempo (BPM), energy envelope | karaoke "dance" timing, background pulse       |
| Artwork pixels                                                                         | dominant color, palette, luminance       | background gradient, accent color (§7.7)       |

## 7.3 Pipeline

```text
Audio Engine
    │  PCM frames (render callback / AVAudioEngine tap)
    ▼
FFT (4096–8192 pt Hann window, 20–60 fps analysis rate)
    ▼
Frequency band reduction (log-spaced: 16–32 bands, ~20 Hz – 20 kHz)
    ▼
Normalization (per-band attack/release smoothing; dB → 0..1 with soft knee)
    ▼
Animation parameters (bandEnergy, centroid, beatPhase, energyEnvelope)
    ▼
UI Motion (update-rate throttled to ≤ 30 fps for visuals; 60 fps only during active scrub)
```

**Engineering constraints:**

| #   | Constraint                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Analysis runs on the audio/render thread (or a dedicated DSP thread); UI never blocks it.                                                     |
| A2  | All reactive parameters pass through **attack/release smoothing** (attack 10–30 ms, release 150–400 ms). Raw FFT values are never sent to UI. |
| A3  | Update-rate throttle: reactive visuals 30 fps max; interaction-driven visuals 60 fps.                                                         |
| A4  | Determinism: identical audio ⇒ identical parameters. No randomness anywhere in the pipeline.                                                  |
| A5  | Power: FFT analysis pauses when the reactive surface is not visible.                                                                          |

## 7.4 Waveform

**Rendering:** pre-computed min/max peaks per pixel-column from the decoded buffer; store a mipmap (zoom levels: 1 s/px → 1 ms/px) so scrubbing at any zoom is a lookup, not a re-read. 🟡 (Apple Music's scrubber shows a per-track waveform; implementation not disclosed → 🔵)

**Interaction contract:**

- Direct manipulation: finger position = playhead position 1:1 (WWDC18: lightweight interaction, amplified result 🟢).
- Playhead = bright fill; future = dim fill; both on the same baseline.
- On release: seek, then the playhead animates with the audio clock, never with the finger.
- While scrubbing, the lyrics sync engine receives the scrubbed time (preview), then the real time on release (§4.6 seek handling).

## 7.5 Beat detection (lightweight)

Purpose: drive the karaoke line rhythm and optional ambient motion. Implemented as **energy onset detection**:

```text
energy(t) = Σ over bands (smoothed magnitude²)          // every analysis frame
onset(t)  = max(0, energy(t) − energy(t − W)) / energy(t − W)   // spectral flux
beat(t)   = onset(t) > threshold ∧ above local moving average
tempo     = autocorrelation of onset envelope (60–180 BPM window)
beatPhase = (t − lastBeat) / beatInterval               // 0..1
```

| Parameter           | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Window W            | 512 ms                                                     |
| Threshold           | 1.35× local mean (adaptive)                                |
| False-positive gate | require 2 onsets within 1.5× median interval to lock tempo |
| Output smoothing    | beatPhase through one-pole filter, α = 0.4                 |

Use beat data for: lyric line _arrival_ anticipation (line fades in at beat-aligned offset), ambient background drift, and optional (opt-in) subtle pulse. **Never** pulse the artwork, the controls, or the lyrics text itself. 🟡 (Apple Music does not pulse its UI to the beat)

## 7.6 Spectrum visualization

| Property             | Spec 🔵                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Bands                | 16–32 log-spaced (20 Hz–20 kHz); bar or ring layout                |
| Max height/amplitude | 6 pt ambient; 24 pt when user selects "spectrum" view              |
| Color                | monochrome accent from palette; gradient from accent → transparent |
| Opacity              | 0.25 ambient; 0.5 focused                                          |
| Frequency            | 30 fps; bars use energy, not raw bin values                        |
| Safety               | no strobing; luminance delta per frame ≤ 0.3; amplitude attack cap |

## 7.7 Album color extraction

The background gradient and accent colors are derived from the artwork. Pipeline:

1. Downsample artwork to ≤ 64×64 px (nearest-neighbor is fine for palette).
2. Quantize colors (median-cut to 16 buckets; or 5×5×5 RGB histogram).
3. Score buckets: weight by population × contrast-to-white; drop colors where luminance < 0.15 or > 0.85 unless dominant.
4. Output: `backgroundGradient` (top/bottom colors), `accent` (highest-saturation viable bucket), `legibilityTone` (light/dark).
5. Apply **luminance gate**: if artwork is uniformly bright, the gradient darkens toward the bottom by up to 35% opacity of black (mirrors Apple's Clear-glass dimming guidance 🟢 HIG Materials); if uniformly dark, text stays white with elevated shadow.

| Output    | Rule                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| Gradient  | vertical, top = artwork top color, bottom = artwork bottom color darkened 15–35%      |
| Accent    | used only for: play state, selected tab, primary action — never for body text         |
| Text tone | `legibilityTone` decides light/dark labels; enforce WCAG AA per §3.2                  |
| Cache     | palette computed once per track (on artwork load), invalidated on artwork change only |

## 7.8 Perceived-quality guardrails

1. Reactive motion must be **statically verifiable**: a screenshot at any frame must still satisfy the typography/contrast rules.
2. When the audio is silent or paused, all reactive layers settle to their rest state within 400 ms.
3. User-controlled: "Ambient effects" toggle in settings; off = zero reactive motion (HIG: motion must be optional 🟢).
4. HiFi mode (bit-perfect / gapless): reactive visuals run from a **decoded analysis copy**, never from the bit-perfect output path — the audio path stays untouched by UI.

---

# Chapter 8: Component Library

## 8.0 Design tokens

### Spacing scale

| Token      | Value | Use                                      |
| ---------- | ----- | ---------------------------------------- |
| `space-4`  | 4 pt  | inline gaps (word spacing)               |
| `space-8`  | 8 pt  | icon-to-label, badge padding             |
| `space-12` | 12 pt | control groups, list rows                |
| `space-16` | 16 pt | standard screen margin (safe-area inset) |
| `space-24` | 24 pt | section separation                       |
| `space-32` | 32 pt | artwork-to-metadata                      |
| `space-48` | 48 pt | hero separation, lyrics line spacing     |
| `space-64` | 64 pt | full-screen mode breathing room          |

### Corner radii (concentric system 🟢 WWDC25 356)

| Token            | Value                           | Use                                       |
| ---------------- | ------------------------------- | ----------------------------------------- |
| `radius-10`      | 10 pt                           | artwork small (mini player)               |
| `radius-14`      | 14 pt                           | artwork medium, buttons                   |
| `radius-18`      | 18 pt                           | artwork hero, cards                       |
| `radius-capsule` | h/2                             | transport buttons, sliders, pill controls |
| Nested rule      | inner = parent radius − padding | any nested container                      |

### Typography (iOS Large / default scale, SF Pro 🟢 HIG)

| Style                                | Weight   | Size              | Leading |
| ------------------------------------ | -------- | ----------------- | ------- |
| Hero title (Large Title)             | Regular  | 34                | 41      |
| Track title (Title 2)                | Regular  | 22                | 28      |
| Artist (Headline)                    | Semibold | 17                | 22      |
| Album (Subhead)                      | Regular  | 15                | 20      |
| Lyrics line (Headline, custom scale) | Semibold | 17–34 (fontScale) | ×1.25   |
| Caption (quality badge)              | Regular  | 12                | 16      |

Constraints: all text scales with Dynamic Type; use system styles or `relativeTo:`; avoid Ultralight/Thin/Light weights at < 17 pt (HIG Typography 🟢); lyric font scale is a user setting (Settings > Apps > Music > Larger Text precedent 🟢).

### Color

| Role                | Rule                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| Background gradient | from artwork palette (§7.7)                                                          |
| Primary text        | legibilityTone-derived; white/black per luminance gate                               |
| Secondary text      | primary at 0.7 opacity                                                               |
| Accent              | palette-derived; reserved for play state + primary action                            |
| Success / error     | system semantic colors only (e.g. red for download errors) — never hard-coded hex 🟢 |

## 8.1 Player Controller

### Props (contract)

```typescript
interface PlayerControllerProps {
  playState: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  progress: number              // 0..1, audio-clock domain
  duration: number              // seconds
  volume: number                // 0..1
  quality: 'lossless' | 'hi-res-lossless' | 'flac-24' | 'aac'
  isGapless: boolean
  artwork: ArtworkDescriptor
  onSeek(t: number): void
  onTogglePlay(): void
  onNext/onPrevious/onShuffle/onRepeat(…): void
}
```

### Behavior contract

| Aspect        | Spec                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout        | one row: skip-back · play/pause (primary, glass, accent-filled) · skip-forward; below: progress scrubber; volume as a secondary slider (expandable)   |
| Play button   | 56 pt hit area (44 pt minimum, HIG touch guidance); press → illuminate within 60 ms; state change animated with spring `press`                        |
| Progress      | waveform scrubber (§7.4); timestamp chip while scrubbing; time labels secondary                                                                       |
| Volume        | horizontal slider, knob becomes glass while interacting 🟢 (HIG Materials: transient interactive elements)                                            |
| Quality badge | caption text + chevron; tap opens quality sheet with current selection; monochrome unless active                                                      |
| Idle behavior | chrome auto-recedes after 3 s of no input in immersive mode (opacity → 0.15, 0.5 s); any touch restores instantly                                     |
| Accessibility | every icon has a label; play/pause exposed as a button with combined label; VoiceOver announces time changes only on scrub release (not continuously) |
| Haptics       | optional; never the sole feedback 🟢 (HIG Motion)                                                                                                     |

## 8.2 Lyrics View

### Props (contract)

```typescript
interface LyricsViewProps {
  syncMode: 'off' | 'line' | 'word' | 'karaoke'
  animationStyle: 'static' | 'fill' | 'spring'
  fontScale: 0.85 | 1.0 | 1.15 | 1.3
  showTranslation?: boolean
  showPronunciation?: boolean
  vocalLayout?: 'single' | 'duet' | 'backing' // Sing parity 🟢 (Newsroom)
  onLineTap?(lineIndex: number): void
}
```

### Modes

| Mode      | Behavior                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `off`     | Lyrics hidden; artwork mode                                                                                                |
| `line`    | line-level highlight only (no word fill) — fallback for low-confidence timings                                             |
| `word`    | per-word fill, linear with audio (§5)                                                                                      |
| `karaoke` | word fill + vocal-track separation: backing vocals dimmed/independent, duet splits left/right (Apple Music Sing parity 🟢) |

### Behavior contract

| Aspect                    | Spec                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Sync                      | audio-clock driven; scroll position is output (§4.5)                                        |
| Current line              | scale 1.05, opacity 1.0, spring `standard` (§6.5)                                           |
| Past/future               | 0.7 / 0.45 opacity, no blur, no scale                                                       |
| Line tap                  | seek to line start (AudioClock domain)                                                      |
| Hold-to-report            | long-press a line → share sheet with "Report a Concern" (Apple Support parity 🟢)           |
| Translation/Pronunciation | sub-line rendering beneath original; fontScale applies per-script (Apple Support parity 🟢) |
| Dynamic Type              | lyrics scale with user fontScale, never clipped; lines wrap freely                          |

## 8.3 Album Artwork

### Props (contract)

```typescript
interface AlbumArtworkProps {
  image: ImageSource
  blur: 0 | 12 | 24 | 48 // only for background copies, never the hero
  reflection?: boolean // subtle floor reflection, HiFi-desk mode
  depth?: 0 | 1 | 2 // elevation: shadow scale + parallax amount
  onTap?(): void
  onDragDown?(progress: number): void
}
```

### Layers

```text
┌──────────────────────────────┐
│ Shadow (soft, depth-scaled)   │   z = 0
├──────────────────────────────┤
│ Reflection (mirror, 6–12%     │   z = 1  — only when depth > 0
│  opacity, gradient fade)      │
├──────────────────────────────┤
│ Artwork (sharp, aspect-locked)│   z = 2  — the only layer allowed to be sharp
└──────────────────────────────┘
```

### Rules

1. Hero artwork is **never blurred, never glass-backed, never decorated** with borders/badges.
2. The blurred copy exists only as the background-gradient source (§7.7), rendered to a cached bitmap once per track.
3. Depth is expressed through shadow + parallax (device tilt or cursor), amplitude ≤ 4 pt, disabled under Reduce Motion.
4. `onDragDown` feeds the dismiss transition (§6.4) at 1:1 gesture-to-visual mapping.
5. Reflection only in "desk/HiFi" display modes; off by default on mobile.

## 8.4 Supporting components

| Component             | Key spec                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mini Player           | artwork 40–56 pt, title/artist single line, play/pause + next; tap → matched expand (§6.4); Clear glass over artwork, Regular over lists 🟢                     |
| Queue (Up Next)       | list rows: index/artwork/title/duration; current row accent-dot; drag-to-reorder with spring `snappy`; source = now-playing (inline presentation 🟢 WWDC25 356) |
| Transport Menu (more) | glass sheet anchored to its source button 🟢; icons in menu items; "single source of truth" for actions                                                         |
| Volume                | see §8.1; mute state uses system icon set                                                                                                                       |
| Quality Sheet         | list of formats with current-state checkmark; mono/brand color per HIG tinting rules; formats: lossless / hi-res / spatial / gapless badge                      |
| AirPlay / Cast        | system picker where available; never custom-recreate system sheets (HIG: use system controls)                                                                   |

---

# Chapter 9: Engineering Examples

> SwiftUI examples target iOS 26 / macOS 26 (Liquid Glass APIs). API names follow the iOS 26 SDK; verify exact signatures against the installed SDK before shipping. All examples assume the token and data contracts from Chapters 4–8.

## 9.1 Liquid Glass button

```swift
import SwiftUI

// Primary transport button — glass, accent-filled, press-responsive.
// Apply .glassEffectContainer() once on the parent so multiple glass
// shapes blend and morph correctly (WWDC25 219 guidance).
struct TransportBar: View {
    @State private var isPlaying = false

    var body: some View {
        HStack(spacing: 32) {
            GlassIconButton(systemName: "backward.fill", label: "Previous") { }
            GlassPlayButton(isPlaying: isPlaying) { isPlaying.toggle() }
            GlassIconButton(systemName: "forward.fill", label: "Next") { }
        }
        .glassEffectContainer()          // one container per screen (G2)
        .padding(16)
        .background(.ultraThinMaterial, in: Capsule())   // standard material on the bar
    }
}

struct GlassPlayButton: View {
    let isPlaying: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
        }
        .buttonStyle(.glass)             // system Liquid Glass button style
        .background {
            if !isPlaying { Circle().fill(Color.accentColor) }   // accent only on Play
        }
        .contentShape(Circle())
        .accessibilityLabel(isPlaying ? "Pause" : "Play")
    }
}

// Custom glass effect for secondary controls (sparingly — G1/G4):
struct GlassIconButton: View {
    let systemName: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
        }
        .glassEffect(.regular, in: Circle())
        .accessibilityLabel(label)
    }
}
```

**Why `buttonStyle(.glass)` instead of custom blur:** system styles adapt to appearance, Reduce Transparency, and focus automatically — custom materials do not (HIG Materials / Adopting Liquid Glass 🟢).

## 9.2 Animated lyrics (TimelineView + audio clock)

```swift
import SwiftUI

struct LyricSurface: View {
    @EnvironmentObject var clock: AudioTimelineClock   // §9.4
    let engine: LyricsSyncEngine
    let lines: [LyricLine]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
            let t = clock.time            // audio-clock domain, NOT context.date
            let state = engine.state(at: t)
            LyricsScrollView(lines: lines, sync: state)
                .id(clock.seekGeneration) // reset scroll anchor after seek
        }
    }
}
```

**The one line that matters:** `let t = clock.time` — the visual timeline samples the **audio clock**; `context.date` (wall time) is used only for purely decorative ambient motion, never for sync.

## 9.3 Word highlight shader (Metal + SwiftUI)

Per-word fill on GPU, driven by the same `progress` values:

```metal
// KaraokeFill.metal
#include <metal_stdlib>
using namespace metal;

[[ stitchable ]] half4 karaokeFill(float2 pos,
                                   half4 color,
                                   float progress,
                                   float4 dimColor,
                                   float4 fillColor) {
    // pos.x is normalized 0...1 across the text view's width
    float edge = smoothstep(progress - 0.015, progress + 0.015, pos.x);
    half4 dim  = half4(dimColor.rgb, dimColor.a * color.a);
    half4 fill = half4(fillColor.rgb, fillColor.a * color.a);
    return mix(dim, fill, edge);
}
```

```swift
struct ShaderKaraokeWord: View {
    let text: String
    let progress: CGFloat

    var body: some View {
        Text(text)
            .font(.system(size: 28, weight: .semibold))
            .foregroundStyle(
                ShaderLibrary.karaokeFill(
                    .float(Float(progress)),
                    .float4(1, 1, 1, 0.35),   // dim color
                    .float4(1, 1, 1, 1)       // fill color
                )
            )
    }
}
```

**Why the shader is per-word, not per-line:** the fill must advance per word (left-to-right with the vocalist). A per-line shader can only approximate. Render each word as its own text layer; the word layout is stable so the shader never triggers re-layout (§5.7).

## 9.4 Audio timeline synchronization

```swift
import AVFoundation
import Combine

/// Single source of truth for "where we are in the song."
/// Visual layers sample this clock; they never own time.
final class AudioTimelineClock: ObservableObject {
    @Published private(set) var time: TimeInterval = 0
    @Published private(set) var rate: Double = 0
    @Published private(set) var isPlaying = false
    @Published private(set) var seekGeneration = 0

    private let player: AVPlayer
    private var link: CADisplayLink?

    init(player: AVPlayer) {
        self.player = player
    }

    func start() {
        link = CADisplayLink(target: self, selector: #selector(tick))
        link?.add(to: .main, forMode: .common)
    }

    @objc private func tick() {
        time = player.currentTime().seconds       // CMTime, 1 kHz resolution
        rate = player.rate
        isPlaying = player.timeControlStatus == .playing
    }

    func seek(to t: TimeInterval) {
        player.seek(to: CMTime(seconds: t, preferredTimescale: 1000),
                    toleranceBefore: .zero, toleranceAfter: .zero)
        seekGeneration += 1                       // lyrics scroll anchor resets
    }
}

// HiFi / bit-perfect / gapless mode: prefer render-domain time.
// Map the AVAudioEngine render clock to player time so output latency
// (~5–50 ms) is excluded from the lyrics timeline.
extension AudioTimelineClock {
    func renderTime(engine: AVAudioEngine, playerNode: AVAudioPlayerNode) -> TimeInterval? {
        guard let render = engine.outputNode.lastRenderTime,
              let t = playerNode.playerTime(forNodeTime: render) else { return nil }
        return TimeInterval(t.sampleTime) / t.sampleRate
    }
}
```

**Contract:** the sync engine (§5.4.1) consumes `time` and emits `(lineIndex, wordProgress)`. No view reads `player.currentTime()` directly; no `Timer` exists anywhere in the lyrics path.

## 9.5 Spring animation with interruption

```swift
import SwiftUI

// Springs are interruptible by construction: retargeting mid-flight
// continues from the current value instead of restarting (WWDC18 🟢).
struct VolumeKnob: View {
    @Binding var volume: Double
    @State private var isPressed = false

    var body: some View {
        ZStack {
            Circle().fill(.thinMaterial)
            Circle()
                .fill(Color.accentColor)
                .frame(width: 56, height: 56)
                .scaleEffect(isPressed ? 0.92 : 1.0)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in isPressed = true }
                        .onEnded { _ in isPressed = false }
                )
        }
        .animation(
            .interactiveSpring(response: 0.25, dampingFraction: 0.8),
            value: isPressed
        )
    }
}

// Line-focus transition (§6.5): retargetable spring on the visual state.
struct LyricLineState: Equatable {
    var scale: CGFloat
    var opacity: Double
}

// .animation(.spring(response: 0.45, dampingFraction: 0.85), value: state)
```

**Cross-platform equivalent (React Native + reanimated):**

```tsx
import { useSharedValue, withSpring, useFrameCallback } from 'react-native-reanimated'

const progress = useSharedValue(0)
const currentLine = useSharedValue(0)

useFrameCallback(() => {
  'worklet'
  const t = audioClock.currentTime() // audio-clock domain
  const s = syncEngine.stateAt(t)
  progress.value = s.wordProgress
  currentLine.value = withSpring(s.lineIndex, { damping: 14, stiffness: 170 }) // interruptible
})
```

## 9.6 Lyrics data pipeline (server/client contract)

```typescript
// Ingest: parse → validate (§4.4) → normalize (ms → seconds) → index
// Storage: lines sorted; binary-search index (startTime → lineId)
// Delivery: single JSON document per track; partial delivery supported
//   (first N lines streamed while parsing continues — cold-start < 300 ms)
// Client: LyricDocument → LyricsSyncEngine (pure) → renderer (mask/shader)
```

---

# Chapter 10: Design Do / Don't

## DO ✓

- ✓ **Prioritize music.** Artwork and lyrics are the heroes; chrome is transient and recedes.
- ✓ **Keep motion smooth and physical.** Springs, interruption, matched geometry; no linear fades for interactive objects.
- ✓ **Make animation meaningful.** Every animation either explains state (play→pause), origin (sheets from their button), or follows the audio (lyrics, ambient).
- ✓ **Use adaptive materials.** Glass only for controls/navigation; standard materials for content surfaces; honor Reduce Transparency.
- ✓ **Derive everything from the track.** Palette, gradient, accent, ambient motion all come from the audio/artwork — the UI is a function of the music.
- ✓ **Design for the audio clock.** Lyrics, waveform, and scrub preview share one timeline; wall clocks and scroll events are banned as sync inputs.
- ✓ **Respect the user.** Dynamic Type, Reduce Motion, contrast gates, and full accessibility labels on every control.
- ✓ **Let people leave.** Every immersive mode has an obvious, gestural, reversible exit (drag-down, tap, keyboard shortcut).
- ✓ **Keep the brand quiet.** Monochrome controls, one accent, one focal point per screen.
- ✓ **Test in the dark and the bright.** Both light and dark artwork, both appearances, and the worst-case text-over-artwork combination.

## DON'T ✗

- ✗ **Excessive glass.** Glass on content, glass on glass, or glass as decoration — HIG explicitly forbids it. 🟢
- ✗ **Unnecessary animation.** No looping, no idle bounce, no 500 ms welcome choreography; avoid animating anything the user does repeatedly (HIG Motion 🟢).
- ✗ **Information overload.** No more than one primary action per surface; secondary actions live in menus; badges are rare and functional.
- ✗ **Gamification.** No streaks, points, confetti, or achievement popups in a listening surface. The music is the reward.
- ✗ **Beats pulsing the UI.** Do not pulse artwork, buttons, or lyrics to the beat; ambient reactivity stays ≤ 15% of the screen and dies at rest.
- ✗ **Hard-coded values.** No fixed hex colors, no per-device layout, no ad-hoc spacing; tokens and palette-derived colors only.
- ✗ **Scroll-driven lyrics.** Never compute the current line from scroll offset or wall-clock timers (§4.5).
- ✗ **Fighting the system.** No custom edge gestures, no recreated system sheets/pickers, no hijacked back swipe.
- ✗ **Uninterruptible long animations.** Anything > 0.5 s must be cancelable or scrubbable.
- ✗ **Decoration as hierarchy.** If an element needs a border, glow, or badge to stand out, fix the layout instead (WWDC25 356 🟢).

---

# Final Design Checklist

Use as the acceptance gate for every player-surface feature. All items are testable.

## Hierarchy & Layout

- [ ] Exactly one hero element per state; the rest verifiably recedes (screenshot audit).
- [ ] No heavy UI above artwork; controls ≤ 12% of screen area at rest.
- [ ] Spacing only from token scale; layout passes at iPhone SE, 17 Pro Max, iPad, and Mac windowed sizes.
- [ ] Safe areas respected; no custom gesture zones inside system-gesture margins.
- [ ] Portrait, landscape, and (Mac) resizable windows all pass the same hierarchy audit.
- [ ] Dynamic Type: all text scales; no truncation at largest accessibility size; layout stacks when needed.

## Material

- [ ] Glass used only in the Allowed list (§3.3); zero instances in the Forbidden list.
- [ ] One glass variant family per app; no glass-on-glass.
- [ ] Contrast: 4.5:1 text / 3:1 glyphs over worst-case artwork; Clear elements have dimming layer when needed.
- [ ] Reduce Transparency: glass degrades to opaque; appearance (light/dark) adapts to artwork.
- [ ] Scroll edge effects present exactly where floating UI overlaps scrolling content; one per pane.
- [ ] Tint used only for functional emphasis; toolbars monochrome over colorful artwork.

## Lyrics

- [ ] Audio-clock driven; zero `Timer`s or scroll-derived sync in the lyrics path.
- [ ] Word fill linear with audio; fills hold during gaps; seeks retarget instantly.
- [ ] Current line 1.05 / 1.0 / 0 blur; future 0.45; past 0.7; blur never used on lyrics.
- [ ] Tap line = seek; long-press = report sheet; translation/pronunciation modes render independently.
- [ ] Low-confidence timings degrade to line-level mode; missing lyrics degrade to static view.
- [ ] Sync engine covered by golden-snapshot unit tests (normal / seeks / rate 0.5× / gaps).

## Motion

- [ ] All interactive motion uses interruptible springs; press feedback ≤ 60 ms.
- [ ] Matched geometry for mini-player ↔ Now Playing ↔ Lyrics; reverse paths are spatially symmetric.
- [ ] One animation per interaction; feedback animations ≤ 0.5 s.
- [ ] Reduce Motion: springs collapse to ≤ 0.15 s cross-fades; karaoke fill instant.
- [ ] No oscillation at ~0.2 Hz; no motion in peripheral zones in immersive modes (HIG Motion 🟢).

## Audio-Reactive UI

- [ ] All parameters flow through the pipeline (§7.3); nothing random.
- [ ] Reactive surfaces ≤ 15% of screen; amplitude ≤ 6 pt ambient; settle ≤ 400 ms on pause/silence.
- [ ] Palette-derived colors pass contrast gates in light and dark artwork tests.
- [ ] Analysis off when surface hidden; audio path untouched in bit-perfect mode.
- [ ] "Ambient effects" user toggle honored everywhere.

## Engineering & Accessibility

- [ ] One `GlassEffectContainer` per screen; ≤ 4 live glass surfaces.
- [ ] Lyrics render without re-layout (transform/mask only); 60 fps minimum, 120 fps on ProMotion.
- [ ] Every icon has an accessibility label; VoiceOver announces scrub time on release only.
- [ ] Haptics optional and never sole feedback.
- [ ] Performance budget profiled on lowest supported device: no dropped frames during lyrics + glass + waveform simultaneously.

---

# Appendix A: Sources

## Official (🟢)

| Source                                                                                    | Used for                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| HIG — Materials                                                                           | Liquid Glass vs standard materials, Regular/Clear variants, dimming layer, vibrancy        |
| HIG — Motion                                                                              | purposefulness, brevity, cancelability, 0.2 Hz warning                                     |
| HIG — Typography                                                                          | text styles, sizes, weights, Dynamic Type, tracking                                        |
| HIG — Layout                                                                              | grouping, hierarchy, safe areas, size classes, adaptation                                  |
| HIG — Color                                                                               | semantic colors, tinting rules, P3, monochrome-over-colorful guidance                      |
| Liquid Glass — Technology Overview / Adopting Liquid Glass                                | lensing, adaptivity, adoption scope, scroll edge effects, performance                      |
| SwiftUI — Glass, glassEffect, GlassEffectContainer, Applying Liquid Glass to custom views | material APIs, morphing, container constraints                                             |
| WWDC25 Session 219 — Meet Liquid Glass                                                    | lensing, fluidity, variants, glass-on-glass prohibition, tinting, materialization          |
| WWDC25 Session 356 — Get to know the new design system                                    | concentric shapes, functional layer, action-sheet origin, scroll edge effects, continuity  |
| WWDC18 Session 803 — Designing Fluid Interfaces                                           | latency/response, interruption & redirection, spatial consistency, lightweight interaction |
| Apple Newsroom — Apple Music Sing (Dec 6, 2022)                                           | beat-by-beat lyrics, background vocals, duet view                                          |
| Apple Support — See lyrics and sing in Apple Music (105076)                               | line-by-line lyrics, tap-to-jump, translation/pronunciation, report flow                   |
| Apple Design Resources                                                                    | SF Symbols, templates, Icon Composer, color guides                                         |

## Observed (🟡)

- Apple Music Now Playing / lyrics behavior: current-line centering, hold during gaps, instant seek retarget, chrome auto-hide.

## Not publicly disclosed (🔵 / explicitly flagged)

> Apple has not publicly disclosed: exact Liquid Glass numeric parameters; lyric timestamp format/granularity; lyrics scroll physics and word-fill easing; background-vocal rendering; audio-reactive UI implementation (waveform, spectrum, beat sync); album color extraction algorithm. All such values in this document are our engineering spec, derived from Apple's public principles and observable product behavior.

---

_End of spec — ship the restraint, not the glass._
