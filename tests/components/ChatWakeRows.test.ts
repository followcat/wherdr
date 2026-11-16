import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null }
let items: ChatItem[] = []
let reads = 0
registerEndpoint('/api/chat', () => (reads++, { available: true, token: `wakes${items.length}`, file: '/home/user/demo/transcript.jsonl', items }))

const at = (h: number, m = 0) => `2026-01-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`
const ACK = (id: string) => `When you have handled this, run: wherdr pm ack ${id}`
// A wake and the coordinator's answer to it.
const wake = (head: string, reason: string, answer: string, h: number): ChatItem[] => [
  { role: 'user', text: `${head}\n\n${reason}\n\n${ACK(head.split(' ').pop()!)}`, ts: at(h) },
  { role: 'assistant', text: answer, ts: at(h, 1) },
]

describe('wakes in a conversation', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('shows wakes as compact rows, folds routine runs, keeps an incident and the user apart', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    items = [
      { role: 'user', text: 'Ship the release tonight.', ts: at(7) },
      { role: 'assistant', text: 'On it.', ts: at(7, 1) },
      ...wake('Autopilot: wake a1', 'Scheduled wake', 'Nothing to do.', 8),
      ...wake('Health check: wake h1', 'All tasks moving.', 'All good.', 9),
      ...wake('Autopilot: wake a2', 'Scheduled wake', 'Nothing to do.', 11),
      ...wake('Incident: wake i1', 'WHR-9: stuck: the core is unreachable', 'Restarted the worker.', 12),
      ...wake('Engine: wake e1', 'WHR-7: gave up after 2 fixes', 'Shall I retry it?', 13),
    ]
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.findAll('[data-testid="wake"]').length).toBe(2)
      // The user's message keeps its bubble; no wake is one.
      expect(w.findAll('.msg-user')).toHaveLength(1)
      expect(w.find('.msg-user').text()).toContain('Ship the release tonight.')

      // Three routine wakes: one row, folded.
      const run = w.find('[data-testid="wake-run"]')
      expect(run.text()).toContain('3 checks')
      expect(run.findAll('[data-testid="wake-part"]').map(p => p.text())).toEqual(['1 health check', '2 quiet'])
      expect(run.text()).toContain('–')

      // The incident stays visible with its answer, compact and loud.
      const [incident, engine] = w.findAll('[data-testid="wake"]')
      expect(incident!.attributes('data-kind')).toBe('incident')
      expect(incident!.classes()).toContain('loud')
      expect(incident!.find('.wake-head').text()).toBe('WHR-9: stuck: the core is unreachable')
      expect(incident!.find('.wake-answer').text()).toBe('Restarted the worker.')
      expect(incident!.text()).not.toContain('wherdr pm ack')

      // An answer that asks the user stays a full reply under its row.
      expect(engine!.classes()).toContain('loud')
      expect(engine!.find('.wake-answer').exists()).toBe(false)
      expect(w.find('.chat').text()).toContain('Shall I retry it?')

      // Search reads inside the folds: a reply hidden in the run is found.
      expect(w.find('.chat').text()).not.toContain('All good.')
      await w.setProps({ search: true })
      await w.find('.search-bar input').setValue('all good')
      // Its first sentence on its row, and the reply itself.
      await expect.poll(() => w.find('.search-count').text()).toBe('2/2')
      expect(w.find('.chat').text()).toContain('All good.')
      await w.setProps({ search: false })
      await expect.poll(() => w.find('.chat').text()).not.toContain('All good.')

      // Tapping the run shows its wakes; tapping one shows its full text.
      await run.trigger('click')
      expect(w.findAll('[data-testid="wake"]')).toHaveLength(5)
      const first = w.find('[data-testid="wake"]')
      expect(first.find('.wake-head').text()).toBe('Scheduled Nothing to do.')
      await first.find('.wake-row').trigger('click')
      expect(w.find('.wake-text').text()).toContain('wherdr pm ack a1')
    } finally { w.unmount() }
  })

  it('ends a wake\'s turn at its own end or at the user\'s next input', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    items = [
      ...wake('Incident: wake i1', 'WHR-9: stuck: the core is unreachable', 'Restarted the worker.', 8),
      { role: 'bash', text: 'npm install -g some-tool', out: 'added 1 package', ts: at(8, 5) },
      { role: 'assistant', text: 'The tool is installed.', ts: at(8, 6) },
      // A message the user sends while the wake's turn still runs.
      ...wake('Autopilot: wake a1', 'Scheduled wake', 'Checking the board.', 9),
      { role: 'user', text: 'Also look at WHR-7.', ts: at(9, 2) },
      { role: 'assistant', text: 'WHR-7 is moving again.', ts: at(9, 3) },
    ]
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.findAll('[data-testid="wake"]').length).toBe(2)
      const [incident, routine] = w.findAll('[data-testid="wake"]')
      // The folded answer is the wake turn's own, not a later reply.
      expect(incident!.find('.wake-answer').text()).toBe('Restarted the worker.')
      expect(routine!.find('.wake-head').text()).toBe('Scheduled Checking the board.')
      // The "!" command, the user's message and the replies after them show outside.
      const chat = w.find('.chat').text()
      expect(chat).toContain('npm install -g some-tool')
      expect(chat).toContain('The tool is installed.')
      expect(w.find('.msg-user').text()).toContain('Also look at WHR-7.')
      expect(chat).toContain('WHR-7 is moving again.')
    } finally { w.unmount() }
  })
})

