// { settings: { key: value | null }, migrate?: true }. With `migrate` (the
// first load after the update), only the keys the server lacks are written.
import { cleanSettingsPatch } from '../../shared/settings'
import { HerdrError } from '../utils/herdr'
import { patchSettings, prepareSettingsPatch } from '../utils/settings'

export default defineApi(async (_event, body) => {
  const clean = cleanSettingsPatch(body.settings)
  if (!clean) throw new HerdrError('bad_settings', 'Invalid settings')
  const patch = await prepareSettingsPatch(clean)
  return { settings: await patchSettings(patch, { onlyMissing: body.migrate === true }) }
})
