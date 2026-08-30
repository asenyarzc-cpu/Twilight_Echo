import type { NetworkEntry } from '../../shared/networkSources.ts'

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'flac',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'wav',
  'ape',
  'wv',
  'dsf',
  'dff',
  'dsd'
])

/** 根据名称/媒体类型/目录标志推断条目类型（audio/directory/file）。 */
export function entryKind(
  name: string,
  options: { mime?: string; directory?: boolean }
): NetworkEntry['kind'] {
  if (options.directory) return 'directory'
  const extension = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : ''
  if (options.mime?.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return 'file'
}
