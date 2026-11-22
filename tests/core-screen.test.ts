import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCoreScreens, readCoreScreen } from '../server/utils/coreScreen'
import { coreChoose, coreNav, type CoreChooseDeps } from '../server/utils/coreChoose'
import { CoreError } from '../server/utils/core'
import type { Pane } from '../shared/types'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const bash = fx('claude-approve-bash.txt')
const input = '────────────────────\n❯ \n────────────────────\n  ? for shortcuts'
const working = '✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)\n\n' + input
const pane = (id: string, extra: Partial<Pane> = {}) => ({ id, workspace: 'w', coreAddress: `m/${id}`, agent: 'claude', status: 'unknown', ...extra }) as Pane

describe('readCoreScreen', () => {
  it('reads a permission question and derives Your turn when core reports nothing', () => {
    const r = readCoreScreen(bash, 'claude', 'unknown')
    expect(r.status).toBe('blocked')
    expect(r.interaction).toBe('native')
    expect(r.choices?.options.length).toBe(4)
    expect(r.choices?.identity).toBeTruthy()
  })
  it('derives Working from the interrupt hint and the spinner, without reading a question', () => {
    for (const text of [working, '✻ Pondering… (12s)\n' + input]) {
      const r = readCoreScreen(text, 'claude', null)
      expect(r).toMatchObject({ status: 'working', choices: null, interaction: 'working' })
    }
  })
  it('derives Ready at an empty input field', () => {
    expect(readCoreScreen(input, 'claude', null)).toMatchObject({ status: 'idle', interaction: 'input' })
  })
  it('keeps core\'s own status and only adds the question', () => {
    expect(readCoreScreen(bash, 'claude', 'blocked')).toMatchObject({ status: null, interaction: 'native' })
    expect(readCoreScreen(input, 'claude', 'idle')).toMatchObject({ status: null, interaction: 'input' })
  })
  it('reads Claude\'s folder-trust box (unnumbered) as a question even without a core status', () => {
    const trust = fx('claude-trust-folder.txt')
    for (const status of ['unknown', null, 'idle']) {
      const r = readCoreScreen(trust, 'claude', status)
      expect(r.interaction).toBe('native')
      expect(r.choices?.options.map(o => o.label)).toEqual(['No, exit', 'Yes, I trust this folder'])
      expect(r.choices?.cursor).toBe(0)
    }
    expect(readCoreScreen(trust, 'claude', 'unknown').status).toBe('blocked')
  })
  it('reads Codex 0.166\'s folder-trust question as Your turn while core still says idle', () => {
    const r = readCoreScreen(fx('codex-trust-folder.txt'), 'codex', 'idle')
    expect(r).toMatchObject({ status: 'blocked', interaction: 'native' })
    expect(r.choices?.options.map(o => o.label)).toEqual(['Trust and continue', 'Back to Agent Command Center'])
  })
  it('stays unknown on an unrecognised screen', () => {
    expect(readCoreScreen('$ ls', 'claude', 'unknown')).toMatchObject({ status: null, choices: null, interaction: 'unknown' })
  })
})

describe('readCoreScreen, Antigravity 1.5.14', () => {
  it('reads the live braille status line and a running background command as working', () => {
    for (const text of [' ⣷  Running command...\n', '● [17:28:01] npm test — running\n', '⠋ Working… (12s)\n']) {
      expect(readCoreScreen(text, 'agy', 'unknown')).toMatchObject({ status: 'working', interaction: 'working' })
    }
  })
  it('reads the workspace trust picker as Your turn with native choices', () => {
    for (const status of ['unknown', null, 'idle']) {
      const r = readCoreScreen(fx('agy-trust.txt'), 'agy', status)
      expect(r).toMatchObject({ status: 'blocked', interaction: 'native' })
    }
  })
})