describe('a turn the coordinator takes by itself after routine wakes', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('stays outside the fold, and the fold shows its last answer', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    items = [
      ...wake('Autopilot: wake a1', 'Scheduled wake', 'Nothing to do.', 8),
      ...wake('Autopilot: wake a2', 'Scheduled wake', '**WHR-12 merged.**', 9),
      { role: 'assistant', text: 'The fix is live.', ts: at(10), own: true },
      ...wake('Autopilot: wake a3', 'Scheduled wake', 'The study is done.\n\n```wherdr\nchoices "Go" | "Wait"\n```', 11),
      ...wake('Autopilot: wake a4', 'Scheduled wake', 'Nothing new.', 12),
    ]
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.find('[data-testid="wake-run"]').exists()).toBe(true)
      expect(w.find('[data-testid="wake-run"]').text()).toContain('2 checks')
      expect(w.find('.chat').text()).toContain('The fix is live.')
      expect(w.find('.chat').text()).not.toContain('Nothing to do.')
      // A reply with choices is never folded: it shows in full under its row.
      expect(w.findAll('[data-testid="wake-run"]')).toHaveLength(1)
      expect(w.find('.chat').text()).toContain('The study is done.')
      expect(w.findAll('[data-testid="wake"]').some(r => r.find('.wake-answer').exists() && r.text().includes('study'))).toBe(false)
      // A routine one-liner on its own still folds under its row.
      expect(w.findAll('.wake-line').some(a => a.text().startsWith('Scheduled Nothing new.'))).toBe(true)
    } finally { w.unmount() }
  })
})

describe('a run of routine wakes, opened', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('shows one line per wake with its task chip, and folds quiet ones in a row', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    items = [
      ...wake('Autopilot: scheduled wake a1', 'Scheduled wake (every 1h).', 'Nothing new.', 8),
      ...wake('Autopilot: scheduled wake a2', 'Scheduled wake (every 1h).', 'Still nothing.', 9),
      ...wake('Autopilot: wake a3', 'DEMO-5 (Add a login page): done', 'DEMO-5 merged. The board is empty now.', 10),
    ]
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.find('[data-testid="wake-run"]').exists()).toBe(true)
      const run = w.find('[data-testid="wake-run"]')
      expect(run.findAll('[data-testid="wake-part"]').map(p => p.text())).toEqual(['1 mergedDEMO-5', '2 quiet'])
      await run.trigger('click')
      expect(w.find('[data-testid="wake-quiet"]').text()).toContain('2 quiet checks')
      expect(w.findAll('[data-testid="wake"]')).toHaveLength(1)
      expect(w.find('.wake-line').text()).toContain('DEMO-5merged DEMO-5 merged.')
      await w.find('[data-testid="wake-quiet"]').trigger('click')
      expect(w.findAll('[data-testid="wake"]')).toHaveLength(3)
    } finally { w.unmount() }
  })
})

