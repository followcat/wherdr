import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BacklotDesign, BacklotMachineView, BacklotRole, BacklotStudio } from '../shared/backlot'
import {
  buildBacklotCommand, buildBacklotReportCommand, designQuietStatus, parseBacklotDoc, roleVisualState,
  studioAsksCount, studioVisualState, studioWaitingAttentions, validateBacklotAction, validateBacklotDocQuery,
  waitingDesign,
} from '../shared/backlot'
import { readBacklotDocs, readPoolBacklotDocs, findBacklotActionEntry, clearBacklotDocs } from '../server/utils/backlotDocs'
import { sessionIdScope } from '../server/utils/corePool'
import { BACKLOT_NOT_FOUND, BACKLOT_TIMEOUT, MAX_DESIGN_DOC_CHARS, readBacklotDesignDoc, runBacklotAction } from '../server/utils/backlotActions'

const role = (more: Partial<BacklotRole> = {}): BacklotRole => ({ role: 'dev', name: 'alice', state: 'live', ...more })
const studio = (more: Partial<BacklotStudio> = {}): BacklotStudio => ({
  id: 'shop', title: 'Acme shop', state: 'live', requirement_version: 1, open_reviews: 0, waiting: 0, roles: [], ...more,
})

const fullDoc = {
  schema: 'backlot/1',
  updated_ms: 123,
  backlot_version: '1.2.3',
  studios: [{
    id: 'shop',
    title: 'Acme shop',
    state: 'live',
    requirement_version: 2,
    mode: 'auto',
    open_reviews: 1,
    waiting: 2,
    error: null,
    next: 'Wire checkout',
    repo: 'acme-shop',
    ready_to_finish: false,
    tasks_done: 1,
    tasks_total: 4,
    tasks: [{ id: 'T1', title: 'Checkout', status: 'doing', priority: 'high', requirement_version: 2, behind: true, rework_rounds: 1, rework_cap: 3, actor_role: 'dev', actor_name: 'alice', waits_for: ['T0'], latest_delivery: 5, latest_checks: 'ok', latest_verdict: 'pass' }],
    roles: [{ role: 'dev', name: 'alice', terminal: 'host-a/t1', runner: 'claude', model: 'sonnet', effort: 'high', state: 'live', doing: 'writing', work: 'working', failed: null, workdir: '/home/user/acme-shop', task: 'T1', priority: 'high', resumable: true, since_ms: 10, attention: null, attention_user: false, attention_seq: null, attention_detail: null }],
  }],
  hollywood: { state: 'live', runner: 'claude', model: 'sonnet', effort: 'low', headline: 'Ship it', cards: [{ id: 'c1', studio: 'shop', action: 'merge', why: 'done' }] },
}

