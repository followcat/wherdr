// Engines load lazily: none of their weight is in the main bundle. Each engine
// task adds its entry here.
import type { DictationEngine, DictationEngineId } from './engine'

export const ENGINES: Partial<Record<DictationEngineId, () => Promise<DictationEngine>>> = {
  device: () => import('./device').then(m => m.openDeviceEngine()),
  cloud: () => import('./cloud').then(m => m.createCloudEngine()),
}

// One instance per engine for the whole app: loading a model costs seconds, so
// the engine survives pane switches and composer unmounts.
const loaded = new Map<DictationEngineId, Promise<DictationEngine>>()

export function loadEngine(id: DictationEngineId): Promise<DictationEngine> {
  let engine = loaded.get(id)
  if (!engine) {
    const make = ENGINES[id]
    if (!make) return Promise.reject(new Error(`Dictation engine "${id}" is not available`))
    engine = make()
    // A failed load is retried on the next press.
    engine.catch(() => loaded.delete(id))
    loaded.set(id, engine)
  }
  return engine
}

// Settings changed the engine or its model: free what is loaded.
export function disposeEngines(): void {
  for (const engine of loaded.values()) engine.then(e => e.dispose(), () => {})
  loaded.clear()
}
