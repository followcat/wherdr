// Raw input: text + Enter is a message, named keys go to the terminal. Keys
// with a question identity (a "Your turn" card's keyboard) are refused once
// that question has left the screen (see coreNav).
// Keys from the key bar: the agent's screen is read again at the next polls, so a
// "Not sent" draft follows the key at once (and its Clear matches Claude's field).
import { userWrote } from '../utils/pmTalk'
import { coreForPane } from '../utils/state'

export default defineApi(async (_event, b) => {
  if (typeof b.identity === 'string' && !(typeof b.text === 'string' && b.text)) return coreNav(coreChooseDeps(b.pane_id), b)
  const id = typeof b.pane_id === 'string' ? b.pane_id : ''
  const base = coreInputDeps(id)
  if (typeof b.text === 'string' && b.text.trim() && coreForPane(id)?.primary) userWrote(findPane(id)?.coreAddress)
  return coreInput({ ...base, refresh: () => { if (id) coreScreens(id).keyed(id); base.refresh() } }, b)
})
