import { describe, expect, it } from 'vitest'
import type { AgentCensus, AgentProcess } from '../server/utils/agentCensus'
import {
  type CmdCandidate, cmdHeaderOf, cmdProjectsRoot, cmdResumeSeed, cmdSelect, cmdSessionFile
} from '../server/utils/commandCodeSessions'

const HOME = '/home/user'
const ROOT = cmdProjectsRoot(HOME)
const CWD = '/home/user/acme-shop'
const OTHER = '/home/user/other'
const TICKS = 4242
const BORN = 1_700_000_000_000

const U1 = '01234567-89ab-cdef-0123-456789abcdef'
const U2 = '11111111-2222-4333-8444-555555555555'
const U3 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const proc = (pid: number, cwd: string | undefined = CWD, extra: Partial<AgentProcess> = {}): AgentProcess => ({
  pid, startTicks: TICKS, cwd, startedAt: BORN, ...extra
})
const census = (processes: AgentProcess[], extra: Partial<AgentCensus> = {}): AgentCensus => ({
  complete: true, processes, uncertain: [], scanned: processes.length, unknown: 0, ...extra
})
const cand = (id: string, cwd: string, mtimeMs: number, dir = 'proj'): CmdCandidate =>
  ({ file: `${ROOT}/${dir}/${id}.jsonl`, id, cwd, mtimeMs })
const select = (over: Partial<Parameters<typeof cmdSelect>[0]> = {}) => cmdSelect({
  root: ROOT,
  census: census([proc(9001)]),
  target: { pid: 9001, startTicks: TICKS },
  candidates: { complete: true, items: [] },
  ...over
})
const ok = (r: ReturnType<typeof cmdSelect>) => 'file' in r ? r : null
const why = (r: ReturnType<typeof cmdSelect>) => 'unavailable' in r ? r.unavailable : null