describe('parseBacklotDoc', () => {
  it('reads a complete backlot/1 document', () => {
    const doc = parseBacklotDoc(fullDoc)!
    expect(doc.schema).toBe('backlot/1')
    expect(doc.updated_ms).toBe(123)
    expect(doc.backlot_version).toBe('1.2.3')
    expect(doc.studios).toHaveLength(1)
    expect(doc.studios[0]!.roles[0]!.terminal).toBe('host-a/t1')
    expect(doc.studios[0]!.tasks![0]!.actor_name).toBe('alice')
    expect(doc.hollywood!.cards![0]!.id).toBe('c1')
  })

  it('defaults every optional field of an older document', () => {
    const doc = parseBacklotDoc({ schema: 'backlot/1', studios: [{ id: 'x', title: 'X', state: 'live', roles: [{ role: 'dev', name: 'alice', state: 'live' }] }] })!
    expect(doc.updated_ms).toBe(0)
    expect(doc.backlot_version).toBe(null)
    expect(doc.hollywood).toBe(null)
    expect(doc.studios[0]).toMatchObject({ requirement_version: 0, open_reviews: 0, waiting: 0, tasks: [], roles: [{ role: 'dev', name: 'alice', state: 'live' }] })
  })

  it('refuses another schema or malformed input without throwing', () => {
    expect(parseBacklotDoc({ ...fullDoc, schema: 'backlot/2' })).toBe(null)
    expect(parseBacklotDoc(null)).toBe(null)
    expect(parseBacklotDoc(42)).toBe(null)
    expect(parseBacklotDoc({})).toBe(null)
    // The schema is right, the lists are not: sanitized, never thrown.
    expect(parseBacklotDoc({ schema: 'backlot/1', studios: 'nope' })!.studios).toEqual([])
    expect(parseBacklotDoc({ schema: 'backlot/1', studios: [{ title: 'no id' }, 3] })!.studios).toEqual([])
  })

  it('parses design, asks, needs_upgrade and unknown_kinds while staying tolerant of missing/invalid values', () => {
    const doc = parseBacklotDoc({
      schema: 'backlot/1',
      updated_ms: 500,
      studios: [
        {
          id: 'acme-shop',
          title: 'Acme Shop',
          state: 'live',
          requirement_version: 2,
          open_reviews: 0,
          waiting: 0,
          needs_upgrade: true,
          unknown_kinds: ['design.future', 42, ''],
          roles: [{ role: 'producer', name: 'producer', state: 'live', asks: 'Ship v2 today?' }],
          design: {
            version: 2,
            round: 1,
            phase: 'waiting_user',
            waiting_user: true,
            suggest_skip: false,
            skip_reason: null,
            doc_file: 'design/v2.md',
            summary: 'Split checkout into two steps.',
            questions: [
              { id: 'Q1', prompt: 'Keep guest checkout?', recommendation: 'Yes, for speed', section_ref: '§R1.W' },
              { id: '', prompt: 'ignored invalid' },
            ],
            waiting_since_ms: 450,
          },
        },
        {
          id: 'legacy',
          title: 'Legacy',
          state: 'live',
          roles: [],
          design: { phase: 'future_unknown_phase' },
        },
      ],
    })!
    const acme = doc.studios[0]!
    expect(acme.needs_upgrade).toBe(true)
    expect(acme.unknown_kinds).toEqual(['design.future'])
    expect(acme.roles[0]!.asks).toBe('Ship v2 today?')
    expect(acme.design).toEqual({
      version: 2,
      round: 1,
      phase: 'waiting_user',
      waiting_user: true,
      suggest_skip: false,
      skip_reason: null,
      doc_file: 'design/v2.md',
      summary: 'Split checkout into two steps.',
      questions: [{ id: 'Q1', prompt: 'Keep guest checkout?', recommendation: 'Yes, for speed', section_ref: '§R1.W' }],
      waiting_since_ms: 450,
    })
    const legacy = doc.studios[1]!
    expect(legacy.needs_upgrade).toBe(false)
    expect(legacy.unknown_kinds).toEqual([])
    expect(legacy.design).toBe(null)
  })
})

describe('design helpers and asks counting', () => {
  const design = (more: Partial<BacklotDesign> = {}): BacklotDesign => ({
    version: 1, round: 1, phase: 'waiting_user', waiting_user: true, suggest_skip: false, doc_file: 'design/v1.md', questions: [], ...more,
  })

  it('counts waiting design decisions in asks, never when needs_upgrade or quiet/finished', () => {
    expect(studioAsksCount(studio({ roles: [role({ asks: 'Which db?' })], design: design() }))).toBe(2)
    expect(studioAsksCount(studio({ design: design({ phase: 'suggest_skip', suggest_skip: true }) }))).toBe(1)
    expect(studioAsksCount(studio({ design: design({ phase: 'waiting_proposal', waiting_user: false }) }))).toBe(0)
    expect(studioAsksCount(studio({ needs_upgrade: true, design: design() }))).toBe(0)
    expect(studioAsksCount(studio({ state: 'finished', design: design() }))).toBe(0)
    expect(waitingDesign(studio({ design: design() }))?.phase).toBe('waiting_user')
    expect(designQuietStatus(design({ round: 2, phase: 'waiting_proposal', waiting_user: false }))).toBe('design · R2 · proposal')
    expect(designQuietStatus(design({ round: 1, phase: 'waiting_buildability', waiting_user: false }))).toBe('design · R1 · buildability')
    expect(designQuietStatus(design({ round: 1, phase: 'waiting_summary', waiting_user: false }))).toBe('design · R1 · summary')
    expect(designQuietStatus(design({ round: 1, phase: 'signed', waiting_user: false }))).toBe('design · R1 · signed')
    expect(designQuietStatus(design({ phase: 'idle', waiting_user: false }))).toBe(null)
  })
})

