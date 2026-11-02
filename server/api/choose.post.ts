// Choose an option of a blocking prompt. The screen is re-read just before:
// if the question changed since it was shown on the phone, we refuse
// rather than confirm the wrong thing.
// Free answer (`free` option: omp's "Other", Claude's "Type something."): always with its text, and the
// question shown (the option's label is the same for every question).
import { usesTerminalException } from '../../shared/interactiveScreen'
import { updateChoices, updateRestartPlan, UPDATE_LABELS } from '../../shared/selfUpdate'
import { opencodeCard } from '../utils/opencodePrompts'
import { opencodeDecision } from '../utils/choices'

export default defineApi(async (event, b) => {
  if (!PANE_RE.test(b.pane_id || '')) throw new HerdrError('bad_pane', 'Invalid pane')
  if (findPane(b.pane_id)?.stopped) {
    return withPaneLock(b.pane_id, async () => {
      const p = findPane(b.pane_id)
      const launch = await selfUpdates.check(b.pane_id)
      if (!p?.stopped || !launch || restarting(p.id)) throw new HerdrError('stale', 'The pane is not at an empty shell prompt. Check its terminal.')
      const choice = updateChoices(launch)[Number(b.index)]
      if (!choice || UPDATE_LABELS[choice] !== b.label || b.text) throw new HerdrError('stale', 'The question has changed — check the current screen.')
      const plan = updateRestartPlan(launch, choice)
      restarts.set(p.id, { phase: 'starting', agent: 'codex', session: launch.session, at: Date.now() })
      poll()
      try {
        // Exactly one start attempt: a timeout may mean the command was already
        // written. Retrying blindly could type into a newly running program.
        await herdr('agent.start', { name: p.name || `codex-${Date.now().toString(36)}`, kind: 'codex', pane_id: p.id, args: plan.args, timeout_ms: 60000 }, 75000)
      } catch (e) {
        if (!(e instanceof HerdrError) || e.code !== 'agent_not_ready') {
          restarts.delete(p.id)
          setTimeout(poll, 0)
          throw e
        }
      }
      selfUpdates.clear(p.id)
      restarts.set(p.id, { phase: 'starting', agent: 'codex', session: launch.session, at: Date.now(), started: true })
      setTimeout(poll, 0)
      return { ok: true }
    })
  }
  try {
    const pane = findPane(b.pane_id)
    // OpenCode's card is answered through the service, not the screen:
    // re-read the pending requests, refuse when the one shown is gone, and
    // let the API confirm it actually left the pending set.
    if (pane?.agent === 'opencode') {
      const pending = await transcripts.opencodePending(pane).catch(() => null)
      const card = pending ? opencodeCard(pending) : null
      const i = Number(b.index)
      const option = card?.choices.options[i]
      const answer = typeof b.text === 'string' ? b.text.trim() : ''
      if (card) {
        // A free-text option's label is generic ("Type something."), so its
        // question is the extra identity check: different question, stale card.
        if (!b.identity || card.choices.identity !== b.identity || !option || option.label !== b.label
          || (option.free && !sameQuestion(card.choices.question, typeof b.question === 'string' ? b.question : null))) {
          throw new HerdrError('stale', 'The question has changed — check the current screen.')
        }
        if (card.dispatch.kind === 'permission') {
          const decision = card.dispatch.decisions[i]
          if (!decision || !(await transcripts.opencodeReplyPermission(pane, card.dispatch.id, decision, answer || undefined))) {
            throw new HerdrError('stale', 'The question has changed — check the current screen.')
          }
        } else {
          if (option.free && !answer) throw new HerdrError('bad_text', 'Write your answer before sending it.')
          const value = option.free ? answer : card.dispatch.values[i]
          if (value === undefined || !(await transcripts.opencodeReplyForm(pane, card.dispatch.id, card.dispatch.key, value))) {
            throw new HerdrError('stale', 'The question has changed — check the current screen.')
          }
        }
        return { ok: true }
      }
      // No API card (service unreachable, or a request the pending list does
      // not carry): the screen-parsed permission card answers by matching its
      // displayed action/resources to one pending request — never by typing.
      const r = await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
      const screenText = String(r.read && r.read.text || '')
      const choices = screenChoices(screenText, 'opencode')
      const screenOption = choices?.options[i]
      if (!choices?.permission || !b.identity || choices.identity !== b.identity || !screenOption || screenOption.label !== b.label || answer
        || usesTerminalException({ text: screenText, agent: 'opencode', status: pane.status })) {
        throw new HerdrError('stale', 'The question has changed — check the current screen.')
      }
      const decision = opencodeDecision(screenOption.label)
      if (!decision || !(await transcripts.opencodePermissionMatch(pane, { ...choices.permission, decision }))) {
        throw new HerdrError('stale', 'The request has changed — check the current screen.')
      }
      return { ok: true }
    }
    const asked = pane && pane.agent === 'claude' ? await transcripts.pendingClaudeQuestions(pane).catch(() => []) : []
    // Transcript reads can be slow over SSH: read the screen after them,
    // immediately before validating and sending the answer.
    const r = await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
    const text = r.read && r.read.text
    const choices = screenChoices(text, pane?.agent, asked)
    const i = Number(b.index)
    const option = choices && choices.options[i]
    const answer = typeof b.text === 'string' ? b.text.trim() : ''
    if (!choices || !b.identity || choices.identity !== b.identity || usesTerminalException({ text: String(text || ''), agent: pane?.agent, status: pane?.status }) || !option || option.label !== b.label || (answer && !option.free)
      || (option.free && !sameQuestion(choices.question, typeof b.question === 'string' ? b.question : null))) {
      throw new HerdrError('stale', 'The question has changed — check the current screen.')
    }
    if (option.free && !answer) throw new HerdrError('bad_text', 'Write your answer before sending it.')
    if (option.free) await answerFree({ call: herdr, sleep, now: Date.now }, b.pane_id, choices, i, answer, pane?.agent)
    else await herdr('pane.send_input', { pane_id: b.pane_id, keys: keysFor(choices, i) })
  } finally {
    choicesCache.delete(b.pane_id)
    setTimeout(poll, 0)
  }
  return { ok: true }
})
