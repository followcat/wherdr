// ?id=: a saved template and its change log.
import { pmStore } from '../../utils/pmStore'
import { HerdrError } from '../../utils/herdr'

export default defineApi(async (event) => {
  const id = String(getQuery(event).id ?? '')
  const template = await pmStore().template(id)
  if (!template) throw new HerdrError('not_found', 'Unknown template')
  return { template, log: await pmStore().templateLog(id) }
})
