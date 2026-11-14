// ?id=: an action button an agent put in its reply (shared/uiActions.ts), as it stands now.
import { readCard } from '../../utils/uiActions'
import { pmStore } from '../../utils/pmStore'
import { HerdrError } from '../../utils/herdr'

export default defineApi(async (event) => {
  const card = await readCard(pmStore(), getQuery(event).id)
  if (!card) throw new HerdrError('not_found', 'Unknown action')
  return { card }
})