describe('a run with many tasks on a phone', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('wraps its task badges inside the row, and no chat row can widen the conversation', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const done = (from: number) => [0, 1, 2, 3].map(i => `DEMO-${from + i} (Task ${from + i}): done`).join('\n')
    items = [
      ...wake('Autopilot: wake a1', done(10), 'Merged.', 8),
      ...wake('Autopilot: wake a2', done(20), 'Merged.', 9),
      ...wake('Autopilot: wake a3', done(30), 'Merged.', 10),
    ]
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.find('[data-testid="wake-run"]').exists()).toBe(true)
      const part = w.find('[data-testid="wake-part"]')
      expect(part.find('.wake-count').text()).toBe('12 merged')
      expect(part.findAll('.wake-chip')).toHaveLength(12)
      // The time range stays on the row, outside the badges.
      expect(w.find('[data-testid="wake-run"] > .wake-time').exists()).toBe(true)
    } finally { w.unmount() }
    // The styles that make it so (the test DOM does no layout).
    const css = readFileSync(resolve(__dirname, '../../app/assets/css/main.css'), 'utf8')
    const rule = (sel: string) => new RegExp(`^${sel.replace(/[.*>]/g, m => `\\${m}`)} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
    expect(rule('.wake-part')).toMatch(/flex-wrap: wrap/)
    expect(rule('.wake-part')).toMatch(/min-width: 0/)
    expect(rule('.wake-part')).not.toMatch(/nowrap/)
    expect(rule('.wake-chips')).toMatch(/flex-wrap: wrap/)
    expect(rule('.chat')).toMatch(/overflow-x: hidden/)
    expect(rule('.chat-msgs, .chat-list > *')).toMatch(/min-width: 0/)
  })
})

describe('a wake row while the user sends', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('keeps its row, key and folded turn when the agent starts working and a message lands after it', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    items = wake('Incident: wake i1', 'Incident inc1 on host-a at 08:00: herdr-core or wherdr restarted.', 'Resumed everything.', 8)
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    const row = () => {
      const r = w.find('[data-testid="wake"]')
      return { key: r.attributes('data-hit-key'), loud: r.classes().includes('loud'), head: r.find('.wake-head').text(), answer: r.find('.wake-answer').exists() ? r.find('.wake-answer').text() : null }
    }
    try {
      await expect.poll(() => w.findAll('[data-testid="wake"]').length).toBe(1)
      const before = row()
      expect(before).toMatchObject({ loud: true, head: 'Incident inc1 on host-a at 08:00: herdr-core or wherdr restarted.', answer: 'Resumed everything.' })
      // The user sends: the agent works before its transcript has the message.
      const read = reads
      await w.setProps({ pane: { ...pane, status: 'working' } })
      await expect.poll(() => reads).toBe(read + 1)
      await new Promise(r => setTimeout(r, 100))
      expect(row()).toEqual(before)
      // The message lands, then the agent rests again.
      items = [...items, { role: 'user', text: 'Thanks, carry on.', ts: at(9) }]
      await w.setProps({ pane: { ...pane, status: 'idle' } })
      await expect.poll(() => w.find('.msg-user').exists()).toBe(true)
      expect(row()).toEqual(before)
    } finally { w.unmount() }
  })
})
