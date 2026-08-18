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

test('active and translated lyrics preserve the configured font size without a glass surface', () => {
  const source = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
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
  assert.match(
    translationText,
    /font-size:\s*clamp\(\s*12px,\s*var\(--lyric-style-font-size, var\(--te-lyric-font-size, 18px\)\),\s*48px\s*\)/
  )
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
  assert.match(source, /:style="lyricStyleVars\(item\.singing \? 'active' : 'normal'\)"/)
  assert.match(source, /:translation-style="lyricStyleVars\('translation'\)"/)
  assert.match(source, /:romanization-style="lyricStyleVars\('romanization'\)"/)
  assert.match(source, /resolveLyricsFontFamily\(appearance\.styles\.active\)/)
  assert.doesNotMatch(source, /customFontFamily:\s*''/)
  assert.match(source, /font-family: var\(--te-lyric-font-family, inherit\)/)
  assert.match(customizer, /普通歌词/)
  assert.match(customizer, /当前歌词/)
  assert.match(customizer, /翻译歌词/)
  assert.match(customizer, /罗马音/)
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
    /width: `\$\{Math\.min\(100, Math\.max\(0, smoothedProgressPercent\.value\)\)\}%`/
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

test('desktop lyrics html exposes lyric source metadata on hover', () => {
  const source = readFileSync(
    new URL('../../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )

  assert.match(source, /function lyricSourceLabel\(source\)/)
  assert.match(source, /data\.lyricsSource/)
  assert.match(source, /data\.translatedLyricsSource/)
  assert.match(source, /sourceLabel/)
  assert.match(source, /songInfoEl\.title = sourceLabel/)
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
