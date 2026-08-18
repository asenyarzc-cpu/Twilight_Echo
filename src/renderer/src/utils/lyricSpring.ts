export interface LyricSpringParams {
  mass: number
  damping: number
  stiffness: number
  soft: boolean
}

/**
 * Apple Music moves each lyric line on its own spring. Reproducing that needs
 * two properties the previous per-frame Euler integrator could not offer:
 *
 * 1. Retargeting mid-flight must carry the current velocity, so a line that is
 *    already travelling keeps its momentum instead of restarting from rest.
 * 2. A retarget must be schedulable with a delay, because the cascade is built
 *    from per-line delays rather than from one shared scroll position.
 *
 * Both fall out of solving the spring analytically and re-deriving the solver
 * whenever the target changes.
 */
const DEFAULT_MASS = 1
const DEFAULT_DAMPING = 10
const DEFAULT_STIFFNESS = 100

/** Vertical travel settles at its destination without reversing through it. */
export const LYRIC_POS_Y_SPRING: Partial<LyricSpringParams> = {
  mass: 0.9,
  damping: 15,
  stiffness: 90,
  soft: true
}

/**
 * Scale is deliberately slower than vertical travel (omega0 ~= 7.07 against
 * ~10 rad/s). That phase offset is what reads as organic instead of rigid.
 */
export const LYRIC_SCALE_SPRING: Partial<LyricSpringParams> = {
  mass: 2,
  damping: 25,
  stiffness: 100
}

/** Background voices settle without overshoot (zeta ~= 1.414). */
export const LYRIC_BG_SCALE_SPRING: Partial<LyricSpringParams> = {
  mass: 1,
  damping: 20,
  stiffness: 50
}

const SETTLE_EPSILON = 0.01
const DERIVATIVE_STEP = 1e-3

/** Central difference. Used for the velocity and acceleration settle checks. */
export function derivative(
  solver: (t: number) => number,
  step = DERIVATIVE_STEP
): (t: number) => number {
  return (t: number) => (solver(t + step) - solver(t - step)) / (2 * step)
}

export function solveLyricSpring(
  from: number,
  velocity: number,
  to: number,
  params: Partial<LyricSpringParams> = {}
): (t: number) => number {
  const soft = params.soft ?? false
  const stiffness = params.stiffness ?? DEFAULT_STIFFNESS
  const damping = params.damping ?? DEFAULT_DAMPING
  const mass = params.mass ?? DEFAULT_MASS
  const delta = to - from

  if (soft || 1 <= damping / (2 * Math.sqrt(stiffness * mass))) {
    const angularFrequency = -Math.sqrt(stiffness / mass)
    const leftover = -angularFrequency * delta - velocity
    return (t: number) => {
      if (t < 0) return from
      return to - (delta + t * leftover) * Math.E ** (t * angularFrequency)
    }
  }

  const dampingFrequency = Math.sqrt(4 * mass * stiffness - damping ** 2)
  const leftover = (damping * delta - 2 * mass * velocity) / dampingFrequency
  const dfm = (0.5 * dampingFrequency) / mass
  const dm = -(0.5 * damping) / mass
  return (t: number) => {
    if (t < 0) return from
    return to - (Math.cos(t * dfm) * delta + Math.sin(t * dfm) * leftover) * Math.E ** (t * dm)
  }
}

export class LyricSpring {
  private currentPosition: number
  private targetPosition: number
  private currentTime = 0
  private params: Partial<LyricSpringParams>
  private solver: (t: number) => number
  private getVelocity: (t: number) => number
  private getAcceleration: (t: number) => number
  private queuedParams: (Partial<LyricSpringParams> & { time: number }) | undefined
  private queuedPosition: { time: number; position: number } | undefined

  constructor(position = 0, params: Partial<LyricSpringParams> = {}) {
    this.currentPosition = position
    this.targetPosition = position
    this.params = { ...params }
    this.solver = () => this.targetPosition
    this.getVelocity = () => 0
    this.getAcceleration = () => 0
  }

  private resetSolver(): void {
    const velocity = this.getVelocity(this.currentTime)
    this.currentTime = 0
    this.solver = solveLyricSpring(
      this.currentPosition,
      velocity,
      this.targetPosition,
      this.params
    )
    this.getVelocity = derivative(this.solver)
    this.getAcceleration = derivative(this.getVelocity)
  }

  arrived(): boolean {
    return (
      Math.abs(this.targetPosition - this.currentPosition) < SETTLE_EPSILON &&
      Math.abs(this.getVelocity(this.currentTime)) < SETTLE_EPSILON &&
      Math.abs(this.getAcceleration(this.currentTime)) < SETTLE_EPSILON &&
      this.queuedParams === undefined &&
      this.queuedPosition === undefined
    )
  }

  /** Jump without animating. Clears velocity and any queued work. */
  setPosition(position: number): void {
    this.targetPosition = position
    this.currentPosition = position
    this.currentTime = 0
    this.queuedParams = undefined
    this.queuedPosition = undefined
    this.solver = () => this.targetPosition
    this.getVelocity = () => 0
    this.getAcceleration = () => 0
  }

  /** `delay` is in seconds and is what staggers the cascade across lines. */
  setTargetPosition(position: number, delay = 0): void {
    if (delay <= 0 && Math.abs(this.targetPosition - position) < 0.001) {
      this.queuedPosition = undefined
      return
    }
    if (delay > 0) {
      this.queuedPosition = { position, time: delay }
      return
    }
    this.queuedPosition = undefined
    this.targetPosition = position
    this.resetSolver()
  }

  updateParams(params: Partial<LyricSpringParams>, delay = 0): void {
    if (delay > 0) {
      this.queuedParams = { ...params, time: delay }
      return
    }
    this.params = { ...this.params, ...params }
    this.resetSolver()
  }

  /** `delta` is in seconds. */
  update(delta = 0): void {
    this.currentTime += delta
    this.currentPosition = this.solver(this.currentTime)

    if (this.queuedParams) {
      this.queuedParams.time -= delta
      if (this.queuedParams.time <= 0) {
        const queued = this.queuedParams
        this.queuedParams = undefined
        this.updateParams(queued)
      }
    }
    if (this.queuedPosition) {
      this.queuedPosition.time -= delta
      if (this.queuedPosition.time <= 0) {
        const queued = this.queuedPosition
        this.queuedPosition = undefined
        this.setTargetPosition(queued.position)
      }
    }
    if (this.arrived()) this.setPosition(this.targetPosition)
  }

  getCurrentPosition(): number {
    return this.currentPosition
  }

  getTargetPosition(): number {
    return this.targetPosition
  }

  getCurrentVelocity(): number {
    return this.getVelocity(this.currentTime)
  }

  hasQueuedWork(): boolean {
    return this.queuedPosition !== undefined || this.queuedParams !== undefined
  }
}
