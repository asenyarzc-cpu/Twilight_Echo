import { ref, watch, type Ref } from 'vue'
import {
  useMusicStore,
  type Playlist,
  type PlaylistPersistenceNotice
} from '../../stores/useMusicStore.ts'
import type { Track } from '../../types/music.ts'
import { playlistExportFilename, playlistExportMimeType } from '../../utils/playlistExport.ts'
import {
  assertPlaylistCoverDimensions,
  assertPlaylistCoverFile,
  readPlaylistImportFile
} from '../../utils/playlistFileValidation.ts'
import type { PlaylistFileFormat } from '../../utils/playlistLifecycle.ts'

export interface PlaylistLifecycleActionOptions {
  currentPlaylist: Readonly<Ref<Playlist | null>>
  isPlaylistDetail: Readonly<Ref<boolean>>
  repairMessage: Ref<string>
  getSelectedTracks(): Track[]
  isSelected(trackId: string): boolean
  clearSelection(): void
  selectPlaylist(name: string): void
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function readPlaylistCover(file: File): Promise<string> {
  assertPlaylistCoverFile(file)
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取封面文件失败'))
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('封面数据无效'))
    reader.readAsDataURL(file)
  })
  const image = await createImageBitmap(file)
  try {
    assertPlaylistCoverDimensions(image.width, image.height)
  } finally {
    image.close()
  }

  // Keep the large source out of the reactive playlist snapshot. The main
  // process resizes and stores the bytes, returning a small content-addressed
  // cover:// handle. Tests/early boot without the bridge retain the legacy
  // data URL as a compatibility fallback.
  const cacheCover = window.api?.data?.cacheCover
  if (cacheCover && typeof file.arrayBuffer === 'function') {
    const handle = await cacheCover(await file.arrayBuffer())
    if (!handle) throw new Error('封面缓存失败')
    return handle
  }
  return dataUrl
}

/**
 * Production playlist UI actions shared by SongList and the real-browser behavior gate.
 * Keeping the DOM boundary here prevents format, size and persistence behavior from
 * drifting into template-only code that cannot be exercised end to end.
 */