describe('enrich', () => {
  // Antigravity checks live below.
  // Fixture: tests/fixtures/agy-trust.txt
  it('reads the Antigravity workspace prompt as native choices', () => {
    const r = readCoreScreen(fx('agy-trust.txt'), 'agy', 'unknown')
    expect(r).toMatchObject({ status: 'blocked', interaction: 'native' })
    expect(r.choices?.options).toHaveLength(2)
  })
  function setup(texts: Record<string, string>, viewed = (_: string) => true) {
    const reads: string[] = []
    let t = 0
    const screens = createCoreScreens({
      call: async (_m, p: any) => { reads.push(p.terminal); if (texts[p.terminal] === undefined) throw new Error('x'); return { text: texts[p.terminal] } },
      viewed, now: () => t,
    })
    return { screens, reads, tick: (ms: number) => { t += ms } }
  }
  it('fills prompt, interaction and status; skips shells and working agents', async () => {
    const { screens, reads } = setup({ 'm/a': bash, 'm/b': input })
    const a = pane('a'), b = pane('b'), shell = pane('s', { agent: null }), busy = pane('w', { status: 'working', agent: 'codex' })
    await screens.enrich([a, b, shell, busy])
    expect(reads.sort()).toEqual(['m/a', 'm/b'])
    expect(a).toMatchObject({ status: 'blocked', interaction: 'native' })
    expect(a.prompt?.options.length).toBe(4)
    expect(b).toMatchObject({ status: 'idle', interaction: 'input' })
    expect(shell.interaction).toBeUndefined()
    expect(busy.status).toBe('working')
  })
  it('reads omp\'s context gauge while it works, without its question reading, and keeps the last one', async () => {
    const screen = (gauge: string) => `answer\n ⠸ 4s > ⬢ Model > 🗑 ~/demo ${gauge}\n╰─`
    const texts: Record<string, string> = { 'm/o': screen('▶────6%──────╎───┃─────128K─') }
    const { screens, tick } = setup(texts, () => false)
    const working = pane('o', { agent: 'omp', status: 'working' })
    await screens.enrich([working])
    expect(working.ompStatus).toEqual({ line: '⠸ 4s > ⬢ Model > 🗑 ~/demo', meters: '▶────6%──────╎───┃─────128K─◀', metersFresh: true })
    expect(working.interaction).toBeUndefined()
    // A full-screen panel hides the gauge: the last one stays, not live.
    texts['m/o'] = 'Usage\nEsc to close'
    tick(5000)
    const panel = pane('o', { agent: 'omp', status: 'working' })
    await screens.enrich([panel])
    expect(panel.ompStatus).toMatchObject({ meters: '▶────6%──────╎───┃─────128K─◀', metersFresh: false })
    // At rest, the reading is the last known one; another agent in the pane drops it.
    const idle = pane('o', { agent: 'omp', status: 'idle' })
    await screens.enrich([idle])
    expect(idle.ompStatus?.metersFresh).toBe(false)
    await screens.enrich([pane('o', { agent: 'claude', status: 'idle' })])
    tick(5000)
    const back = pane('o', { agent: 'omp', status: 'working' })
    await screens.enrich([back])
    expect(back.ompStatus).toBeUndefined()
  })
  it('reads omp again at once when its turn ends, so a question is not hidden behind a gauge read', async () => {
    const texts: Record<string, string> = { 'm/o': input }
    const { screens, reads, tick } = setup(texts, () => false)
    await screens.enrich([pane('o', { agent: 'omp', status: 'idle' })])
    tick(40_000)
    await screens.enrich([pane('o', { agent: 'omp', status: 'working' })])
    texts['m/o'] = fx('omp-approve-1814-bash.txt')
    tick(2000)
    const q = pane('o', { agent: 'omp', status: 'blocked' })
    await screens.enrich([q])
    expect(reads.length).toBe(3)
    expect(q.interaction).toBe('native')
    expect(q.prompt).toBeDefined()
  })
  it('reads a working Claude only while its conversation is open (queue "send now")', async () => {
    const open = setup({ 'm/w': input })
    await open.screens.enrich([pane('w', { status: 'working' })])
    expect(open.reads).toEqual(['m/w'])
    const closed = setup({ 'm/w': input }, () => false)
    await closed.screens.enrich([pane('w', { status: 'working' })])
    expect(closed.reads).toEqual([])
  })
  it('reads the "!" command a working Claude runs, before its transcript has it', async () => {
    const running = '! make deploy\n  ⎿  step 3 of 9\n     +2 lines (35s)\n\n' + input
    const s = setup({ 'm/w': running })
    const w = pane('w', { status: 'working' })
    await s.screens.enrich([w])
    expect(w.claudeScreen?.shell).toMatchObject({ command: 'make deploy', lines: ['step 3 of 9'], hidden: 2, since: -35_000 })
  })
  it('sets a viewed working Claude\'s verb and an omp\'s running step, and clears them when the turn ends', async () => {
    const texts: Record<string, string> = { 'm/w': working, 'm/o': fx('omp-working.txt') }
    const s = setup(texts)
    const w = pane('w', { status: 'working' }), o = pane('o', { agent: 'omp', status: 'working' })
    await s.screens.enrich([w, o])
    expect(w.activity).toBe('Pondering')
    expect(o.ompActivity).toEqual({ step: 'Sleeping first time', since: -5000 })
    texts['m/w'] = input
    s.tick(1000)
    const done = pane('w', { status: 'idle', activity: 'Pondering' }), rest = pane('o', { agent: 'omp', status: 'idle', ompActivity: { step: 'x', since: 0 } })
    await s.screens.enrich([done, rest])
    expect(done.activity).toBeUndefined()
    expect(rest.ompActivity).toBeUndefined()
  })
  it('puts a Claude whose turn ended with background jobs at rest, even when core says it works', async () => {
    const texts: Record<string, string> = { 'm/w': fx('claude-done-background.txt') }
    const s = setup(texts)
    s.tick(10_000)
    const w = pane('w', { status: 'working', since: 0 })
    await s.screens.enrich([w])
    expect(w).toMatchObject({ status: 'idle', background: '1 shell' })
    expect(w.activity).toBeUndefined()
    // The first moments of a new turn still show the last one's end: still working.
    s.tick(1000)
    const fresh = pane('w', { status: 'working', since: 10_500 })
    await s.screens.enrich([fresh])
    expect(fresh.status).toBe('working')
    expect(fresh.background).toBeUndefined()
  })
  it('caches reads per viewed / background pace and re-applies them', async () => {
    const { screens, reads, tick } = setup({ 'm/a': bash }, () => false)
    await screens.enrich([pane('a')])
    tick(2000)
    const again = pane('a')
    await screens.enrich([again])
    expect(reads.length).toBe(1)
    expect(again.status).toBe('blocked')
    tick(4000)
    await screens.enrich([pane('a')])
    expect(reads.length).toBe(2)
  })
  it('parses a screen once while its text, agent and core status stay the same', async () => {
    const texts: Record<string, string> = { 'm/a': bash }
    const { screens, reads, tick } = setup(texts, () => false)
    const first = pane('a')
    await screens.enrich([first])
    tick(6000) // read again, same text: the same reading
    const same = pane('a')
    await screens.enrich([same])
    expect(reads.length).toBe(2)
    expect(same.prompt).toBe(first.prompt)
    const blocked = pane('a', { status: 'blocked' }) // core's status changed: parsed again
    await screens.enrich([blocked])
    expect(blocked.prompt).not.toBe(first.prompt)
    expect(blocked.prompt).toEqual(first.prompt)
    texts['m/a'] = input
    tick(6000)
    const other = pane('a')
    await screens.enrich([other])
    expect(other).toMatchObject({ status: 'idle', interaction: 'input' })
    expect(other.prompt).toBeUndefined()
  })
  it('shows a new Claude\'s trust box as Your turn at the next poll, not at the background pace', async () => {
    const texts: Record<string, string> = { 'm/a': '' }
    const { screens, reads, tick } = setup(texts, () => false)
    const a = pane('a')
    await screens.enrich([a])
    expect(a.status).toBe('unknown')
    texts['m/a'] = fx('claude-trust-folder.txt')
    tick(1500)
    const next = pane('a')
    await screens.enrich([next])
    expect(reads.length).toBe(2)
    expect(next).toMatchObject({ status: 'blocked', interaction: 'native' })
    expect(next.prompt?.options.map(o => o.label)).toContain('Yes, I trust this folder')
    // Once the screen says something, the background pace is back.
    tick(1500)
    await screens.enrich([pane('a')])
    expect(reads.length).toBe(2)
  })
  it('shows a new Codex\'s trust question as Your turn at the next poll, though core calls it idle', async () => {
    const texts: Record<string, string> = { 'm/a': '› Ask Codex to do anything\n\n  ? for shortcuts' }
    const { screens, reads, tick } = setup(texts, () => false)
    const a = pane('a', { agent: 'codex', status: 'idle' })
    await screens.enrich([a])
    expect(a.status).toBe('idle')
    texts['m/a'] = fx('codex-trust-folder.txt')
    tick(1500)
    const next = pane('a', { agent: 'codex', status: 'idle' })
    await screens.enrich([next])
    expect(reads.length).toBe(2)
    expect(next).toMatchObject({ status: 'blocked', interaction: 'native' })
    expect(next.prompt?.options[0]?.label).toBe('Trust and continue')
  })
  it('reads an undetermined screen at the background pace after the startup window', async () => {
    const { screens, reads, tick } = setup({ 'm/a': 'loading' }, () => false)
    await screens.enrich([pane('a')])
    tick(31_000)
    await screens.enrich([pane('a')])
    tick(1500)
    await screens.enrich([pane('a')])
    expect(reads.length).toBe(2)
  })
  it('marks the interaction unknown when the read fails', async () => {
    const ok = { 'm/a': bash }
    const { screens, tick } = setup(ok)
    const a = pane('a')
    await screens.enrich([a])
    delete (ok as Record<string, string>)['m/a']
    tick(2000)
    await screens.enrich([a])
    expect(a.interaction).toBe('unknown')
  })
})

