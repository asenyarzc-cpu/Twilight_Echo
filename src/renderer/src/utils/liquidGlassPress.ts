import { LyricSpring, type LyricSpringParams } from './lyricSpring.ts'

/**
 * Press "squish" for liquid glass surfaces.
 *
 * Apple's material visibly flexes under the finger: the surface compresses toward
 * the press point and relaxes with a little life when released. The scale spring
 * is built on the same analytic spring the lyric cascade uses, so a press that is
 * released mid-flight keeps its velocity instead of restarting from rest — the
 * interaction stays interruptible the way the rest of the pointer pipeline is.
 */

/** Target scale while pressed; release returns to 1. */
export const LIQUID_GLASS_PRESS_TARGET_SCALE = 0.96

/** Fast attack with a whisper of overshoot as the press lands. */
const PRESS_SPRING: Partial<LyricSpringParams> = { mass: 1, stiffness: 420, damping: 34 }
/** Release settles without crossing; the material relaxes instead of bouncing. */
const RELEASE_SPRING: Partial<LyricSpringParams> = { mass: 1, stiffness: 260, damping: 38 }

export interface LiquidGlassPressState {
  scale: number
  /** 1 at full press, 0 at rest; drives the press bloom alongside the scale. */
  glow: number
  settled: boolean
}

/** How far the spring has travelled from rest toward the pressed scale. */
export function resolvePressGlow(scale: number): number {
  const span = 1 - LIQUID_GLASS_PRESS_TARGET_SCALE
  const progress = (1 - scale) / span
  return Math.min(1, Math.max(0, progress))
}

/** Element-scoped variables consumed by the surface CSS. */
export function liquidGlassPressCssVariables(scale: number): Record<string, string> {
  return {
    '--te-lg-press-scale': scale.toFixed(4),
    '--te-lg-press-glow': resolvePressGlow(scale).toFixed(3)
  }
}

export class LiquidGlassPressController {
  private spring: LyricSpring

  constructor() {
    this.spring = new LyricSpring(1, RELEASE_SPRING)
  }

  press(): void {
    this.spring.updateParams(PRESS_SPRING)
    this.spring.setTargetPosition(LIQUID_GLASS_PRESS_TARGET_SCALE)
  }

  release(): void {
    this.spring.updateParams(RELEASE_SPRING)
    this.spring.setTargetPosition(1)
  }

  /** Jump to rest with no animation (reduced motion, cancel, teardown). */
  reset(): void {
    this.spring.setPosition(1)
  }

  isPressed(): boolean {
    return this.spring.getTargetPosition() === LIQUID_GLASS_PRESS_TARGET_SCALE
  }

  /** `deltaSeconds` advances the spring; returns the state to write this frame. */
  update(deltaSeconds: number): LiquidGlassPressState {
    this.spring.update(deltaSeconds)
    const scale = this.spring.getCurrentPosition()
    return { scale, glow: resolvePressGlow(scale), settled: this.spring.arrived() }
  }
}
