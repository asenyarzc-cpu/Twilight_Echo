import type { DspScene, DspSceneState } from '../../../shared/dspGraph.ts'

export function cloneDspScene(scene: DspScene, id = scene.id, name = scene.name): DspScene {
  return { ...(JSON.parse(JSON.stringify(scene)) as DspScene), id, name }
}

export async function submitDspSceneDraft(
  api: {
    setDspScenes: (scenes: DspScene[], pinnedSceneId: string | null) => Promise<DspSceneState>
    applyDspScene: (sceneId: string) => Promise<DspSceneState>
  },
  scenes: DspScene[],
  pinnedSceneId: string | null,
  applySceneId?: string
): Promise<DspSceneState> {
  const saved = await api.setDspScenes(
    scenes.map((scene) => cloneDspScene(scene)),
    pinnedSceneId
  )
  return applySceneId === undefined ? saved : api.applyDspScene(applySceneId)
}