describe('roleVisualState and studioWaitingAttentions', () => {
  it('maps a role onto the standard state tokens', () => {
    expect(roleVisualState(role({ attention: 'permission prompt' }))).toBe('blocked')
    expect(roleVisualState(role({ work: 'working' }))).toBe('working')
    expect(roleVisualState(role({ work: 'blocked' }))).toBe('blocked')
    expect(roleVisualState(role({ work: 'waiting' }))).toBe('idle')
    expect(roleVisualState(role({ failed: 'exit 1' }))).toBe('blocked')
    expect(roleVisualState(role({ state: 'closed' }))).toBe('inactive')
    expect(roleVisualState(role({ state: 'lost' }))).toBe('inactive')
    expect(roleVisualState(role({ state: 'finished' }))).toBe('done')
    expect(roleVisualState(role({ state: 'weird' }))).toBe('unknown')
  })

  it('brings the roles waiting for the user first, then by attention sequence', () => {
    const s = studio({ roles: [
      role({ role: 'qa', name: 'bob', attention: 'review', attention_seq: 2 }),
      role({ role: 'dev', name: 'alice', attention: 'permission prompt', attention_user: true, attention_seq: 5 }),
      role({ role: 'ops', name: 'carol' }),
      role({ role: 'pm', name: 'dave', attention: 'decision', attention_seq: 1 }),
    ] })
    expect(studioWaitingAttentions(s).map(r => r.name)).toEqual(['alice', 'dave', 'bob'])
  })

  it("summarizes a studio's health for its square indicator", () => {
    expect(studioVisualState(studio({ error: 'boom' }))).toBe('blocked')
    expect(studioVisualState(studio({ roles: [role({ attention: 'x' })] }))).toBe('blocked')
    expect(studioVisualState(studio({ roles: [role({ work: 'working' })] }))).toBe('working')
    expect(studioVisualState(studio({ state: 'finished' }))).toBe('done')
    expect(studioVisualState(studio({ roles: [role({ state: 'closed' })] }))).toBe('inactive')
    expect(studioVisualState(studio())).toBe('idle')
  })
})

