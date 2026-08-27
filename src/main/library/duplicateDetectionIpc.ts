import type {
  DuplicateCandidate,
  DuplicateDetectionResult
} from '../../shared/duplicateDetection.ts'
import { contentHash, detectDuplicates, toDuplicateCandidate } from './duplicateDetection.ts'

export const MAX_DUPLICATE_DETECTION_TRACKS = 50_000

export interface DuplicateDetectionIpcDependencies {
  assertTrustedSender(event: unknown): void
  loadTracks(): readonly unknown[]
  authorizeAudioFile(filePath: string): Promise<string>
  hashContent?(filePath: string): Promise<string>
}

export interface DuplicateDetectionIpcHandlers {
  detect(event: unknown): Promise<DuplicateDetectionResult>
}

/**
 * Read-only boundary for duplicate inspection. Its dependency surface intentionally exposes no
 * library mutation, media write, tag write, removal, or merge operation.
 */
export function createDuplicateDetectionIpcHandlers(
  dependencies: DuplicateDetectionIpcDependencies
): DuplicateDetectionIpcHandlers {
  const hashContent = dependencies.hashContent ?? contentHash

  return {
    async detect(event): Promise<DuplicateDetectionResult> {
      dependencies.assertTrustedSender(event)
      const tracks = dependencies.loadTracks()
      const candidates = toCandidates(tracks)
      return await detectDuplicates(candidates, {
        contentHashForPath: async (filePath) => {
          try {
            const authorizedPath = await dependencies.authorizeAudioFile(filePath)
            return await hashContent(authorizedPath)
          } catch {
            // A missing, revoked, or unreadable file must not fail the entire read-only inspection.
            return null
          }
        }
      })
    }
  }
}

function toCandidates(tracks: readonly unknown[]): DuplicateCandidate[] {
  const seenIds = new Set<string>()
  const candidates: DuplicateCandidate[] = []
  for (const track of tracks.slice(0, MAX_DUPLICATE_DETECTION_TRACKS)) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) continue
    const candidate = toDuplicateCandidate(track as Record<string, unknown>)
    // A duplicate or absent library identity cannot be safely presented as a merge candidate.
    if (!candidate.id || !candidate.filePath || seenIds.has(candidate.id)) continue
    seenIds.add(candidate.id)
    candidates.push(candidate)
  }
  return candidates
}