describe('commandCodeSessions', () => {
  it('selects the unique latest post-birth write for one same-cwd peer', () => {
    const r = select({ candidates: { complete: true, items: [cand(U1, CWD, BORN + 10), cand(U2, CWD, BORN + 50)] } })
    expect(ok(r)).toEqual({ file: `${ROOT}/proj/${U2}.jsonl`, session: U2 })
  })

  it('ignores peers and files in other cwds', () => {
    const r = select({
      census: census([proc(9001), proc(9002, OTHER)]),
      candidates: { complete: true, items: [cand(U1, OTHER, BORN + 900), cand(U2, CWD, BORN + 10)] }
    })
    expect(ok(r)).toEqual({ file: `${ROOT}/proj/${U2}.jsonl`, session: U2 })
  })

  it('is unavailable with a second live same-cwd peer, nested or not', () => {
    const items = { complete: true, items: [cand(U1, CWD, BORN + 10)] }
    expect(why(select({ census: census([proc(9001), proc(9002)]), candidates: items }))).toBe('peers')
    // A nested agent (child pid) is still a peer: never deduplicated by ancestry.
    expect(why(select({ census: census([proc(9001), proc(9002, CWD, { ppid: 9001 })]), candidates: items }))).toBe('peers')
  })

  it('scopes unclassifiable processes to the cwds a lookup could touch', () => {
    const items = { complete: true, items: [cand(U1, CWD, BORN + 10)] }
    // An unknown elsewhere cannot affect this lookup: the correct file wins.
    expect(ok(select({ census: census([proc(9001)], { uncertain: [proc(7001, OTHER)] }), candidates: items }))?.session).toBe(U1)
    // Same cwd: a possible hidden peer — unavailable.
    expect(why(select({ census: census([proc(9001)], { uncertain: [proc(7001)] }), candidates: items }))).toBe('peers')
    // Unreadable cwd: irrelevance can never be proven — unavailable anywhere.
    expect(why(select({ census: census([proc(9001)], { uncertain: [proc(7001, OTHER, { cwd: undefined })] }), candidates: items }))).toBe('peers')
    // A relative or NUL cwd is no proof of irrelevance either.
    expect(why(select({ census: census([proc(9001)], { uncertain: [proc(7001, 'rel/dir')] }), candidates: items }))).toBe('peers')
    expect(why(select({ census: census([proc(9001)], { uncertain: [proc(7001, '/w/x\0tail')] }), candidates: items }))).toBe('peers')
    // An eligible candidate's header cwd is relevant even cross-cwd: the
    // launch target's file may be the unknown's write.
    const x = { complete: true, items: [cand(U1, CWD, BORN + 10), cand(U3, OTHER, BORN + 900)] }
    const seed = { argv: ['cmd', '--session', U3], argvExact: true }
    expect(why(select({ argv: seed, census: census([proc(9001)], { uncertain: [proc(7001, OTHER)] }), candidates: x }))).toBe('peers')
    // Without the seed that file is never eligible: the same unknown is
    // irrelevant again and the legitimate target file wins.
    expect(ok(select({ census: census([proc(9001)], { uncertain: [proc(7001, OTHER)] }), candidates: x }))?.session).toBe(U1)
  })

  it('is unavailable when the target row is missing or the generation changed', () => {
    expect(why(select({ target: { pid: 9999, startTicks: TICKS } }))).toBe('target')
    expect(why(select({ target: { pid: 9001, startTicks: TICKS + 1 } }))).toBe('target')
    expect(why(select({ census: census([proc(9001), proc(9001, CWD, { startTicks: 1 })]) }))).toBe('target')
    expect(why(select({ census: census([proc(9001, CWD, { startedAt: undefined })]) }))).toBe('target')
    expect(why(select({ census: census([proc(9001, CWD, { cwd: undefined })]) }))).toBe('target')
  })

  it('is unavailable on incomplete census or candidate evidence', () => {
    expect(why(select({ census: census([proc(9001)], { complete: false, incomplete: 'raced' }) }))).toBe('incomplete')
    expect(why(select({ candidates: { complete: false, items: [] } }))).toBe('incomplete')
  })

  it('requires a strict post-birth write; equality is not eligibility', () => {
    expect(why(select({ candidates: { complete: true, items: [cand(U1, CWD, BORN)] } }))).toBe('empty')
    const r = select({ candidates: { complete: true, items: [cand(U1, CWD, BORN + 1)] } })
    expect(ok(r)?.session).toBe(U1)
  })

  it('applies a raised proven birth bound and refuses a weakening one', () => {
    // bornMs is the caller's proven upper bound on agent start (e.g. first
    // machine observation of this generation as cmd): files in the
    // fork->exec gap are no longer eligible.
    const target = (bornMs?: number) => ({ pid: 9001, startTicks: TICKS, ...(bornMs === undefined ? {} : { bornMs }) })
    const items = { complete: true, items: [cand(U1, CWD, BORN + 10), cand(U2, CWD, BORN + 50)] }
    expect(why(select({ target: target(BORN + 40), candidates: { complete: true, items: [cand(U1, CWD, BORN + 10)] } }))).toBe('empty')
    expect(ok(select({ target: target(BORN + 40), candidates: items }))?.session).toBe(U2)
    // The raised bound gates the cross-cwd seed too — no seed exception.
    const argv = { argv: ['cmd', '--session', U3], argvExact: true }
    const seedItems = { complete: true, items: [cand(U3, OTHER, BORN + 30, 'proj')] }
    expect(why(select({ argv, target: target(BORN + 40), candidates: seedItems }))).toBe('empty')
    // A bound below process birth would WEAKEN the proof — refused.
    expect(why(select({ target: target(BORN - 1), candidates: items }))).toBe('target')
    expect(why(select({ target: target(Number.NaN), candidates: items }))).toBe('target')
    // Omitted: the generation bound defaults (launch-proven targets only).
    expect(ok(select({ target: target(), candidates: items }))?.session).toBe(U2)
  })

  it('is unavailable before the first flush writes anything', () => {
    expect(why(select())).toBe('empty')
  })

  it('skips malformed candidate rows instead of trusting them', () => {
    const bad = [
      { file: 1, id: U1, cwd: CWD, mtimeMs: BORN + 9 },
      { file: `${ROOT}/proj/${U1}.jsonl`, id: U1, cwd: CWD, mtimeMs: Number.NaN },
      { file: `${ROOT}/proj/${U1}.jsonl`, id: U1, mtimeMs: BORN + 9 } as unknown as CmdCandidate
    ]
    expect(why(select({ candidates: { complete: true, items: bad } }))).toBe('empty')
  })

  it('is unavailable when equal latest mtimes name different sessions', () => {
    const items = [cand(U1, CWD, BORN + 50, 'p1'), cand(U2, CWD, BORN + 50, 'p2'), cand(U3, CWD, BORN + 40)]
    expect(why(select({ candidates: { complete: true, items } }))).toBe('tie')
  })

  it('follows /clear to the new file and /resume appends to the old one', () => {
    // /clear: the process switched to a new session file post-birth.
    let r = select({ candidates: { complete: true, items: [cand(U1, CWD, BORN + 10), cand(U2, CWD, BORN + 60)] } })
    expect(ok(r)?.session).toBe(U2)
    // In-process /resume appends to an old file; its post-birth write wins.
    r = select({ candidates: { complete: true, items: [cand(U1, CWD, BORN + 70), cand(U2, CWD, BORN + 20)] } })
    expect(ok(r)?.session).toBe(U1)
  })

  it('seeds a cross-cwd resume target from exact argv, still post-birth only', () => {
    const argv = { argv: ['node', '/opt/command-code/dist/index.mjs', '--session', U3], argvExact: true }
    const items = [cand(U3, OTHER, BORN + 30, 'proj')] // header cwd differs: cross-cwd resume appends here
    expect(ok(select({ argv, candidates: { complete: true, items } }))?.session).toBe(U3)
    // No pre-birth exception for resume.
    expect(why(select({ argv, candidates: { complete: true, items: [cand(U3, OTHER, BORN, 'proj')] } }))).toBe('empty')
  })

  it('lets a newer same-cwd write supersede the launch target', () => {
    const argv = { argv: ['cmd', '--session', U1], argvExact: true }
    const items = [cand(U1, CWD, BORN + 20), cand(U2, CWD, BORN + 80)]
    expect(ok(select({ argv, candidates: { complete: true, items } }))?.session).toBe(U2)
  })

  it('requires a full-id seed to be unique across project dirs', () => {
    const argv = { argv: ['cmd', '--session', U1], argvExact: true }
    const items = [cand(U1, CWD, BORN + 20, 'p1'), cand(U1, CWD, BORN + 20, 'p2'), cand(U2, CWD, BORN + 80)]
    // Ambiguous seed contributes nothing; the plain cwd rule still applies.
    expect(ok(select({ argv, candidates: { complete: true, items } }))?.session).toBe(U2)
  })

  it('never infers a peer by subtracting another peer\'s session', () => {
    const argv = { argv: ['cmd', '--session', U1], argvExact: true }
    const items = [cand(U1, CWD, BORN + 20), cand(U2, CWD, BORN + 30)]
    expect(why(select({ argv, census: census([proc(9001), proc(9002)]), candidates: { complete: true, items } }))).toBe('peers')
  })

  it('rejects every unsupported or conflicting agent option shape', () => {
    const seed = (av: string[]) => cmdResumeSeed(ROOT, av)
    // The review's reproductions: operands and conflicting selectors must
    // never produce an exact seed.
    expect(seed(['command-code', '--prompt', '--session', U1])).toBeNull()
    expect(seed(['command-code', '--continue', '--session', U1])).toBeNull()
    expect(seed(['command-code', '--resume', 'other', '--session', U1])).toBeNull()
    expect(seed(['command-code', '--session', U1, '--continue'])).toBeNull()
    // More conflicts and unsupported shapes → closed.
    expect(seed(['cmd', '-c', '--session', U1])).toBeNull()
    expect(seed(['cmd', '--fork-session', '--session', U1])).toBeNull()
    expect(seed(['cmd', '--no-session', '--session', U1])).toBeNull()
    expect(seed(['cmd', '--session', U1, '--fork-session'])).toBeNull()
    expect(seed(['cmd', '--session', U1, '--resume', 'other'])).toBeNull()
    expect(seed(['cmd', '-r', U1, '--session', U2])).toBeNull()
    expect(seed(['cmd', '--session', U1, '--session', U2])).toBeNull()
    expect(seed(['cmd', '--mystery', '--session', U1])).toBeNull()
    expect(seed(['cmd', '--mystery=x', '--session', U1])).toBeNull()
    expect(seed(['cmd', '--session'])).toBeNull()
    expect(seed(['cmd', '--session='])).toBeNull()
    // Not exact evidence: inexact argv, names, prefixes, continue/latest.
    expect(seed(['cmd', '-r', U1])).toBeNull()
    expect(seed(['cmd', '--resume=' + U1])).toBeNull()
    expect(seed(['cmd', '-c'])).toBeNull()
    expect(seed(['cmd', '--session', U1.slice(0, 8)])).toBeNull()
    expect(seed(['cmd', '--session', 'name only'])).toBeNull()
    expect(seed(['cmd', 'summarize --session ' + U1])).toBeNull() // positional prompt
    expect(seed(['cmd', '--', '--session', U1])).toBeNull()        // after --
    // Kept positives: direct and interpreter launches, = form, id and path.
    expect(seed(['cmd', '--session', U1])).toEqual({ kind: 'id', value: U1 })
    expect(seed(['cmd', '--session=' + U1])).toEqual({ kind: 'id', value: U1 })
    expect(seed(['node', '/opt/command-code/dist/index.mjs', '--session', U1])).toEqual({ kind: 'id', value: U1 })
    expect(seed(['cmd', '--session', `${ROOT}/proj/${U1}.jsonl`])).toEqual({ kind: 'path', value: `${ROOT}/proj/${U1}.jsonl` })
    // A supported non-selector keeps the seed working.
    expect(seed(['cmd', '--model', 'glm', '--session', U1])).toEqual({ kind: 'id', value: U1 })
    expect(seed(['cmd', '--prompt', 'run the tests', '--session', U1])).toEqual({ kind: 'id', value: U1 })
  })

  it('ignores argv entirely when argvExact is not true', () => {
    const items = [cand(U1, CWD, BORN + 20), cand(U2, CWD, BORN + 30), cand(U3, OTHER, BORN + 40)]
    const r = select({ argv: { argv: ['cmd', '--session', U3], argvExact: false }, candidates: { complete: true, items } })
    expect(ok(r)?.session).toBe(U2)
  })

  it('rejects unvalidated candidates even when the list claims complete', () => {
    const bad = [
      { file: `/etc/${U1}.jsonl`, id: U1, cwd: CWD, mtimeMs: BORN + 9 },               // outside root
      { file: `${ROOT}/proj/${U2}.jsonl`, id: U1, cwd: CWD, mtimeMs: BORN + 9 },        // id != basename
      { file: `${ROOT}/proj/../proj/${U1}.jsonl`, id: U1, cwd: CWD, mtimeMs: BORN + 9 }, // traversal
      { file: `${ROOT}/proj/${U1}.jsonl`, id: U1, cwd: 'rel/dir', mtimeMs: BORN + 9 },   // relative header cwd
      { file: `${ROOT}/proj/${U1}.jsonl`, id: U1, cwd: '/x\0', mtimeMs: BORN + 9 }       // NUL cwd
    ]
    expect(why(select({ candidates: { complete: true, items: bad } }))).toBe('empty')
  })

  it('rejects unsafe target/proc metadata', () => {
    const items = { complete: true, items: [cand(U1, CWD, BORN + 10)] }
    expect(why(select({ target: { pid: 0, startTicks: TICKS }, census: census([proc(0)]), candidates: items }))).toBe('target')
    expect(why(select({ target: { pid: 1.5, startTicks: TICKS }, candidates: items }))).toBe('target')
    expect(why(select({ census: census([proc(9001, CWD, { startedAt: Number.NaN })]), candidates: items }))).toBe('target')
    expect(why(select({ census: census([proc(9001, 'rel/dir')]), candidates: items }))).toBe('target')
    expect(why(select({ census: census([proc(9001, '/x\0')]), candidates: items }))).toBe('target')
  })

  it('proves the argv boundary: node flags and script args are not agent args', () => {
    // U3 lives in another cwd: it can only win when a --session seed survives.
    const items = [cand(U1, CWD, BORN + 20), cand(U2, CWD, BORN + 30), cand(U3, OTHER, BORN + 40)]
    const pick = (av: string[]) => ok(select({ argv: { argv: av, argvExact: true }, candidates: { complete: true, items } }))?.session
    // --session after the real script is an agent flag → seeds U3.
    expect(pick(['node', '/opt/command-code/dist/index.mjs', '--session', U3])).toBe(U3)
    // --session passed to node itself (before the script) is not agent evidence.
    expect(pick(['node', '--session', U3, '/opt/command-code/dist/index.mjs'])).toBe(U2)
    // Direct binary/script argv0: agent args start after argv0.
    expect(pick(['/usr/local/bin/cmd', '--session=' + U3])).toBe(U3)
    expect(pick(['command-code', '--session', U3])).toBe(U3)
    // Unknown interpreter option shape: boundary unproven → no seed.
    expect(pick(['node', '--mystery', 'x', '/opt/command-code/dist/index.mjs', '--session', U3])).toBe(U2)
  })

  it('seeds from an absolute confined transcript path', () => {
    const f = `${ROOT}/proj/${U1}.jsonl`
    const argv = { argv: ['cmd', '--session', f], argvExact: true }
    expect(ok(select({ argv, candidates: { complete: true, items: [cand(U1, OTHER, BORN + 5)] } }))?.session).toBe(U1)
    expect(cmdResumeSeed(ROOT, ['cmd', '--session', `${ROOT}/../${U1}.jsonl`])).toBeNull()           // escapes root
    expect(cmdResumeSeed(ROOT, ['cmd', '--session', `${ROOT}/proj/${U1}.meta.json`])).toBeNull()     // sidecar shape
    expect(cmdResumeSeed(ROOT, ['cmd', '--session', `rel/${U1}.jsonl`])).toBeNull()                  // not absolute
    expect(cmdResumeSeed(ROOT, ['cmd', '--session', `${ROOT}/a/b/${U1}.jsonl`])).toBeNull()          // too deep
  })
})