describe('validateBacklotAction', () => {
  it('accepts every kind and builds its argv', () => {
    const cases = [
      [{ kind: 'approve', machine: '', studio: 'shop', person: 'alice', decision: 'allow' }, ['approve', '--studio', 'shop', '--person', 'alice', '--decision', 'allow']],
      [{ kind: 'approve', machine: 'host-b', studio: 'shop', person: 'alice', decision: 'deny' }, ['approve', '--studio', 'shop', '--person', 'alice', '--decision', 'deny']],
      [{ kind: 'tell', machine: '', studio: 'shop', role: 'dev', text: '  hello  ' }, ['tell', '--studio', 'shop', 'dev', '--text', 'hello', '--as', 'user']],
      [{ kind: 'tell-hollywood', machine: '', text: 'hello' }, ['tell', 'hollywood', '--text', 'hello']],
      [{ kind: 'attention-clear', machine: 'host-b', studio: 'shop', seq: 3 }, ['attention', 'clear', '--studio', 'shop', '3']],
      [{ kind: 'card-apply', machine: '', cardId: 'c12' }, ['card', 'apply', 'c12']],
      [{ kind: 'card-cancel', machine: 'host-b', cardId: 'c9' }, ['card', 'cancel', 'c9']],
      [{ kind: 'stage-start', machine: '' }, ['stage', 'start']],
      [{ kind: 'design-sign', machine: '', studio: 'acme-shop', skip: false, note: '  ship it  ' }, ['design', 'sign', '--studio', 'acme-shop', '--note', 'ship it', '--as', 'user']],
      [{ kind: 'design-sign', machine: 'host-a', studio: 'acme-shop', skip: true, reason: '  tiny fix  ' }, ['design', 'sign', '--studio', 'acme-shop', '--skip', '--reason', 'tiny fix', '--as', 'user']],
      [{ kind: 'design-open', machine: '', studio: 'acme-shop' }, ['design', 'open', '--studio', 'acme-shop', '--as', 'user']],
      [{ kind: 'design-open', machine: 'host-a', studio: 'acme-shop', req: 2 }, ['design', 'open', '--studio', 'acme-shop', '--req', '2', '--as', 'user']],
    ] as const
    for (const [input, argv] of cases) {
      const action = validateBacklotAction(input)!
      expect(action).not.toBe(null)
      expect(buildBacklotCommand(action)).toEqual(argv)
    }
  })

  it('refuses unknown kinds, shell metacharacters, empty text, invalid cards and sequences', () => {
    const bad = [
      null, 'x', {}, { kind: 'nope', machine: '' },
      { kind: 'tell', machine: '', studio: 'shop', role: 'dev', text: '   ' },
      { kind: 'tell', machine: '', studio: 'shop; rm -rf /', role: 'dev', text: 'hi' },
      { kind: 'tell', machine: '', studio: 'shop', role: '../dev', text: 'hi' },
      { kind: 'tell', machine: 'host-b\nrm', studio: 'shop', role: 'dev', text: 'hi' },
      { kind: 'tell', machine: '', studio: 'shop', role: 'dev', text: 'x'.repeat(4001) },
      { kind: 'attention-clear', machine: '', studio: 'shop', seq: 0 },
      { kind: 'attention-clear', machine: '', studio: 'shop', seq: -1 },
      { kind: 'attention-clear', machine: '', studio: 'shop', seq: 1.5 },
      { kind: 'card-apply', machine: '', cardId: 'c-1' },
      { kind: 'card-apply', machine: '', cardId: 'x1' },
      { kind: 'approve', machine: '', studio: 'shop', person: 'alice', decision: 'maybe' },
      { kind: 'stage-start', machine: '$(id)' },
      { kind: 'design-sign', machine: '', studio: '../bad', skip: false },
      { kind: 'design-sign', machine: '', studio: 'acme-shop', skip: 'yes' },
      { kind: 'design-sign', machine: '', studio: 'acme-shop', skip: false, reason: 'cannot reason without skip' },
      { kind: 'design-sign', machine: '', studio: 'acme-shop', skip: true, reason: '   ' },
      { kind: 'design-sign', machine: '', studio: 'acme-shop', skip: true, reason: 'x'.repeat(4001) },
      { kind: 'design-sign', machine: '', studio: 'acme-shop', skip: false, note: 'x'.repeat(4001) },
      { kind: 'design-open', machine: '', studio: 'acme-shop; id' },
      { kind: 'design-open', machine: '', studio: 'acme-shop', req: 0 },
      { kind: 'design-open', machine: '', studio: 'acme-shop', req: -1 },
    ]
    for (const input of bad) expect(validateBacklotAction(input)).toBe(null)
  })

  it('validates design doc paths strictly and builds report show commands', () => {
    expect(validateBacklotDocQuery({ machine: 'host-a', studio: 'acme-shop', file: 'design/v1.md' })).toEqual({
      machine: 'host-a', studio: 'acme-shop', file: 'design/v1.md',
    })
    expect(validateBacklotDocQuery({ session: 'cafecafe', machine: '', studio: 'acme-shop', file: 'design/v12-final.md' })).toEqual({
      session: 'cafecafe', machine: '', studio: 'acme-shop', file: 'design/v12-final.md',
    })
    expect(buildBacklotReportCommand('acme-shop', 'design/v1.md')).toEqual(['report', 'show', '--studio', 'acme-shop', '--file', 'design/v1.md'])

    const badPaths = [
      '',
      '../etc/passwd',
      'design/../req/v1.md',
      '/design/v1.md',
      'design/v1.txt',
      'design/v.md',
      'design/v1/r1-proposal.md',
      'reports/r1.md',
      'design/v1-final.md.bak',
      'design/v1.md; id',
    ]
    for (const file of badPaths) {
      expect(validateBacklotDocQuery({ machine: '', studio: 'acme-shop', file })).toBe(null)
    }
    expect(validateBacklotDocQuery({ machine: '$(id)', studio: 'acme-shop', file: 'design/v1.md' })).toBe(null)
    expect(validateBacklotDocQuery({ machine: '', studio: '../shop', file: 'design/v1.md' })).toBe(null)
  })

  it('preserves a safe session key when present and rejects malformed session keys', () => {
    expect(validateBacklotAction({ kind: 'tell-hollywood', session: '', machine: '', text: 'hello' })).toEqual({
      kind: 'tell-hollywood', session: '', machine: '', text: 'hello',
    })
    expect(validateBacklotAction({ kind: 'card-apply', session: 'cafecafecafecafe', machine: '', cardId: 'c1' })).toEqual({
      kind: 'card-apply', session: 'cafecafecafecafe', machine: '', cardId: 'c1',
    })
    for (const session of [123, null, '../bad', 'a; rm -rf /', 'x'.repeat(65)]) {
      expect(validateBacklotAction({ kind: 'stage-start', session, machine: '' })).toBe(null)
    }
  })
})

