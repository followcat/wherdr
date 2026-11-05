// { enabled: boolean }: the Settings › Projects switch, the only write allowed while off.
import { HerdrError } from '../../utils/herdr'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => {
  if (typeof body.enabled !== 'boolean') throw new HerdrError('bad_input', 'enabled: true or false')
  await pmStore().setEnabled(body.enabled)
  return pmStore().overview()
})
