import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

test('now playing lyrics do not surface original/translated source path chips', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /const lyricSourceLabel = computed/)
  assert.doesNotMatch(source, /const translatedLyricSourceLabel = computed/)
  assert.doesNotMatch(source, /class="lyric-source-chip"/)
  assert.doesNotMatch(source, /lyric-source-chips/)
  assert.match(source, /currentTrack\.value\?\.lyricsSource/)
  assert.match(source, /currentTrack\.value\?\.translatedLyricsSource/)
})

test('now playing keeps lyric source controls in the player bar sidebar', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /class="lyric-source-controls"/)
  assert.doesNotMatch(source, /class="lyric-translation-toggle"/)
})

test('now playing lyrics never reveal the global auto-hide scrollbar', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const lyricsScroll = source.match(/\.lyrics-scroll \{[\s\S]*?\n\}/)?.[0] ?? ''
  const webkitScrollbar =
    source.match(/\.lyrics-scroll::-webkit-scrollbar \{[\s\S]*?\n\}/)?.[0] ?? ''
  const webkitThumb =
    source.match(/\.lyrics-scroll::-webkit-scrollbar-thumb \{[\s\S]*?\n\}/)?.[0] ?? ''

  assert.match(lyricsScroll, /scrollbar-width: none !important/)
  assert.match(webkitScrollbar, /display: none !important/)
  assert.match(webkitThumb, /background: transparent !important/)
})

test('now playing lyrics have no page-entry animation', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /te-playing-lyrics-arrive/)
})

test('visualizer mode does not keep the heavy blurred backdrop mounted', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')

  assert.match(source, /<div v-if="viewMode !== 'visualizer'" class="backdrop"/)
})