describe('readBacklotDocs', () => {
  beforeEach(() => clearBacklotDocs())

  const machines = [{ name: 'host-b', state: 'connected' }, { name: 'host-c', state: 'disconnected' }]
  const terminals = [
    { address: 't1', name: 'backlot-stage', state: 'live', cwd: '/home/user/acme-shop' },
    { address: 'host-b/t2', labels: { 'backlot.role': 'stage' }, state: 'live', cwd: '/home/user/beta-tools' },
    { address: 'host-b/t3', name: 'backlot-stage', state: 'finished', cwd: '/home/user/beta-tools' },
  ]
  const fake = () => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method !== 'doc.get') return {}
      const on = params.on as string | undefined
      return { value: on === 'host-b' ? fullDoc : { ...fullDoc, studios: [] } }
    })
    return { call, calls }
  }

  it('reads this core and every connected machine, and detects a live stage', async () => {
    const { call, calls } = fake()
    const views = await readBacklotDocs(call, machines, terminals, 1000)
    expect(views.map(v => v.machine)).toEqual(['', 'host-b'])
    expect(views[0]!.stageRunning).toBe(true)
    expect(views[1]!.stageRunning).toBe(true)
    expect(views[1]!.label).toBe('host-b')
    expect(views[0]!.backlotVersion).toBe('1.2.3')
    expect(calls.filter(c => c.method === 'doc.get').map(c => c.params)).toEqual([
      { name: 'backlot' },
      { name: 'backlot', on: 'host-b' },
    ])
  })

  it('serves the cache for a few seconds and clearBacklotDocs invalidates it', async () => {
    const { call, calls } = fake()
    await readBacklotDocs(call, machines, terminals, 1000)
    expect(calls).toHaveLength(2)
    await readBacklotDocs(call, machines, terminals, 2000)
    expect(calls).toHaveLength(2)
    clearBacklotDocs()
    await readBacklotDocs(call, machines, terminals, 2000)
    expect(calls).toHaveLength(4)
  })

  it('returns no machine for a missing or unreadable document, without throwing', async () => {
    const call = vi.fn(async () => { throw new Error('no document') })
    await expect(readBacklotDocs(call, machines, terminals, 1000)).resolves.toEqual([])
    const empty = vi.fn(async () => ({ value: { schema: 'backlot/2' } }))
    await expect(readBacklotDocs(empty, machines, terminals, 1000)).resolves.toEqual([])
  })

  it('prefixes remote role terminals with <machine>/ and detects backlot-server', async () => {
    const remoteDoc = {
      ...fullDoc,
      studios: [{
        ...fullDoc.studios[0]!,
        roles: [
          { role: 'dev', name: 'alice', terminal: 't1', state: 'live' },
          { role: 'qa', name: 'bob', terminal: 'host-b/t2', state: 'live' },
          { role: 'ops', name: 'carol', terminal: null, state: 'live' },
        ],
      }],
    }
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      return params.on === 'host-b' ? { value: remoteDoc } : { value: null }
    })
    const views = await readBacklotDocs(call, machines, [{ address: 'host-b/t9', name: 'backlot-server', state: 'live', cwd: '/home/user' }], 1000)
    expect(views).toHaveLength(1)
    expect(views[0]!.stageRunning).toBe(true)
    expect(views[0]!.summary.studios[0]!.roles.map(r => r.terminal)).toEqual(['host-b/t1', 'host-b/t2', null])
  })

  it('reads backlot from the publishing secondary session and keeps session caches separate', async () => {
    const primary = {
      localKey: '',
      endpoint: '/run/default.sock',
      call: vi.fn(async (method: string) => method === 'machine.list' ? { machines: [] } : method === 'terminal.list' ? { terminals: [] } : { value: null }),
    }
    const secondary = {
      localKey: 'cafecafecafecafe',
      endpoint: '/run/backlot.sock',
      call: vi.fn(async (method: string) => method === 'machine.list' ? { machines: [] }
        : method === 'terminal.list' ? { terminals: [{ address: 't9', name: 'backlot-server', state: 'live', cwd: '/home/user' }] }
          : { value: fullDoc }),
    }
    const res = await readPoolBacklotDocs([primary, secondary])
    expect(res.ok).toBe(true)
    expect(res.views).toHaveLength(1)
    expect(res.views[0]!.stageRunning).toBe(true)
    expect(res.views[0]!.summary.studios[0]!.id).toBe('shop')
  })

  it('keeps local machine documents from every session, tagged with their session tab key', async () => {
    const emptyLotDoc = {
      schema: 'backlot/1',
      updated_ms: 100,
      studios: [],
      hollywood: { state: 'live', headline: 'empty lot — no studios, no cards; watching', cards: [] },
    }
    const primary = {
      primary: true,
      localKey: '',
      endpoint: '/run/default.sock',
      call: vi.fn(async (method: string) => method === 'hello' ? { core: { id: 'core-default', name: 'host-a' } }
        : method === 'machine.list' ? { machines: [] }
          : method === 'terminal.list' ? { terminals: [{ address: 't1', name: 'backlot-stage', state: 'live', cwd: '/home/user' }] }
            : { value: emptyLotDoc }),
    }
    const secondary = {
      primary: false,
      localKey: '',
      endpoint: '/run/acme-shop.sock',
      call: vi.fn(async (method: string) => method === 'hello' ? { core: { id: 'core-acme', name: 'host-a' } }
        : method === 'machine.list' ? { machines: [] }
          : method === 'terminal.list' ? { terminals: [{ address: 't1', name: 'backlot-stage', state: 'live', cwd: '/home/user/acme-shop' }] }
            : { value: fullDoc }),
    }
    const res = await readPoolBacklotDocs([primary, secondary], 1000, () => 'host-a')
    expect(res.ok).toBe(true)
    expect(res.views).toHaveLength(2)
    expect(res.views.map(v => ({ session: (v as BacklotMachineView & { session?: string }).session, machine: v.machine, studios: v.summary.studios.length, headline: v.summary.hollywood?.headline }))).toEqual([
      { session: '', machine: '', studios: 0, headline: 'empty lot — no studios, no cards; watching' },
      { session: sessionIdScope('/run/acme-shop.sock'), machine: '', studios: 1, headline: 'Ship it' },
    ])
  })

  it('collapses the same core reached locally and remotely within a session, without dropping another session', async () => {
    const primary = {
      primary: true,
      localKey: '',
      endpoint: '/run/default.sock',
      call: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'hello') return { core: { id: 'core-a', name: 'host-a' } }
        if (method === 'machine.list') return { machines: [{ id: 'core-a', name: 'host-a-loopback', state: 'connected' }, { id: 'core-b', name: 'host-b', state: 'connected' }] }
        if (method === 'terminal.list') return { terminals: [] }
        return { value: params.on === 'host-b' ? { ...fullDoc, studios: [studio({ id: 'beta', title: 'Beta' })] } : fullDoc }
      }),
    }
    const secondary = {
      primary: false,
      localKey: '',
      endpoint: '/run/acme-shop.sock',
      call: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'hello') return { core: { id: 'core-c', name: 'host-a' } }
        if (method === 'machine.list') return { machines: [{ id: 'core-b', name: 'host-b', state: 'connected' }] }
        if (method === 'terminal.list') return { terminals: [] }
        return { value: params.on === 'host-b' ? { ...fullDoc, studios: [studio({ id: 'beta-sec', title: 'Beta sec' })] } : fullDoc }
      }),
    }
    const res = await readPoolBacklotDocs([primary, secondary], 1000, () => 'host-a')
    expect(res.ok).toBe(true)
    expect(res.views.map(v => [(v as BacklotMachineView & { session?: string }).session, v.machine])).toEqual([
      ['', ''],
      ['', 'host-b'],
      [sessionIdScope('/run/acme-shop.sock'), ''],
      [sessionIdScope('/run/acme-shop.sock'), 'host-b'],
    ])
  })

  it('routes actions to the entry matching (session, machine) even when both have local machine ""', async () => {
    const primary = {
      primary: true,
      localKey: '',
      endpoint: '/run/default.sock',
      call: vi.fn(async (method: string) => method === 'machine.list' ? { machines: [] }
        : method === 'terminal.list' ? { terminals: [] }
          : { value: { schema: 'backlot/1', studios: [], hollywood: { state: 'live', headline: 'empty lot', cards: [] } } }),
    }
    const secondary = {
      primary: false,
      localKey: '',
      endpoint: '/run/acme-shop.sock',
      call: vi.fn(async (method: string) => method === 'machine.list' ? { machines: [] }
        : method === 'terminal.list' ? { terminals: [] }
          : { value: fullDoc }),
    }
    const entries = [primary, secondary]
    const secKey = sessionIdScope('/run/acme-shop.sock')
    await readPoolBacklotDocs(entries, 1000, () => 'host-a')
    expect(await findBacklotActionEntry(entries, '', secKey, 1000)).toBe(secondary)
    expect(await findBacklotActionEntry(entries, '', '', 1000)).toBe(primary)

    // Executing the routed action sends terminal.run only to the target session entry.
    const routed = (await findBacklotActionEntry(entries, '', secKey, 1000))!
    secondary.call.mockResolvedValueOnce({
      address: 't9', state: 'finished', exit_code: 0, output: 'ok\n',
      wait: { terminal: 't9', ended: true, exit_code: 0, reason: 'exit', turn: 1, children: [] },
    })
    primary.call.mockClear()
    secondary.call.mockClear()
    const actionRes = await runBacklotAction(
      { call: (m, p, t) => routed.call(m, p, t), clearDocs: clearBacklotDocs },
      { kind: 'tell-hollywood', session: secKey, machine: '', text: 'Ship it' },
    )
    expect(actionRes).toEqual({ ok: true, output: 'ok' })
    expect(secondary.call).toHaveBeenCalledWith('terminal.run', expect.objectContaining({ line: expect.stringContaining("'tell' 'hollywood' '--text' 'Ship it'") }), 30000)
    expect(primary.call).not.toHaveBeenCalled()

    // Cold cache after clearBacklotDocs still routes to the right session.
    clearBacklotDocs()
    expect(await findBacklotActionEntry(entries, '', secKey, 2000)).toBe(secondary)

    // An unknown/stopped session never falls back to primary.
    expect(await findBacklotActionEntry(entries, '', 'facefacefaceface', 2000)).toBeUndefined()
  })
})

