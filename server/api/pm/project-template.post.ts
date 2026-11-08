// { key, template }: replaces the project's workflow with a copy of a library
// template or example:<id> ('' removes it). Removed once the project sheet applies templates.
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => ({ project: await pmStore().setTemplate(body.key, body.template) }))
