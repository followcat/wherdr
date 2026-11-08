// { key, template, guards? }: replaces the project's workflow with a copy of a
// library template or example:<id>. The project's guards stay unless
// guards: 'template', which only the user or Alfred may ask for.
import { guardsAuthor } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'
import { HerdrError } from '../../utils/herdr'

export default defineApi(async (event, body) => {
  const store = pmStore()
  if (typeof body.template !== 'string' || !body.template) throw new HerdrError('bad_input', 'template: a template id or example:<id>')
  const by = await guardsAuthor(store, getRequestHeader(event, 'authorization'))
  return { project: await store.setTemplate(body.key, body.template, { keepGuards: body.guards !== 'template', by }) }
})