describe('runBacklotAction', () => {
  const runner = (result: unknown) => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return method === 'terminal.run' ? result : {}
    })
    return { call, calls, clearDocs: vi.fn() }
  }
  // The real herdr-core RunResult with `wait` (tests/fixtures/core-0.1.17.json).
  const done = (exit: number, output = 'ok\n') => ({
    address: 'host-b/t9', state: 'finished', exit_code: exit, output,
    wait: { terminal: 'host-b/t9', ended: true, exit_code: exit, reason: 'exit', turn: 1, children: [] },
  })

  it('waits for a remote action, reads its RunResult and clears the documents', async () => {
    const deps = runner(done(0, 'applied c1\n'))
    const r = await runBacklotAction(deps, { kind: 'card-apply', machine: 'host-b', cardId: 'c1' })
    expect(r).toEqual({ ok: true, output: 'applied c1' })
    const run = deps.calls.find(c => c.method === 'terminal.run')!.params
    expect(run).toMatchObject({ on: 'host-b', wait: true, timeout: 8, rm: true, no_parent: true, no_notify: true, labels: { 'backlot.web_action': '1' } })
    expect(String(run.line)).toContain(`'card' 'apply' 'c1'`)
    expect(String(run.line)).toContain('command -v backlot')
    expect(String(run.line)).toContain('$HOME/.local/bin/backlot')
    expect(deps.clearDocs).toHaveBeenCalledOnce()
  })

  it("omits `on` for this machine and quotes a text that tries to break out", async () => {
    const deps = runner(done(0))
    await runBacklotAction(deps, { kind: 'tell', machine: '', studio: 'shop', role: 'dev', text: `it's done; id` })
    const run = deps.calls.find(c => c.method === 'terminal.run')!.params
    expect(run.on).toBeUndefined()
    expect(run.wait).toBe(true)
    expect(String(run.line)).toContain(`'--text' 'it'\\''s done; id'`)
  })

  it('refuses an invalid action without running anything', async () => {
    const deps = runner(done(0))
    await expect(runBacklotAction(deps, { kind: 'tell', machine: '', studio: 'shop', role: 'dev', text: '' })).resolves
      .toEqual({ ok: false, status: 400, error: 'Invalid action' })
    expect(deps.calls).toEqual([])
  })

  it('maps exit 126/127 to a missing backlot', async () => {
    for (const code of [126, 127]) {
      const deps = runner(done(code, 'command not found\n'))
      await expect(runBacklotAction(deps, { kind: 'stage-start', machine: '' })).resolves
        .toEqual({ ok: false, status: 400, error: BACKLOT_NOT_FOUND, output: 'command not found' })
      expect(deps.clearDocs).not.toHaveBeenCalled()
    }
  })

  it('reports the first output line of a failed command', async () => {
    const deps = runner(done(2, 'E_BACKLOT: refused\nmore detail\n'))
    await expect(runBacklotAction(deps, { kind: 'stage-start', machine: '' })).resolves
      .toEqual({ ok: false, status: 502, error: 'E_BACKLOT: refused', output: 'E_BACKLOT: refused\nmore detail' })
    expect(deps.clearDocs).not.toHaveBeenCalled()
  })

  it('kills and removes a command still running when the wait times out', async () => {
    const deps = runner({
      address: 't9', state: 'live', exit_code: null, output: null,
      wait: { terminal: 't9', ended: false, reason: 'timeout', turn: 0, children: [] },
    })
    await expect(runBacklotAction({ ...deps, waitMs: 0 }, { kind: 'stage-start', machine: '' })).resolves
      .toEqual({ ok: false, status: 502, error: BACKLOT_TIMEOUT })
    const methods = deps.calls.map(c => c.method)
    expect(methods).toContain('terminal.kill')
    expect(methods).toContain('terminal.rm')
    expect(methods.indexOf('terminal.kill')).toBeLessThan(methods.indexOf('terminal.rm'))
    expect(deps.calls.find(c => c.method === 'terminal.run')!.params.timeout).toBe(1)
    expect(deps.clearDocs).not.toHaveBeenCalled()
  })

  it('reads an older RunResult without wait and reaps its terminal', async () => {
    const deps = runner({ address: 't9', state: 'finished', exit_code: 0, output: 'done\n' })
    await expect(runBacklotAction(deps, { kind: 'stage-start', machine: '' })).resolves
      .toEqual({ ok: true, output: 'done' })
    expect(deps.calls.filter(c => c.method === 'terminal.rm')).toHaveLength(1)
    expect(deps.clearDocs).toHaveBeenCalledOnce()
  })
})

