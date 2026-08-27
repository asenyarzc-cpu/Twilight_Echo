import { existsSync } from 'fs'
import { mkdir, rename, rm } from 'fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'

export interface StagedPluginUpdateOptions {
  stagingRoot: string
  candidateRoot: string
  targetRoot: string
  validateCandidate: () => Promise<void>
  trialActivateCandidate: () => Promise<void>
  commitActiveVersion: () => Promise<void>
  activateCommittedCandidate: () => Promise<void>
  rollbackActiveVersion: () => Promise<void>
  restorePreviousVersion: () => Promise<void>
}

export interface PluginUpdateRollbackFailure {
  phase: 'filesystem' | 'active-version' | 'previous-runtime'
  message: string
  cause: unknown
}

export class PluginUpdateRollbackError extends Error {
  readonly activationError: unknown
  readonly failures: PluginUpdateRollbackFailure[]

  constructor(activationError: unknown, failures: PluginUpdateRollbackFailure[]) {
    super(
      `Plugin update failed and rollback did not complete: ${failures
        .map((failure) => `${failure.phase}: ${failure.message}`)
        .join('; ')}`
    )
    this.name = 'PluginUpdateRollbackError'
    this.activationError = activationError
    this.failures = failures
  }
}

/**
 * Moves a fully validated staged plugin into place only after its trial
 * activation succeeds. The old target is parked on the same volume until the
 * new active version has started successfully.
 */
export async function commitStagedPluginUpdate(options: StagedPluginUpdateOptions): Promise<void> {
  assertTransactionalPaths(options)
  const parkedTarget = join(options.stagingRoot, 'previous-target')
  let targetWasParked = false
  let candidateWasCommitted = false
  let stateMutationStarted = false

  try {
    await options.validateCandidate()
    await options.trialActivateCandidate()

    await mkdir(dirname(options.targetRoot), { recursive: true })
    if (existsSync(options.targetRoot)) {
      await rm(parkedTarget, { recursive: true, force: true })
      await rename(options.targetRoot, parkedTarget)
      targetWasParked = true
    }

    await rename(options.candidateRoot, options.targetRoot)
    candidateWasCommitted = true
    stateMutationStarted = true
    await options.commitActiveVersion()
    await options.activateCommittedCandidate()

    if (targetWasParked) await rm(parkedTarget, { recursive: true, force: true })
  } catch (error) {
    const failures: PluginUpdateRollbackFailure[] = []
    await attemptRollback('filesystem', failures, () =>
      restoreFilesystem(options.targetRoot, parkedTarget, candidateWasCommitted, targetWasParked)
    )
    if (stateMutationStarted) {
      await attemptRollback('active-version', failures, options.rollbackActiveVersion)
    }
    await attemptRollback('previous-runtime', failures, options.restorePreviousVersion)
    if (failures.length > 0) throw new PluginUpdateRollbackError(error, failures)
    throw error
  }
}

function assertTransactionalPaths(options: StagedPluginUpdateOptions): void {
  const stagingRoot = resolve(options.stagingRoot)
  const candidateRoot = resolve(options.candidateRoot)
  const targetRoot = resolve(options.targetRoot)
  const stagingVolume = parse(stagingRoot).root.toLowerCase()
  const targetVolume = parse(targetRoot).root.toLowerCase()
  if (stagingVolume !== targetVolume) {
    throw new Error('Plugin update staging and target directories must be on the same volume.')
  }
  if (!isStrictlyInside(candidateRoot, stagingRoot)) {
    throw new Error(
      'Plugin update candidate must be contained by its transaction staging directory.'
    )
  }
  if (isStrictlyInside(targetRoot, stagingRoot) || isStrictlyInside(stagingRoot, targetRoot)) {
    throw new Error('Plugin update target and staging directories must not overlap.')
  }
}

function isStrictlyInside(child: string, parent: string): boolean {
  const pathBetween = relative(parent, child)
  return (
    pathBetween !== '' &&
    pathBetween !== '..' &&
    !pathBetween.startsWith(`..${sep}`) &&
    !isAbsolute(pathBetween)
  )
}

async function restoreFilesystem(
  targetRoot: string,
  parkedTarget: string,
  candidateWasCommitted: boolean,
  targetWasParked: boolean
): Promise<void> {
  if (candidateWasCommitted) await rm(targetRoot, { recursive: true, force: true })
  if (targetWasParked && existsSync(parkedTarget)) {
    await mkdir(dirname(targetRoot), { recursive: true })
    await rename(parkedTarget, targetRoot)
  }
}

async function attemptRollback(
  phase: PluginUpdateRollbackFailure['phase'],
  failures: PluginUpdateRollbackFailure[],
  operation: () => Promise<void>
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    failures.push({ phase, message: errorMessage(error), cause: error })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