describe('coreChoose', () => {
  function setup(screenText: () => string) {
    const calls: [string, any][] = []
    const p = pane('t1', { status: 'blocked' })
    const d: CoreChooseDeps = {
      call: async (m, params) => { calls.push([m, params]); return {} as never },
      pane: id => (id === 't1' ? p : undefined), panes: () => [p], refresh: () => {},
      read: async () => screenText(), sleep: async () => {},
    }
    return { d, calls }
  }
  const identity = () => readCoreScreen(bash, 'claude', 'blocked').choices!.identity
  it('sends the keys of the chosen option when the question is unchanged', async () => {
    const { d, calls } = setup(() => bash)
    await coreChoose(d, { pane_id: 't1', index: 1, label: readCoreScreen(bash, 'claude', 'blocked').choices!.options[1]!.label, identity: identity() })
    expect(calls).toEqual([['terminal.keys', { terminal: 'm/t1', keys: ['down', 'enter'] }]])
  })
  it('refuses a changed question or label, and sends nothing', async () => {
    const { d, calls } = setup(() => input)
    await expect(coreChoose(d, { pane_id: 't1', index: 0, label: 'Yes', identity: identity() })).rejects.toMatchObject({ code: 'stale' })
    const same = setup(() => bash)
    await expect(coreChoose(same.d, { pane_id: 't1', index: 0, label: 'Nope', identity: identity() })).rejects.toMatchObject({ code: 'stale' })
    await expect(coreChoose(same.d, { pane_id: 't1', index: 0, label: 'Yes', identity: 'other' })).rejects.toMatchObject({ code: 'stale' })
    expect(calls.length + same.calls.length).toBe(0)
  })
  it('sends a free answer only once the field has opened', async () => {
    const ask = '  Which fruit?\n ❯ 1. Apple\n   2. Pear\n   3. Type something.\n──────────\n   4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel'
    const c = readCoreScreen(ask, 'claude', 'blocked').choices!
    const free = c.options.findIndex(o => o.free)
    expect(free).toBeGreaterThan(-1)
    let opened = false
    const s = setup(() => (opened ? input : ask))
    s.d.call = async (m, params) => { s.calls.push([m, params]); if (m === 'terminal.keys') opened = true; return {} as never }
    await coreChoose(s.d, { pane_id: 't1', index: free, label: c.options[free]!.label, identity: c.identity, text: 'Kiwi', question: c.question })
    expect(s.calls.map(x => x[0])).toEqual(['terminal.keys', 'terminal.send'])
    expect(s.calls[1]![1]).toEqual({ terminal: 'm/t1', text: 'Kiwi' })
    // The field never opens: the text is not sent.
    const stuck = setup(() => ask)
    await expect(coreChoose(stuck.d, { pane_id: 't1', index: free, label: c.options[free]!.label, identity: c.identity, text: 'Kiwi', question: c.question })).rejects.toMatchObject({ code: 'stale' })
    expect(stuck.calls.map(x => x[0])).toEqual(['terminal.keys'])
  })
  it('rejects an unknown pane and maps core errors', async () => {
    const { d } = setup(() => bash)
    await expect(coreChoose(d, { pane_id: 'zz' })).rejects.toMatchObject({ code: 'bad_pane' })
    d.call = async () => { throw new CoreError('not_found', 'gone') }
    await expect(coreChoose(d, { pane_id: 't1', index: 0, label: 'Yes', identity: identity() })).rejects.toMatchObject({ code: 'stale' })
  })
  it('sends card keys only while the same question is on screen', async () => {
    const { d, calls } = setup(() => bash)
    await coreNav(d, { pane_id: 't1', keys: ['down'], identity: identity() })
    await coreNav(d, { pane_id: 't1', keys: ['enter'], identity: identity() })
    expect(calls).toEqual([['terminal.keys', { terminal: 'm/t1', keys: ['down'] }], ['terminal.keys', { terminal: 'm/t1', keys: ['enter'] }]])
    await expect(coreNav(d, { pane_id: 't1', keys: ['enter'], identity: 'other' })).rejects.toMatchObject({ code: 'stale' })
    await expect(coreNav(d, { pane_id: 't1', keys: ['ctrl+c'], identity: identity() })).rejects.toMatchObject({ code: 'bad_keys' })
    const gone = setup(() => input)
    await expect(coreNav(gone.d, { pane_id: 't1', keys: ['enter'], identity: identity() })).rejects.toMatchObject({ code: 'stale' })
    expect(calls.length + gone.calls.length).toBe(2)
  })
})