describe('readBacklotDesignDoc', () => {
  const runner = (result: unknown) => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return method === 'terminal.run' ? result : {}
    })
    return { call, calls }
  }
  const done = (exit: number, output: string) => ({
    address: 'host-a/t9', state: 'finished', exit_code: exit, output,
    wait: { terminal: 'host-a/t9', ended: true, exit_code: exit, reason: 'exit', turn: 1, children: [] },
  })

  it('runs backlot report show for valid design paths and preserves full markdown', async () => {
    const mdBody = '# Design discussion · req v1\n\n## R1\n\n### §R1.W Proposal · writer (#2)\n\nUse WAL.\n'
    const deps = runner(done(0, `\u001b[32m${mdBody}\u001b[0m`))
    const res = await readBacklotDesignDoc(deps, { machine: 'host-a', studio: 'acme-shop', file: 'design/v1.md' })
    expect(res).toEqual({ ok: true, file: 'design/v1.md', text: mdBody.trimEnd(), truncated: false })
    const run = deps.calls.find(c => c.method === 'terminal.run')!.params
    expect(run.on).toBe('host-a')
    expect(String(run.line)).toContain(`'report' 'show' '--studio' 'acme-shop' '--file' 'design/v1.md'`)
  })

  it('caps oversized documents and marks them truncated', async () => {
    const big = '# Header\n' + 'a'.repeat(MAX_DESIGN_DOC_CHARS + 500)
    const deps = runner(done(0, big))
    const res = await readBacklotDesignDoc(deps, { machine: '', studio: 'acme-shop', file: 'design/v1-final.md' })
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true)
    expect(res.text!.length).toBe(MAX_DESIGN_DOC_CHARS)
  })

  it('refuses an invalid path without touching terminal.run', async () => {
    const deps = runner(done(0, 'secret'))
    const res = await readBacklotDesignDoc(deps, { machine: '', studio: 'acme-shop', file: '../secrets.md' })
    expect(res).toEqual({ ok: false, status: 400, error: 'Invalid design document request' })
    expect(deps.calls).toEqual([])
  })
})