test('active lyrics keep their size while auxiliary layers render smaller and compact', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const lyricLine = readFileSync(new URL('./PlayingLyricLine.vue', import.meta.url), 'utf8')
  const mainStyle = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
  const activeRow = source.match(/\.lyric-row\.active \{[\s\S]*?\n\}/)?.[0] ?? ''
  const activeText = source.match(/\.lyric-row\.active \.lyric-text \{[\s\S]*?\n\}/)?.[0] ?? ''
  const lyricText = source.match(/\.lyric-text \{[\s\S]*?\n\}/)?.[0] ?? ''
  const translationText = source.match(/\.lyric-translation \{[\s\S]*?\n\}/)?.[0] ?? ''
  const themeInvariant =
    mainStyle.match(
      /html body \.playing-music button\.lyric-row\.active:not\(\.lyric-row--custom-background\) \{[\s\S]*?\n\}/
    )?.[0] ?? ''

  assert.doesNotMatch(activeRow, /transform: scale/)
  assert.match(activeRow, /background:\s*var\(--lyric-style-background, transparent\)/)
  assert.match(activeRow, /border-color: var\(--te-playback-lyric-active-border, transparent\)/)
  assert.match(activeRow, /box-shadow: var\(--te-playback-lyric-active-shadow, none\)/)
  assert.doesNotMatch(activeRow, /linear-gradient/)
  assert.match(
    lyricText,
    /font-size:\s*clamp\(\s*12px,\s*var\(--lyric-style-font-size, var\(--te-lyric-font-size, 18px\)\),\s*48px\s*\)/
  )
  assert.doesNotMatch(activeText, /font-size:/)
  assert.match(translationText, /font-size:\s*var\(--lyric-style-font-size, 14px\)/)
  const auxiliaryStyles = lyricLine.match(/\.lyric-translation \{[\s\S]*?\n\}/)?.[0] ?? ''
  const voiceAuxiliaryStyles =
    lyricLine.match(
      /\.lyric-voice-translation,\s*\.lyric-voice-romanization \{\s*width: 100%;\s*padding: 0;[\s\S]*?\n\}/
    )?.[0] ?? ''
  assert.match(auxiliaryStyles, /font-size:\s*var\(--lyric-style-font-size, 14px\)/)
  assert.match(auxiliaryStyles, /line-height:\s*var\(--lyric-style-line-height, 1\.3\)/)
  assert.match(auxiliaryStyles, /margin-top:\s*max\(2px/)
  assert.match(voiceAuxiliaryStyles, /font-size:\s*var\(--lyric-style-font-size, 14px\)/)
  assert.match(voiceAuxiliaryStyles, /line-height:\s*var\(--lyric-style-line-height, 1\.3\)/)
  assert.match(
    activeText,
    /font-weight: var\(--lyric-style-font-weight, var\(--te-lyric-font-weight, 600\)\)/
  )
  assert.match(activeText, /text-shadow:/)
  assert.match(source, /:deep\(\.lyric-word\) \{[\s\S]*display: inline-block/)
  // The sweep masks the word itself now. The old duplicated `::after` text layer
  // is gone, so the fill cannot drift out of register with the glyphs it reveals.
  assert.doesNotMatch(source, /:deep\(\.lyric-word\)::after/)
  assert.doesNotMatch(source, /--lyric-word-highlight-opacity|--lyric-word-progress/)
  assert.match(source, /--lyric-bright-mask-alpha/)
  assert.match(source, /--lyric-dark-mask-alpha/)
  assert.doesNotMatch(source, /transition: clip-path 250ms linear/)
  assert.match(themeInvariant, /background: transparent !important/)
  assert.match(themeInvariant, /background-image: none !important/)
  assert.match(themeInvariant, /border-color: transparent !important/)
  assert.match(themeInvariant, /box-shadow: none !important/)
  assert.match(themeInvariant, /backdrop-filter: none !important/)
  assert.match(themeInvariant, /-webkit-backdrop-filter: none !important/)
})

test('now playing exposes independent lyric customization with live persisted preview', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const customizer = readFileSync(
    new URL('./LyricsAppearanceCustomizer.vue', import.meta.url),
    'utf8'
  )
  const editor = readFileSync(
    new URL('../composables/useLyricsAppearanceEditor.ts', import.meta.url),
    'utf8'
  )
  const appearance = readFileSync(
    new URL('../../../shared/lyricsAppearance.ts', import.meta.url),
    'utf8'
  )

  assert.match(source, /import LyricsAppearanceCustomizer/)
  assert.match(source, /个性化歌词/)
  // Each target keeps its own style object, but the per-row bindings read cached
  // computeds instead of calling lyricStyleVars() again for every rendered line.
  assert.match(source, /:style="item\.singing \? lyricRowStyleActive : lyricRowStyleNormal"/)
  assert.match(source, /:translation-style="lyricTranslationStyle"/)
  assert.match(source, /:romanization-style="lyricRomanizationStyle"/)
  assert.match(source, /:harmony-style="lyricHarmonyStyle"/)
  for (const target of ['active', 'normal', 'translation', 'romanization', 'harmony']) {
    assert.match(
      source,
      new RegExp(`computed\\(\\(\\) => lyricStyleVars\\('${target}'\\)\\)`),
      `${target} lyric styling must still resolve through lyricStyleVars`
    )
  }
  assert.match(source, /:align="lyricLineAlign\(item\.singing\)"/)
  assert.match(source, /lyricTextStyle\.value\[target\]\.align/)
  assert.doesNotMatch(source, /lyricAlignClass|lyricsAppearance\.value\.align|lyric-align-left/)
  assert.match(source, /resolveLyricsFontFamily\(appearance\.styles\.active\)/)
  assert.doesNotMatch(source, /customFontFamily:\s*''/)
  assert.match(source, /font-family: var\(--te-lyric-font-family, inherit\)/)
  assert.match(customizer, /普通歌词/)
  assert.match(customizer, /当前歌词/)
  assert.match(customizer, /翻译歌词/)
  assert.match(customizer, /附属歌词/)
  assert.match(customizer, /罗马音/)
  assert.match(customizer, /showRomanization/)
  assert.match(customizer, /updateVisibility\(\{ showRomanization:/)
  assert.match(customizer, /实时预览/)
  assert.match(customizer, /恢复全部默认/)
  // The editing surface is shared so the drawer, settings page and playbar panel
  // cannot drift apart again; the debounce and the persist call live there.
  assert.match(customizer, /useLyricsAppearanceEditor\(\)/)
  assert.match(editor, /const SAVE_DEBOUNCE_MS = 180/)
  assert.match(editor, /updateSettings\(\{[\s\S]*lyricsAppearance: cloneLyricsAppearance/)
  assert.match(customizer, /@media \(max-width: 620px\)/)
  assert.match(appearance, /styles: Record<LyricsStyleTarget, LyricsTextStyle>/)
  assert.match(appearance, /backgroundStyle: LyricsBackgroundStyle/)
  assert.match(appearance, /highlightEffect: LyricsHighlightEffect/)
})

test('lyrics customizer survives slider drags while embedded in the HiFi sidebar', () => {
  const customizer = readFileSync(
    new URL('./LyricsAppearanceCustomizer.vue', import.meta.url),
    'utf8'
  )
  const sidebar = readFileSync(new URL('./player-bar/HiFiSidebar.vue', import.meta.url), 'utf8')
  const manager = readFileSync(
    new URL('./player-bar/LyricsManagerPanel.vue', import.meta.url),
    'utf8'
  )
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')

  // The panel is Teleported to <body>, so the PlayerBar's document-level
  // pointerdown listener (useFloatingPanels) would otherwise misread any
  // interaction inside as an outside click and close the floating drawer,
  // unmounting this panel mid-drag. `.stop` keeps the event from bubbling up.
  assert.match(customizer, /@pointerdown\.stop/)
  assert.match(customizer, /@pointerdown\.self="emit\('close'\)"/)

  // The backdrop stays clear (no blur, no scrim) so adjusting a control lets
  // the user watch the lyrics respond live underneath.
  const shell = customizer.match(/\.lyrics-customizer-shell \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.doesNotMatch(shell, /backdrop-filter/)
  assert.match(shell, /background:\s*transparent/)

  // The sidebar now embeds the panel itself instead of navigating to Settings.
  assert.match(
    sidebar,
    /import LyricsAppearanceCustomizer from '\.\.\/LyricsAppearanceCustomizer\.vue'/
  )
  assert.match(sidebar, /<LyricsAppearanceCustomizer/)
  assert.match(sidebar, /lyricsCustomizerOpen/)
  assert.doesNotMatch(sidebar, /当前歌词高光|toggleLyricHighlight|lyricHighlightOn/)
  assert.doesNotMatch(manager, /lyric-style-controls|updateLyricsAppearance|LYRICS_RANGES/)
  assert.doesNotMatch(playerBar, /toggleLyricHighlight|lyricHighlightOn/)
})

test('the HiFi deck stands down while the lyrics customizer is open', () => {
  const sidebar = readFileSync(new URL('./player-bar/HiFiSidebar.vue', import.meta.url), 'utf8')
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')

  // The deck occupies the right of the window, directly over the lyrics the
  // customizer exists to tune, so it steps aside while the drawer is open.
  assert.match(sidebar, /lyricsCustomizing: \[open: boolean\]/)
  assert.match(
    sidebar,
    /watch\(lyricsCustomizerOpen, \(open\) => emit\('lyricsCustomizing', open\)\)/
  )
  assert.match(playerBar, /@lyrics-customizing="lyricsCustomizerActive = \$event"/)
  assert.match(playerBar, /'is-lyrics-customizing': lyricsCustomizerActive/)
  // Closing the deck by any route (outside click, toggle) must clear the flag,
  // or reopening it would come back already invisible.
  assert.match(playerBar, /if \(!open\) lyricsCustomizerActive\.value = false/)

  // The deck may only be *hidden*: the customizer is Teleported from inside it,
  // so dropping the `v-if` would unmount the drawer along with the deck.
  assert.match(playerBar, /v-if="moreOpen"[\s\S]{0,120}is-lyrics-customizing/)

  const standDown = css.match(/\.hifi-overlay\.is-lyrics-customizing \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(standDown, /opacity: 0/)
  assert.match(standDown, /pointer-events: none/)
  // `visibility: hidden` is what takes the deck's focusables out of the tab
  // order; opacity alone would leave 40-odd invisible controls reachable.
  assert.match(standDown, /visibility: hidden/)
})

test('font size is per layer, with an explicit action to unify it', () => {
  const editor = readFileSync(
    new URL('../composables/useLyricsAppearanceEditor.ts', import.meta.url),
    'utf8'
  )
  const appearance = readFileSync(
    new URL('../../../shared/lyricsAppearance.ts', import.meta.url),
    'utf8'
  )
  const normalize = appearance.match(/export function normalizeLyricsAppearance[\s\S]*?\n\}/)?.[0]

  assert.ok(normalize)
  // Schema 2 overwrote every layer's size on every save. Unifying is now a
  // deliberate action, so normalization must not silently flatten them again.
  assert.doesNotMatch(normalize, /normal: \{ \.\.\.normalStyle, fontSize \}/)
  assert.match(editor, /function syncFontSizeToAll\(\): void/)
  assert.match(
    editor,
    /syncLegacyLyricsAppearance\(draft\.value, \{ fontSize: style\.value\.fontSize \}\)/
  )
})

test('TTML alignment exposes only left and center while preserving ordinary right alignment', () => {
  const customizer = readFileSync(
    new URL('./LyricsAppearanceCustomizer.vue', import.meta.url),
    'utf8'
  )
  const playingLine = readFileSync(new URL('./PlayingLyricLine.vue', import.meta.url), 'utf8')
  const wordChunks = readFileSync(new URL('../utils/lyricWordChunks.ts', import.meta.url), 'utf8')

  assert.match(customizer, /isCurrentTtml[\s\S]*option\.value !== 'right'/)
  assert.match(customizer, /constrainLyricsAlignment\(style\.value\.align, isCurrentTtml\.value\)/)
  assert.match(playingLine, /\.lyric-text[\s\S]*text-align: var\(--lyric-style-align, inherit\)/)
  assert.match(playingLine, /\.lyric-row-content \{[\s\S]*align-items: stretch;/)
  assert.doesNotMatch(
    readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8'),
    /^\.lyric-row-content \{/m
  )
  assert.match(wordChunks, /split\(\/\(\\s\+\)\/u\)/)
})

test('lyrics keep the full timeline mounted while the viewport follows the active row', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const line = readFileSync(new URL('./PlayingLyricLine.vue', import.meta.url), 'utf8')
  const renderedLines = source.match(/const renderedLyricLines = computed\([\s\S]*?\n\)/)?.[0] ?? ''

  assert.match(
    source,
    /import \{ createLyricViewportController \} from '\.\.\/utils\/lyricViewportController'/
  )
  assert.match(renderedLines, /displayLyricLines\.value\.map/)
  // Focus mode is a layout concern: the window collapses rows, it never unmounts
  // them, so springs and measured heights survive a line leaving the window.
  assert.doesNotMatch(renderedLines, /getLyricFocusLineIndices|lyricFocusWindow/)
  assert.match(source, /getFocusWindow: \(\) => lyricFocusWindow\.value/)
  assert.doesNotMatch(source, /lyricLeavingIndex|lyricEnteringIndex/)
  assert.match(source, /<PlayingLyricLine/)
  assert.match(line, /class="lyric-row-content"/)
  assert.match(source, /@wheel\.passive="onLyricsManualScroll"/)
  assert.match(source, /@touchstart\.passive="onLyricsTouchStart"/)
  assert.match(source, /@touchmove\.passive="onLyricsTouchMove"/)
  assert.doesNotMatch(source, /@pointerdown="onLyricsManualScroll"/)
})

test('clicking a timed lyric releases manual scroll lock before seeking', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const jumpToLyric = source.match(
    /function jumpToLyric\(time: number \| null\): void \{[\s\S]*?\n\}/
  )?.[0]

  assert.ok(jumpToLyric)
  assert.match(jumpToLyric, /lyricViewport\.releaseManualBrowse\(\)/)
  assert.match(jumpToLyric, /seek\(Math\.max\(0, time - currentLyricOffsetSeconds\.value\)\)/)
  assert.match(source, /class="lyric-row"[\s\S]*@pointerdown\.stop[\s\S]*@click="jumpToLyric/)
})

test('now playing isolates high-frequency playhead updates from the full lyrics list', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const line = readFileSync(new URL('./PlayingLyricLine.vue', import.meta.url), 'utf8')
  const words = readFileSync(new URL('./PlayingLyricWords.vue', import.meta.url), 'utf8')
  const timeChip = readFileSync(new URL('./PlayingMusicTimeChip.vue', import.meta.url), 'utf8')

  assert.match(source, /lyricsLoadState\.value\.status === 'loading'/)
  assert.match(
    source,
    /watch\(\s*\[lyricLines, playbackClockSnapshot, currentLyricOffsetSeconds\],/
  )
  assert.doesNotMatch(source, /predictedLyricTime|scheduleLyricIndexBoundary|lyricIndexTimer/)
  assert.match(source, /snapshot: playbackClockSnapshot/)
  assert.match(source, /<PlayingLyricLine[\s\S]*:clock="lyricWordClock"/)
  assert.match(line, /<PlayingLyricWords[\s\S]*:clock="clock"/)
  assert.match(source, /lyrics-column--karaoke-disabled/)
  assert.match(source, /<PlayingMusicTimeChip/)
  assert.doesNotMatch(source, /formatTime\(currentTime\)/)
  assert.doesNotMatch(source, /findActiveWordIndex/)
  assert.doesNotMatch(words, /usePlayerStore/)
  assert.match(words, /snapshot: Ref<LyricClockSnapshot>/)
  assert.match(words, /isPlaying: Ref<boolean>/)
  assert.match(words, /positionAt: \(at\?: number\) => number/)
  assert.match(words, /karaokeEnabled: boolean/)
  assert.doesNotMatch(words, /nextLineTime|reachNextLine|clockAnchorPosition|bindPlaybackClock/)
  assert.match(words, /requestAnimationFrameWithFallback/)
  // Karaoke fill and emphasis are precomputed keyframes handed to the compositor,
  // not CSS variables rewritten every frame. Assert the property that matters:
  // no per-frame main-thread work, and a seek is a single currentTime assignment.
  assert.match(words, /\.animate\(/)
  assert.doesNotMatch(words, /setWordProgress|--lyric-word-progress|dataset\.progressing/)
  assert.match(words, /animation\.currentTime = boundedTarget/)
  assert.match(words, /animationEndTime\(animation\)/)
  assert.match(source, /contain-intrinsic-size: auto 4em/)
  assert.match(words, /buildKaraokeMaskPlan\(/)
  assert.match(words, /buildEmphasisAnimation\(/)
  assert.match(words, /data-word-text/)
  assert.doesNotMatch(words, /findActiveWordIndex|activeWordIndex|lyric-word--active/)
  assert.doesNotMatch(source, /lyric-word--active|te-lyric-word-pulse/)
  assert.match(timeChip, /const \{ currentTime, duration, formatTime \} = usePlayerStore\(\)/)
})

test('now playing and player bar share the same playback singleton', () => {
  const nowPlaying = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')

  assert.match(nowPlaying, /import \{ usePlayerStore \} from '\.\.\/stores\/usePlayerStore'/)
  assert.doesNotMatch(nowPlaying, /usePlaybackQueueStore/)
  assert.match(playerBar, /import \{ usePlayerStore \} from '\.\.\/stores\/usePlayerStore'/)
})

test('renderer playback consumers cannot retain a second playback state after hot reload', () => {
  const playbackConsumers = [
    './AudioVisualizerPanel.vue',
    './LocalDashboard.vue',
    './PlayingMusic.vue',
    './PlayerBar.vue',
    './settings-page/PlaybackSettingsSection.vue',
    './SongList.vue',
    './StreamingPage.vue',
    './player-bar/LyricsManagerPanel.vue'
  ]

  for (const component of playbackConsumers) {
    const source = readFileSync(new URL(component, import.meta.url), 'utf8')
    assert.match(source, /import \{[\s\S]*?usePlayerStore[\s\S]*?\} from /, component)
    assert.doesNotMatch(source, /usePlaybackQueueStore/, component)
  }
})

test('player bar artist is a keyboard-accessible navigation button', () => {
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
  const style = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')

  assert.match(playerBar, /openArtist: \[\]/)
  assert.match(
    playerBar,
    /<button[\s\S]*?class="player-artist"[\s\S]*?@click\.stop="onArtistClick"/
  )
  assert.match(playerBar, /emit\('openArtist'\)/)
  assert.match(style, /\.player-artist:not\(:disabled\):focus-visible/)
  assert.match(app, /@open-artist="handlePlayerBarArtistClick"/)
  assert.match(app, /onSelectView\('artists', `artist:\$\{trackArtist\}`\)/)
  assert.match(app, /:artist-navigation-request="streamingArtistRequest"/)
})

test('player bar artist navigation carries the provider artist id', () => {
  const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')

  // 同名歌手只能靠 provider 歌手 id 区分。展示串与曲目 artists 对不上时
  // getPrimaryStreamingArtistId 返回 undefined，请求才退回按名字搜索。
  assert.match(app, /getPrimaryStreamingArtistId\(trackArtist, track\.artists\)/)
  assert.match(app, /\.\.\.\(artistId !== undefined \? \{ artistId \} : \{\}\)/)
})

test('player bar remounts the progress control for every queue entry', () => {
  const source = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')

  assert.match(
    source,
    /:key="`progress:\$\{currentTrack\.id\}:\$\{currentTrack\.queueEntryId \|\| ''\}`"/
  )
})

test('player bar smooths progress between player store ticks and snaps large jumps', () => {
  const source = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')

  assert.match(source, /useSmoothedValue\(progressPercent, \{\s*tau: 160,\s*snapThreshold: 2\.5/)
  assert.match(
    source,
    /transform: `scaleX\(\$\{Math\.min\(100, Math\.max\(0, smoothedProgressPercent\.value\)\) \/ 100\}\)`/
  )
})

test('visualizer mode uses a full viewport stage without changing the regular stage cap', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')

  assert.match(source, /class="\['stage', \{ 'stage--visualizer': viewMode === 'visualizer' \}\]"/)
  assert.match(source, /\.stage \{[\s\S]*width: min\(100%, 1560px\)/)
  assert.match(source, /\.stage--visualizer \{[\s\S]*width: 100vw/)
  assert.match(source, /\.stage--visualizer \{[\s\S]*height: 100vh/)
  assert.match(source, /\.stage--visualizer \{[\s\S]*max-width: none/)
  assert.match(source, /\.stage--visualizer \{[\s\S]*padding: 0/)
  assert.match(source, /\.stage--visualizer \{[\s\S]*margin: 0/)
})

test('visualizer toggle sits top-left with the frosted time-chip style', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')

  assert.match(
    source,
    /:class="\{ 'visualizer-toggle-button--close': viewMode === 'visualizer' \}"/
  )
  assert.match(source, /\.visualizer-toggle-button \{[\s\S]*top: 42px[\s\S]*left: 42px/)
  assert.match(source, /\.visualizer-toggle-button \{[\s\S]*border-radius: 999px/)
  assert.match(
    source,
    /\.visualizer-toggle-button \{[\s\S]*background: var\(--te-playback-control-surface, rgba\(255, 255, 255, 0\.08\)\)/
  )
  assert.match(
    source,
    /\.visualizer-toggle-button \{[\s\S]*border: 1px solid var\(--te-playback-control-border, rgba\(255, 255, 255, 0\.1\)\)/
  )
  assert.match(source, /\.visualizer-toggle-button--close \{[\s\S]*z-index: 10000/)
  assert.doesNotMatch(source, /\.visualizer-toggle-button--close\s*\{[^}]*\b(?:top|left|right)\s*:/)
  assert.match(
    source,
    /\.visualizer-toggle-button--close:hover \{[\s\S]*background: var\(--te-playback-control-hover-surface, rgba\(255, 255, 255, 0\.14\)\)/
  )
  assert.doesNotMatch(source, /\.visualizer-toggle-button--close \{[^}]*border-radius: 0/)
  assert.doesNotMatch(source, /title-bar-left-controls/)
  assert.doesNotMatch(source, /lyric-manage-button/)
  assert.doesNotMatch(source, /lyric-manager-backdrop/)
})

test('playbar lyrics section hosts the lyrics manager panel', () => {
  const sidebar = readFileSync(new URL('./player-bar/HiFiSidebar.vue', import.meta.url), 'utf8')
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
  const panel = readFileSync(
    new URL('./player-bar/LyricsManagerPanel.vue', import.meta.url),
    'utf8'
  )

  assert.match(sidebar, /import LyricsManagerPanel from '\.\/LyricsManagerPanel\.vue'/)
  assert.match(sidebar, /<LyricsManagerPanel \/>/)
  assert.match(panel, /class="lyric-manager lyric-manager--panel"/)
  assert.match(panel, /保存歌词/)
  assert.match(panel, /导入 LRC/)
  assert.match(sidebar, /class="deck-lyric-source-controls"/)
  assert.match(sidebar, /:value="originalLayerSelection"/)
  assert.match(sidebar, /:value="translationLayerSelection"/)
  assert.match(sidebar, /@click="emit\('toggleTranslationVisibility'\)"/)
  assert.match(playerBar, /:show-translation="showTranslation"/)
  assert.match(playerBar, /@set-lyric-layer-selection="setLyricLayerSelection"/)
  assert.match(playerBar, /@toggle-translation-visibility="toggleTranslationVisibility"/)
})

test('the HiFi signal path reports runtime DSP state instead of the configured master switch', () => {
  const sidebar = readFileSync(new URL('./player-bar/HiFiSidebar.vue', import.meta.url), 'utf8')
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')

  assert.match(sidebar, /dspActive\?: boolean/)
  assert.match(sidebar, /const dspRuntimeActive = computed\(\(\) => props\.dspActive === true\)/)
  assert.match(
    sidebar,
    /if \(dspRuntimeActive\.value\) return \{ label: 'ENGAGED',[\s\S]*if \(dspMasterOn\.value\) return \{ label: 'STANDBY'/
  )
  assert.match(sidebar, /<em>\{\{ dspSignalState\.label \}\}<\/em>/)
  assert.match(sidebar, /处理链已开启 · 当前直通旁路/)
  assert.doesNotMatch(sidebar, /<em>\{\{ dspMasterOn \? 'ENGAGED' : 'BYPASS' \}\}<\/em>/)
  assert.match(playerBar, /:dsp-active="playbackInfo\?\.dspActive === true"/)
})

test('desktop lyrics window exposes concise song metadata on hover', () => {
  const app = readFileSync(
    new URL('../desktop-lyrics/DesktopLyricsApp.vue', import.meta.url),
    'utf8'
  )

  assert.match(app, /track\.artist \? `\$\{track\.title\} · \$\{track\.artist\}`/)
  assert.match(app, /v-if="songLabel" class="dl-song-label" :title="songLabel"/)
  assert.doesNotMatch(app, /lyricsSource|translatedLyricsSource/)
})

test('phase four layouts only rearrange the existing cover and lyrics instances', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')

  for (const layout of ['full-cover', 'lyrics-focus', 'split', 'minimal']) {
    assert.match(source, new RegExp(`data-te-player-layout='${layout}'`))
  }
  assert.match(source, /@media \(max-width: 1120px\)[\s\S]*data-te-player-layout='split'/)
  assert.match(
    source,
    /data-te-player-layout='minimal'\]\[data-te-visible-player-album-artist='true'\]/
  )
  assert.equal(source.match(/<CoverImg/g)?.length, 2)
  assert.equal(source.match(/class="lyrics-scroll"/g)?.length, 1)
  assert.doesNotMatch(source, /usePlaybackQueueStore/)
})

test('player visibility selectors target stable controls and remove hidden buttons from layout', () => {
  const component = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
  const style = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')

  for (const className of [
    'previous-button',
    'next-button',
    'track-menu-button',
    'player-misc-icon',
    'player-artwork-slot'
  ]) {
    assert.match(component, new RegExp(className))
  }
  assert.match(style, /data-te-visible-previous-button='false'[\s\S]*display: none/)
  assert.match(style, /data-te-visible-next-button='false'/)
  assert.match(style, /data-te-visible-player-track-menu='false'/)
  assert.match(style, /data-te-visible-player-waveform='false'/)
})

test('player volume control opens the volume drawer without toggling mute', () => {
  const source = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /toggleMute/)
  assert.doesNotMatch(source, /onVolumeButtonClick/)
  assert.match(source, /class="[^"]*volume-control-button[^"]*"[\s\S]*@click="toggleVolume"/)
  assert.match(source, /aria-label="音量控制"/)
  assert.match(source, /:aria-expanded="volumeOpen"/)
  assert.doesNotMatch(source, /volume-control-chevron/)
  assert.doesNotMatch(source, /pi-angle-up/)
})
