// Settings › Dictation › Online, kept on this device like the engine choice.
// Only the key is shared: it lives on the wherdr server. The model list comes
// from the server (GET /api/dictation/models, shared/dictationModels.ts).
import { DEFAULT_CLOUD_MODEL } from '../../../shared/dictationModels'

export interface CloudOptions { model: string, zdr: boolean, terms: boolean }

export const CLOUD_OPTIONS_KEY = 'dictationCloud'
// ZDR on, pane terms off: nothing beyond the audio leaves until asked.
export const CLOUD_DEFAULTS: CloudOptions = { model: DEFAULT_CLOUD_MODEL, zdr: true, terms: false }

export function readCloudOptions(): CloudOptions {
  try {
    const o = JSON.parse(localStorage.getItem(CLOUD_OPTIONS_KEY) || '{}')
    return {
      model: typeof o.model === 'string' && o.model ? o.model : CLOUD_DEFAULTS.model,
      zdr: o.zdr !== false,
      terms: o.terms === true,
    }
  } catch { return { ...CLOUD_DEFAULTS } }
}

export function writeCloudOptions(o: CloudOptions): void {
  try { localStorage.setItem(CLOUD_OPTIONS_KEY, JSON.stringify(o)) }
  catch { /* storage unavailable */ }
}
