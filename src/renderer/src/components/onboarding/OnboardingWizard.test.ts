import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const wizard = readFileSync(new URL('./OnboardingWizard.vue', import.meta.url), 'utf8')
const css = readFileSync(new URL('./OnboardingWizard.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')

test('finishing or skipping the wizard always persists the completion flag', () => {
  const flowSource = readFileSync(new URL('./useOnboardingFlow.ts', import.meta.url), 'utf8')
  assert.match(flowSource, /onboardingCompleted: true/)
  assert.match(wizard, /buildSettingsPatch\(choices\.value\)/)
  assert.match(wizard, /emit\('finish'/)
  // The skip button routes through the same finish() so it also persists.
  assert.match(wizard, /class="onb-btn-ghost" @click="finish">\s*\n\s*跳过引导/)
})

test('app gates the wizard on the completion flag plus an empty library unless tray navigation wins', () => {
  assert.match(
    app,
    /!pendingNavigation &&\s*!loadedSettings\.onboardingCompleted &&\s*loadedSettings\.libraryFolders\.length === 0/
  )
  assert.match(app, /<OnboardingWizard v-if="showOnboarding" @finish="handleOnboardingFinish" \/>/)
  assert.match(app, /await updateSettings\(result\.patch\)/)
})

test('the player bar stays hidden while the wizard is on screen', () => {
  const hasPlayerBar = app.match(/const hasPlayerBar = computed\([\s\S]*?\n\)/)?.[0]
  assert.ok(hasPlayerBar, 'hasPlayerBar computed must exist')
  assert.match(hasPlayerBar, /!showOnboarding\.value/)
})

test('settings can relaunch the wizard without a restart', () => {
  const settingsPage = readFileSync(new URL('../SettingsPage.vue', import.meta.url), 'utf8')
  assert.match(settingsPage, /emit\('reopenOnboarding'\)/)
  assert.match(app, /@reopen-onboarding="handleReopenOnboarding"/)
  assert.match(
    app,
    /function handleReopenOnboarding\(\): void \{\s*\n\s*closeSettingsPage\(\)\s*\n\s*showOnboarding\.value = true/
  )
})

test('welcome step offers app background colors and a custom image with live preview', () => {
  const welcome = readFileSync(new URL('./steps/StepWelcome.vue', import.meta.url), 'utf8')
  assert.match(welcome, /THEME_BACKGROUND_PALETTES/)
  assert.match(welcome, /importBackgroundImage/)
  assert.match(welcome, /appBackground\.global\.kind = 'image'/)
  assert.match(welcome, /appBackground\.global\.kind = 'color'/)
  // The wizard shell renders the user's chosen background live…
  assert.match(css, /--onb-bg: var\(--te-app-bg/)
  assert.match(css, /background-image: var\(--te-app-bg-image, none\)/)
  // …and a readability scrim replaces the aurora when an image is active.
  assert.match(wizard, /v-if="hasCustomBackdrop" class="onb-scrim"/)
  assert.match(wizard, /<OnboardingBackdrop v-else \/>/)
})

test('scene transitions and cascades use motion tokens, not hardcoded curves', () => {
  assert.match(css, /--te-ease-out-expo/)
  assert.match(css, /--te-ease-spring/)
  assert.match(css, /--te-motion-settle/)
  assert.doesNotMatch(css, /cubic-bezier\(/)
})

test('wizard chrome derives color from theme tokens instead of brand hex', () => {
  assert.match(css, /--onb-accent: var\(--te-primary-500/)
  assert.match(css, /--onb-accent-rgb: var\(--te-primary-rgb/)
  assert.match(css, /html\[data-theme='dark'\] \.onboarding-wizard/)
})

test('reduced-motion users still see content: cascades fill backwards', () => {
  const cascadeRules = css.match(/animation:[^;]*onb-rise[^;]*;/g) ?? []
  assert.ok(cascadeRules.length > 0)
  for (const rule of cascadeRules) {
    assert.match(rule, /backwards/)
  }
  assert.doesNotMatch(css, /opacity: 0;\s*\n\s*animation/)
})

test('the audio step owns device choice and exclusive mode; system step owns integrations', () => {
  const audio = readFileSync(new URL('./steps/StepAudio.vue', import.meta.url), 'utf8')
  const system = readFileSync(new URL('./steps/StepSystem.vue', import.meta.url), 'utf8')
  assert.match(audio, /useAudioOutputDspStore/)
  assert.match(audio, /setAudioDevice/)
  assert.match(audio, /refreshAudioOutputState/)
  assert.match(audio, /audioExclusiveMode/)
  // Exclusive stays disabled when the active backend cannot honor it.
  assert.match(audio, /:disabled="!exclusiveAvailable"/)
  assert.doesNotMatch(system, /audioExclusiveMode/)
  assert.match(system, /globalShortcuts/)
  assert.match(system, /smtcEnabled/)
  assert.match(system, /discordRpcEnabled/)
  assert.match(wizard, /<StepAudio/)
})

test('the local step offers online lyric fallback without enabling it silently', () => {
  const local = readFileSync(new URL('./steps/StepLocal.vue', import.meta.url), 'utf8')
  assert.match(local, /onlineLyricsFallback/)
  assert.match(local, /缺歌词时联网补齐/)
  assert.match(wizard, /v-model:online-lyrics-fallback="choices\.onlineLyricsFallback"/)
})

test('the player step owns bar shape and mini-player taskbar behavior', () => {
  const player = readFileSync(new URL('./steps/StepPlayer.vue', import.meta.url), 'utf8')
  assert.match(player, /playerBar\.mode/)
  assert.match(player, /visibility/)
  assert.match(player, /showInTaskbar/)
  assert.match(player, /alwaysOnTop/)
  assert.match(player, /openOnFinish/)
  assert.match(wizard, /<StepPlayer/)
  assert.match(wizard, /v-model:player-bar="choices\.playerBar"/)
  assert.match(wizard, /v-model:mini-player="choices\.miniPlayer"/)
})

test('the system step exposes close behavior and taskbar control', () => {
  const system = readFileSync(new URL('./steps/StepSystem.vue', import.meta.url), 'utf8')
  assert.match(system, /closeWindowBehavior/)
  assert.match(system, /taskbarThumbarButtonsEnabled/)
  assert.match(system, /miniPlayer/)
  assert.match(wizard, /v-model:close-window-behavior="choices\.closeWindowBehavior"/)
  assert.match(
    wizard,
    /v-model:taskbar-thumbar-buttons-enabled="choices\.taskbarThumbarButtonsEnabled"/
  )
})

test('finishing can hand off to the plugin market, but login wins', () => {
  const streaming = readFileSync(new URL('./steps/StepStreaming.vue', import.meta.url), 'utf8')
  assert.match(streaming, /wantsPluginMarket/)
  assert.match(streaming, /cachePolicy\.streamingAudio/)
  assert.match(wizard, /v-model:cache-policy="choices\.cachePolicy"/)
  assert.match(
    wizard,
    /openPluginMarket: choices\.value\.usage !== null && choices\.value\.wantsPluginMarket/
  )
  assert.match(app, /else if \(result\.openPluginMarket\) \{/)
  assert.match(wizard, /openMiniPlayer:/)
  assert.match(app, /await window\.api\.miniPlayer\.open\(\)/)
})

test('the finish scene reports live scan progress and offers desktop lyrics', () => {
  const finish = readFileSync(new URL('./steps/StepFinish.vue', import.meta.url), 'utf8')
  assert.match(finish, /libraryScanProgress/)
  assert.match(
    finish,
    /window\.api\.desktopLyrics\.setEnabled\(!settings\.value\.desktopLyrics\.enabled\)/
  )
  assert.match(finish, /updateSettings\(\{ desktopLyrics:/)
})

test('blur-sensitive effects honor the global no-blur escape hatch', () => {
  assert.match(css, /body\.te-no-blur \.onb-blob/)
  assert.match(css, /body\.te-no-blur \.onb-card/)
  assert.match(css, /body\.te-no-blur \.onb-fwd-enter-from/)
  assert.match(app, /body\.te-no-blur \.onboarding-page-leave-to/)
})