export function usePlaylistLifecycleActions(options: PlaylistLifecycleActionOptions): {
  playlistImportInput: Ref<HTMLInputElement | null>
  playlistCoverInput: Ref<HTMLInputElement | null>
  playlistExportFormat: Ref<PlaylistFileFormat>
  playlistRepairPending: Ref<boolean>
  triggerPlaylistImport(): void
  handlePlaylistImport(event: Event): Promise<void>
  downloadPlaylistDocument(format: PlaylistFileFormat): void
  triggerPlaylistCoverPicker(): void
  handlePlaylistCover(event: Event): Promise<void>
  handleRenamePlaylist(): void
  handleCopyPlaylist(): void
  handleMoveSelectedWithinPlaylist(toEnd: boolean): void
  handlePlaylistDragStart(event: DragEvent, track: Track): void
  handlePlaylistDrop(event: DragEvent, target: Track): void
  handleMoveSelectedToPlaylist(): void
  handlePlaylistRepair(): Promise<void>
} {
  const {
    playlists,
    playlistPersistenceStatus,
    playlistPersistenceNotice,
    renamePlaylist,
    setPlaylistCover,
    copyPlaylist,
    reorderPlaylistTracks,
    movePlaylistTracks,
    importPlaylistDocument,
    exportPlaylistDocument,
    repairPlaylistMissingTracks
  } = useMusicStore()
  const playlistImportInput = ref<HTMLInputElement | null>(null)
  const playlistCoverInput = ref<HTMLInputElement | null>(null)
  const playlistExportFormat = ref<PlaylistFileFormat>('m3u8')
  const playlistRepairPending = ref(false)
  const playlistDragTrackId = ref<string | null>(null)

  watch(playlistPersistenceNotice, (notice: PlaylistPersistenceNotice | null) => {
    if (notice) options.repairMessage.value = notice.message
  })
  watch(playlistPersistenceStatus, (status) => {
    if (status.state === 'error') {
      options.repairMessage.value = `歌单保存失败：${status.lastError || '未知错误'}`
    }
  })

  function requireCurrentPlaylist(): Playlist | null {
    const playlist = options.currentPlaylist.value
    if (!playlist) options.repairMessage.value = '当前没有可编辑的歌单'
    return playlist
  }

  function handleRenamePlaylist(): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    const name = window.prompt('输入新的歌单名称', playlist.name)
    if (name === null) return
    try {
      if (renamePlaylist(playlist.id, name)) {
        options.repairMessage.value = '歌单已重命名'
        options.selectPlaylist(name.trim().replace(/\s+/g, ' '))
      }
    } catch (error) {
      options.repairMessage.value = describeError(error, '重命名歌单失败')
    }
  }

  function handleCopyPlaylist(): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    const name = window.prompt('输入副本名称', `${playlist.name} 副本`)
    if (name === null) return
    try {
      const copyId = copyPlaylist(playlist.id, name)
      options.repairMessage.value = copyId ? '已创建歌单副本' : '未找到原歌单'
    } catch (error) {
      options.repairMessage.value = describeError(error, '复制歌单失败')
    }
  }

  function triggerPlaylistImport(): void {
    playlistImportInput.value?.click()
  }

  async function handlePlaylistImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const playlist = requireCurrentPlaylist()
    if (!file || !playlist) return
    try {
      const result = importPlaylistDocument(
        playlist.name,
        file.name,
        await readPlaylistImportFile(file)
      )
      options.repairMessage.value = `已导入 ${result.importedCount} 首${
        result.unresolvedEntries ? `，${result.unresolvedEntries} 首未匹配` : ''
      }`
      if (result.warnings.length > 0) {
        console.warn('[playlist] import warnings:', result.warnings)
      }
    } catch (error) {
      options.repairMessage.value = describeError(error, '导入歌单失败')
    }
  }

  function downloadPlaylistDocument(format: PlaylistFileFormat): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    const contents = exportPlaylistDocument(playlist.name, format)
    if (contents === null) return
    const blob = new Blob([contents], { type: playlistExportMimeType(format) })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = playlistExportFilename(playlist.name, format)
    link.click()
    URL.revokeObjectURL(link.href)
    options.repairMessage.value = `已导出 ${format.toUpperCase()} 歌单`
  }

  function triggerPlaylistCoverPicker(): void {
    playlistCoverInput.value?.click()
  }

  async function handlePlaylistCover(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const playlist = requireCurrentPlaylist()
    if (!file || !playlist) return
    try {
      setPlaylistCover(playlist.id, await readPlaylistCover(file))
      options.repairMessage.value = '歌单封面已更新'
    } catch (error) {
      options.repairMessage.value = describeError(error, '更新歌单封面失败')
    }
  }

  function handleMoveSelectedWithinPlaylist(toEnd: boolean): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    const selected = options.getSelectedTracks().map((track) => track.id)
    if (!selected.length) return
    if (reorderPlaylistTracks(playlist.name, selected, toEnd ? playlist.trackIds.length : 0)) {
      options.repairMessage.value = toEnd ? '已移动到歌单末尾' : '已移动到歌单开头'
    }
  }

  function handlePlaylistDragStart(event: DragEvent, track: Track): void {
    if (!options.isPlaylistDetail.value) return
    playlistDragTrackId.value = track.id
    event.dataTransfer?.setData('text/plain', track.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function handlePlaylistDrop(event: DragEvent, target: Track): void {
    event.preventDefault()
    const playlist = requireCurrentPlaylist()
    const dragged = playlistDragTrackId.value ?? event.dataTransfer?.getData('text/plain')
    playlistDragTrackId.value = null
    if (!playlist || !dragged || dragged === target.id) return
    const targetIndex = playlist.trackIds.indexOf(target.id)
    if (targetIndex < 0) return
    const selected = options.isSelected(dragged)
      ? options.getSelectedTracks().map((track) => track.id)
      : [dragged]
    if (reorderPlaylistTracks(playlist.name, selected, targetIndex)) {
      options.repairMessage.value = '已更新歌单顺序'
    }
  }

  function handleMoveSelectedToPlaylist(): void {
    const playlist = requireCurrentPlaylist()
    if (!playlist) return
    const choices = playlists.value.filter((item) => item.id !== playlist.id)
    if (!choices.length) {
      options.repairMessage.value = '请先创建目标歌单'
      return
    }
    const targetName = window.prompt(
      `输入目标歌单名称：${choices.map((item) => item.name).join('、')}`
    )
    if (!targetName) return
    const result = movePlaylistTracks(
      playlist.name,
      targetName.trim(),
      options.getSelectedTracks().map((track) => track.id)
    )
    if (!result.sourceRemoved) {
      options.repairMessage.value = '目标歌单不存在，或没有可移动歌曲'
      return
    }
    options.repairMessage.value = `已移动 ${result.sourceRemoved} 首${
      result.moved < result.sourceRemoved ? '，重复歌曲已合并' : ''
    }`
    options.clearSelection()
  }

  async function handlePlaylistRepair(): Promise<void> {
    const playlist = requireCurrentPlaylist()
    if (!playlist || playlistRepairPending.value) return
    playlistRepairPending.value = true
    try {
      const folder = await window.api.dialog.openFolder()
      if (!folder) return
      const scanned = (await window.api.fs.scanMusicFiles(folder)) as Track[]
      const result = repairPlaylistMissingTracks(playlist.name, scanned)
      options.repairMessage.value = result.relocations.length
        ? `已重新定位 ${result.relocations.length} 首${
            result.ambiguousTrackIds.length
              ? `，${result.ambiguousTrackIds.length} 首存在多个候选`
              : ''
          }`
        : result.ambiguousTrackIds.length
          ? `${result.ambiguousTrackIds.length} 首存在多个候选，需要手动处理`
          : '未找到可自动重新定位的文件'
    } catch (error) {
      options.repairMessage.value = describeError(error, '批量修复歌单文件失败')
    } finally {
      playlistRepairPending.value = false
    }
  }

  return {
    playlistImportInput,
    playlistCoverInput,
    playlistExportFormat,
    playlistRepairPending,
    triggerPlaylistImport,
    handlePlaylistImport,
    downloadPlaylistDocument,
    triggerPlaylistCoverPicker,
    handlePlaylistCover,
    handleRenamePlaylist,
    handleCopyPlaylist,
    handleMoveSelectedWithinPlaylist,
    handlePlaylistDragStart,
    handlePlaylistDrop,
    handleMoveSelectedToPlaylist,
    handlePlaylistRepair
  }
}