describe('collector validation helpers', () => {
  it('validates the v3 header line', () => {
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: U1, cwd: CWD }))).toEqual({ id: U1, cwd: CWD })
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 2, id: U1, cwd: CWD }))).toBeNull()
    expect(cmdHeaderOf(JSON.stringify({ type: 'user', version: 3, id: U1, cwd: CWD }))).toBeNull()
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: 'short', cwd: CWD }))).toBeNull()
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: U1 }))).toBeNull()
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: U1, cwd: 'rel/dir' }))).toBeNull()
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: U1, cwd: '/x\0' }))).toBeNull()
    expect(cmdHeaderOf('not json')).toBeNull()
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: U1, cwd: CWD, pad: 'x'.repeat(20000) }))).toBeNull()
    // The cap is bytes, not UTF-16 length: 9084 chars but 18084 UTF-8 bytes.
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: U1, cwd: '/' + 'λ'.repeat(9000) }))).toBeNull()
    // A supported unicode cwd under the byte cap stays valid.
    expect(cmdHeaderOf(JSON.stringify({ type: 'session', version: 3, id: U1, cwd: '/home/user/λαμβδα' }))).toEqual({ id: U1, cwd: '/home/user/λαμβδα' })
  })

  it('confines session files to <root>/<dir>/<uuid>.jsonl', () => {
    expect(cmdSessionFile(ROOT, `${ROOT}/proj/${U1}.jsonl`)).toEqual({ dir: 'proj', id: U1 })
    expect(cmdSessionFile(ROOT, `${ROOT}/my dir/${U1}.jsonl`)).toEqual({ dir: 'my dir', id: U1 })
    expect(cmdSessionFile(ROOT, `${ROOT}/proj/${U1}.checkpoints.jsonl`)).toBeNull()
    expect(cmdSessionFile(ROOT, `${ROOT}/${U1}.jsonl`)).toBeNull()
    expect(cmdSessionFile(ROOT, `${ROOT}/proj/not-a-uuid.jsonl`)).toBeNull()
    expect(cmdSessionFile(ROOT, `/etc/${U1}.jsonl`)).toBeNull()
    // Raw '.', '..' and empty segments, NUL and non-canonical shapes are
    // rejected before normalization — never normalized into acceptance.
    expect(cmdSessionFile(ROOT, `${ROOT}/proj/../proj/${U1}.jsonl`)).toBeNull()
    expect(cmdSessionFile(ROOT, `${ROOT}/proj/./${U1}.jsonl`)).toBeNull()
    expect(cmdSessionFile(ROOT, `${ROOT}//${U1}.jsonl`)).toBeNull()
    expect(cmdSessionFile(ROOT, `${ROOT}/proj/${U1}.jsonl/`)).toBeNull()
    expect(cmdSessionFile(ROOT, `${ROOT}/proj/${U1}.jsonl\0`)).toBeNull()
    expect(cmdSessionFile('rel/root', `rel/root/proj/${U1}.jsonl`)).toBeNull()
  })
})
