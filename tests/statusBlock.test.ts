// WHR-205: live status cards an agent names in a ```wherdr block.
import { expect, it, vi } from 'vitest'
import { machineView, opView, parseStatusBlock, prView, quotaView } from '../shared/statusBlock'
import type { Card } from '../shared/pm/board'
import { md } from '../app/utils/markdown'

vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s, addHook: () => {} } }))
;(globalThis as { t?: (s: string) => string }).t = s => s

it('reads status lines, and leaves any other block as code', () => {
  expect(parseStatusBlock('status machine:studio\n  status quota:claude\nstatus pr:WHR#412\nstatus op:WHR-12\n'))
    .toEqual([{ kind: 'machine', arg: 'studio' }, { kind: 'quota', arg: 'claude' }, { kind: 'pr', arg: 'WHR#412' }, { kind: 'op', arg: 'WHR-12' }])
  for (const bad of ['', 'status cpu:x', 'status quota:gemini', 'status pr:412', 'status machine:a b', 'status op:WHR-12\nhello', 'status machine:"><img>'])
    expect(parseStatusBlock(bad), bad).toBeNull()
  expect(md('```wherdr\nstatus machine:studio\n```')).toContain('class="status-slot" data-status-kind="machine" data-status-arg="studio"')
  expect(md('```wherdr\nstatus cpu:x\n```')).toContain('<pre><code class="language-wherdr">')
  expect(md('```wherdr\nstatus machine:studio\n```', { plain: true })).not.toContain('status-slot')
  // A `ui open` card kept in the reply (shared/uiOpen.ts).
  expect(md('```wherdr\nopen #/board?project=WEB\n```')).toContain('class="open-slot" data-link="#/board?project=WEB"')
  // A `ui action` button (shared/uiActions.ts); a bad id stays code.
  expect(md('```wherdr\naction 00000000000000a1\n```')).toContain('class="action-slot" data-action="00000000000000a1"')
  expect(md('```wherdr\naction WEB-3\n```')).toContain('<pre><code class="language-wherdr">')
})

it('shows a machine and a quota from what the app reads, unavailable when gone', () => {
  const G = 2 ** 30
  const rows = [{ key: 'm1', label: 'Studio', agents: 3, mem: { cores: 8, total: 16 * G, available: 7 * G, swapTotal: 0, swapFree: 0, load1: 4 } }]
  expect(machineView(rows, 'studio')).toEqual({ title: 'Studio', state: 'online', tone: 'ok', lines: ['RAM 7.0 GB free of 16 GB · load 50 %', '3 agents'] })
  expect(machineView([{ ...rows[0]!, mem: null }], 'm1')?.state).toBe('offline')
  expect(machineView(rows, 'other')).toBeNull()
  const now = 1000
  const q = { claude: { at: 0, five: { used: 22, resetsAt: 5000, minutes: 300 }, week: { used: 80, resetsAt: 500, minutes: 10080 } }, codex: null }
  // A window reset since the reading counts as full.
  expect(quotaView(q, 'claude', now)).toMatchObject({ state: '78 % left', tone: 'ok', bars: [{ label: '5 h', left: 78 }, { label: 'week', left: 100 }] })
  expect(quotaView(q, 'codex', now)).toBeNull()
  expect(quotaView(null, 'claude', now)).toBeNull()
})

it('finds a PR and an operation on the board', () => {
  const card = {
    id: 'WHR-12', shown: 'WHR-12', project: 'WHR', title: 'Sidebar rows', phase: 'working', yourTurn: undefined,
    links: [{ label: 'PR', url: 'https://example.com/o/r/pull/412' }], prNow: 'waiting for checks (ci)',
    plan: [{ id: 'work', text: '' }, { id: 'pr', text: '', action: { kind: 'github.pr' } }, { id: 'ci', text: '', action: { kind: 'pipeline.watch' } }],
    state: { at: 2, started: true, since: 50, acting: true, watch: { from: 100, next: 0 }, proofs: {}, rounds: {} },
  } as unknown as Card
  expect(prView([card], 'whr#412')).toMatchObject({ title: 'PR WHR#412', state: 'waiting for checks (ci)', tone: 'wait', task: 'WHR-12' })
  expect(prView([card], 'WHR#41')).toBeNull()
  expect(prView([card], 'CO#412')).toBeNull()
  expect(opView([card], 'whr-12', () => '4 min')).toEqual({
    title: 'WHR-12 · Watch the pipeline', state: 'watching the pipeline', tone: 'wait', lines: ['Sidebar rows', 'since 4 min'], task: 'WHR-12',
  })
  expect(opView([card], 'WHR-13', () => '')).toBeNull()
})
