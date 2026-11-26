// WHR-404: `wherdr alfred`, Alfred's own command: parsing, the dry run shown
// before a change, the server's run with its token from Alfred's home, the
// route (this machine only) and the guard's token exemption.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALFRED_COMMANDS, alfredCommandList, dryRun, parseAlfredCommand } from '../shared/pm/alfredCli'
import { NOTES_COMMANDS, NOTES_RULE } from '../shared/notes'
import { applyProposedChange, runAlfredCommand } from '../server/utils/alfredCli'
import { ALFRED_TOKEN_FILE, answerProposal, issueAlfredToken, setCoordinatorAgent, userMessageTo } from '../server/utils/pmCoordinator'
import { MAIN } from '../shared/pm/coordinator'
import { createPmStore } from '../server/utils/pmStore'
import { actOnCard } from '../server/utils/uiActions'
import { patchSettings, readSettings } from '../server/utils/settings'
import { CUSTOM_THEMES_MAX, readCustomThemes, themeFile, writeCustomThemes } from '../app/utils/customThemes'
import { THEMES } from '../app/utils/themes'
import { cliTokenCall } from '../server/utils/network'
import { common, company } from '../shared/pm/examples'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

// A coordinator's start is not run here: APP's fails, the others start.
const started = vi.hoisted(() => [] as string[])
vi.mock('../server/utils/pmCoordinator', async orig => ({
  ...(await orig<object>()),
  startCoordinator: vi.fn(async (_d: unknown, key: string) => { if (key === 'APP') throw new Error('agent missing'); started.push(key); return { terminal: `t-${key}` } }),
}))
// Machine '' has every agent slot taken; Claude's week is near its limit.
vi.mock('../server/utils/pmMemory', async orig => ({ ...(await orig<object>()), memoryState: vi.fn(async (_d: unknown, key: string) => ({ agents: key ? 0 : 2, cap: 2 })) }))
vi.mock('../server/utils/pmReady', () => ({ checkMachine: vi.fn(async () => ({ items: [], at: 1, refused: 'gh login: not logged in' })) }))

describe('parseAlfredCommand', () => {
  it('reads the read-only commands', () => {
    expect(parseAlfredCommand(['projects'])).toEqual({ name: 'projects' })
    expect(parseAlfredCommand(['project', 'web'])).toEqual({ name: 'project', key: 'WEB' })
    expect(parseAlfredCommand(['coordinator', 'open', 'WEB'])).toEqual({ name: 'coordinator open', key: 'WEB' })
    expect(parseAlfredCommand(['settings', 'x'])).toMatchObject({ error: /^unknown command/ })
    expect(parseAlfredCommand(['projects', '--apply'])).toEqual({ error: '--apply is for a change only' })
    expect(parseAlfredCommand(['groups'])).toEqual({ name: 'groups' })
    expect(parseAlfredCommand(['brief'])).toEqual({ name: 'brief' })
    expect(parseAlfredCommand(['brief', '--group', 'Work', '--since', '2026-11-01'])).toEqual({ name: 'brief', group: 'Work', since: Date.parse('2026-11-01') })
    expect(parseAlfredCommand(['brief', '--all', '--group', 'Work'])).toMatchObject({ error: /^usage: wherdr alfred brief/ })
    expect(parseAlfredCommand(['brief', '--since', 'monday'])).toEqual({ error: '--since is a date: YYYY-MM-DD' })
    expect(parseAlfredCommand(['projects', '--all'])).toEqual({ error: '--all is for brief only' })
  })

  it('reads the changes, a dry run unless --apply', () => {
    expect(parseAlfredCommand(['project', 'add', 'web', '--machine', '', '--path', '/src/web', '--template', 'example:common'])).toEqual({
      name: 'project add', apply: false, input: { key: 'WEB', machine: '', path: '/src/web', template: 'example:common' },
    })
    expect(parseAlfredCommand(['project', 'template', 'WEB', 'none', '--apply'])).toEqual({ name: 'project template', apply: true, key: 'WEB', template: '' })
    expect(parseAlfredCommand(['coordinator', 'start', 'WEB', '--program', 'codex'])).toEqual({ name: 'coordinator start', apply: false, key: 'WEB', program: 'codex' })
    expect(parseAlfredCommand(['coordinator', 'start', 'WEB', '--resume', '--apply'])).toEqual({ name: 'coordinator start', apply: true, key: 'WEB', resume: true })
    expect(parseAlfredCommand(['coordinator', 'start', 'WEB', '--resume', '--program', 'codex'])).toEqual({ error: expect.stringContaining('no --program') })
    expect(parseAlfredCommand(['setting', 'set', 'theme', 'gruvbox', '--propose'])).toEqual({ name: 'setting set', propose: true, key: 'theme', value: 'gruvbox' })
    // Alfred never applies a setting itself.
    expect(parseAlfredCommand(['setting', 'set', 'theme', 'vesper', '--apply'])).toEqual({ error: expect.stringContaining('--propose puts a card the user applies') })
    expect(parseAlfredCommand(['projects', '--propose'])).toEqual({ error: expect.stringContaining('--propose is for setting set and the changes') })
    expect(parseAlfredCommand(['project', 'template', 'WEB', 'example:common', '--propose'])).toEqual({ name: 'project template', apply: false, propose: true, key: 'WEB', template: 'example:common' })
    // Saved templates are no longer offered: only the built-in examples.
    expect(parseAlfredCommand(['project', 'template', 'WEB', 'common'])).toEqual({ error: 'The template is example:<id> or none (see wherdr alfred examples)' })
    expect(parseAlfredCommand(['project', 'template', 'WEB', 'example:common', '--propose', '--apply'])).toEqual({ error: '--propose or --apply, not both' })
    expect(parseAlfredCommand(['project', 'machine', 'add', 'web', 'Mac', '--clone', '~/project'])).toEqual({ name: 'project machine', apply: false, key: 'WEB', action: 'add', machine: 'Mac', clone: '~/project' })
    expect(parseAlfredCommand(['project', 'machine', 'remove', 'WEB', 'mac', '--apply'])).toEqual({ name: 'project machine', apply: true, key: 'WEB', action: 'remove', machine: 'mac' })
    expect(parseAlfredCommand(['project', 'machine', 'add', 'WEB', 'mac'])).toEqual({ error: 'usage: wherdr alfred project machine add <KEY> <machine> --clone <folder> [--apply]' })
    expect(parseAlfredCommand(['project', 'machine', 'remove', 'WEB', 'mac', '--clone', '/x'])).toEqual({ error: '--clone is for add only' })
  })

  it('says what is wrong', () => {
    expect(parseAlfredCommand(['project', 'add', 'WEB', '--path', '/x'])).toEqual({ error: 'usage: wherdr alfred project add <KEY> --machine <key> --path <folder> [--name <name>] [--template example:<id>] [--apply]' })
    expect(parseAlfredCommand(['project', 'add', 'WEB', '--machine', '', '--path', '/x', '--force', 'y'])).toEqual({ error: 'unknown option --force' })
    expect(parseAlfredCommand(['coordinator', 'start', 'WEB', '--program', 'omp'])).toMatchObject({ name: 'coordinator start', key: 'WEB', program: 'omp' })
    expect(parseAlfredCommand(['coordinator', 'start', 'WEB', '--program', 'pi'])).toEqual({ error: '--program is claude, codex or omp' })
    expect(parseAlfredCommand(['setting', 'set', 'password', 'x'])).toMatchObject({ error: /^password is not a setting Alfred changes/ })
    // Only a value the app reads: no theme "light", no list setting.
    expect(parseAlfredCommand(['setting', 'set', 'theme', 'light'])).toMatchObject({ error: /^light is not a value of theme: one of wherdr-titanium, wherdr-neon/ })
    expect(parseAlfredCommand(['setting', 'set', 'showQuotas', 'yes'])).toEqual({ error: 'yes is not a value of showQuotas: one of 1, 0' })
    expect(parseAlfredCommand(['setting', 'set', 'hiddenAgents', '[]'])).toMatchObject({ error: /^hiddenAgents is not a setting Alfred changes/ })
    expect(parseAlfredCommand(['project', 'remove', 'WEB'])).toMatchObject({ error: /^unknown command: project remove WEB/ })
    expect(parseAlfredCommand('projects')).toEqual({ error: 'argv must be a list of words' })
  })

  it('reads the workflow and delegation commands', () => {
    expect(parseAlfredCommand(['project', 'workflow', 'edit', 'WEB'])).toEqual({ name: 'project workflow edit', key: 'WEB' })
    expect(parseAlfredCommand(['project', 'workflow', 'edit', 'WEB', '--apply'])).toEqual({ error: '--apply is for a change only' })
    expect(parseAlfredCommand(['project', 'workflow', 'edit'])).toEqual({ error: 'usage: wherdr alfred project workflow edit <KEY> < workflow.json' })
    expect(parseAlfredCommand(['tell', 'web', 'propose a workflow'])).toEqual({ name: 'tell', key: 'WEB', text: 'propose a workflow' })
    expect(parseAlfredCommand(['tell', 'WEB'])).toMatchObject({ error: /^usage: wherdr alfred tell/ })
    expect(parseAlfredCommand(['last', 'WEB'])).toEqual({ name: 'last', key: 'WEB' })
  })
})

describe('dryRun', () => {
  it('shows the change, the machine it reaches and the command that makes it', () => {
    expect(dryRun(['setting', 'set', 'theme', 'solar dark'], { change: ['setting theme: (default) → "solar dark"'], remote: 'mac' })).toEqual({
      dryRun: true,
      change: ['setting theme: (default) → "solar dark"'],
      remote: 'This reaches machine mac: make it only if the user asked for it',
      next: 'Show this to the user; only after their yes, run: wherdr alfred setting set theme \'solar dark\' --apply',
    })
  })
})

describe('runAlfredCommand', () => {
  let dir = '', store: ReturnType<typeof createPmStore>, token = ''
  const machines = [{ key: '', label: 'this', local: true, status: 'online' }, { key: 'mac', label: 'Mac', local: false, status: 'online' }]
  const checked: string[] = []
  let failCheck = false
  let herdrProjects = ''
  const deps = () => ({
    store, machines: () => machines, panes: () => [], urls: { local: 'http://127.0.0.1:7690' }, settingsFile: path.join(dir, 'settings.json'), dataDir: dir, herdrProjects,
    quotas: async () => ({ claude: { five: null, week: { used: 92, resetsAt: null, minutes: 10080 }, at: 1 }, codex: null }),
    check: async (m: string, f: string) => { if (failCheck) throw new Error('path: a folder inside the home folder'); if (f.endsWith('/gone')) throw new Error('This folder does not exist'); checked.push(`${m}:${f}`); return { path: f.replace(/^~/, '/home/user'), git: true } },
  }) as unknown as Parameters<typeof runAlfredCommand>[0]
  const run = (...argv: string[]) => runAlfredCommand(deps(), token, { argv })

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-cli-'))
    store = createPmStore(path.join(dir, 'pm'))
    await store.setEnabled(true)
    await issueAlfredToken(store, dir)
    token = (await fs.readFile(path.join(dir, ALFRED_TOKEN_FILE), 'utf8')).trim()
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind: 'user', at: Date.now() } })
    checked.length = 0
    failCheck = false
    herdrProjects = path.join(dir, 'no-herdr-projects')
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('keeps its token in a private file of its home; another token is refused', async () => {
    expect((await fs.stat(path.join(dir, ALFRED_TOKEN_FILE))).mode & 0o777).toBe(0o600)
    await expect(runAlfredCommand(deps(), 'f'.repeat(64), { argv: ['projects'] })).rejects.toThrow('Unknown Alfred token')
    await issueAlfredToken(store, dir) // a new start: the old token stops working
    await expect(run('projects')).rejects.toThrow('Unknown Alfred token')
  })

  // Alfred's AGENTS.md points to `wherdr alfred help` instead of listing the commands.
  it('answers help with every command, the notes commands and the notes rule', async () => {
    const { commands } = await run('help') as { commands: string[] }
    expect(commands).toEqual(alfredCommandList())
    for (const c of ALFRED_COMMANDS) expect(commands.some(l => l.startsWith(`- \`wherdr alfred ${c.usage}`)), c.usage).toBe(true)
    for (const c of NOTES_COMMANDS) expect(commands, c.usage).toContain(`- \`wherdr alfred ${c.usage}\`: ${c.does}`)
    expect(commands.at(-1)).toBe(`- ${NOTES_RULE}`)
    // The recipes its AGENTS.md used to spell out are in the commands' own text.
    const [machine, workflow] = ['project machine add', 'project workflow edit'].map(u => ALFRED_COMMANDS.find(c => c.usage.startsWith(u))!.does)
    expect(machine).toMatch(/ask the user for the path of the repository's clone[^.]*`ready`/)
    expect(workflow).toMatch(/wherdr pm template show --project[^.]*minimal default/)
  })

  // WHR-512: a wake (or a prompt injection read meanwhile) never applies a change; nor does a card's click.
  it('refuses --apply outside a turn of the user\'s own message', async () => {
    for (const kind of ['wake', 'card'] as const) {
      await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind, at: Date.now() } })
      await expect(run('project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--apply')).rejects.toThrow('--apply is only for a turn that comes from the user')
    }
    expect(await store.projects()).toEqual([])
  })

  it('shows a change, then makes it with --apply only', async () => {
    // On another machine: nothing reached before the user's yes.
    const shown = await run('project', 'add', 'WEB', '--machine', 'Mac', '--path', '/src/web')
    expect(shown).toMatchObject({ dryRun: true, change: ['add project WEB "WEB"', 'folder /src/web on Mac (checked when applied: inside the home folder, a git repository, not already a project)', 'template none'], remote: expect.stringContaining('Mac') })
    expect(checked).toEqual([])
    expect(await store.projects()).toEqual([])
    expect(await run('project', 'add', 'WEB', '--machine', 'mac', '--path', '/src/web', '--apply')).toMatchObject({ applied: true, result: { key: 'WEB', machine: 'mac' } })
    expect(checked).toEqual(['mac:/src/web'])
    expect(await run('project', 'template', 'WEB', 'example:common')).toMatchObject({ dryRun: true, change: ['project WEB template: none → example:common'] })
    await run('project', 'template', 'WEB', 'example:common', '--apply')
    expect(await run('projects')).toMatchObject({ enabled: true, projects: [{ key: 'WEB', from: { template: 'common' }, machineName: 'Mac' }] })
    await expect(run('project', 'template', 'WEB', 'example:nope')).rejects.toThrow('No example example:nope')
    expect(await run('project', 'template', 'WEB', 'example:vibe', '--apply')).toMatchObject({ applied: true, change: ['project WEB template: common → example:vibe'] })
  })

  it('adds a workspace: its root on each machine and its tab group, then starts its coordinator', async () => {
    expect(parseAlfredCommand(['workspace', 'add', 'ws', '--machine', ',mac', '--root', '~/work'])).toEqual({ error: '--machine and --root pair up: one root folder per machine, in the same order' })
    await patchSettings({ machineGroups: JSON.stringify([{ id: '*group:o', name: 'Office', machines: ['mac'] }]) }, { file: path.join(dir, 'settings.json') })
    await expect(run('workspace', 'add', 'WS', '--root', '~/work', '--group', 'Lab')).rejects.toThrow('No tab group Lab: Office')
    const argv = ['workspace', 'add', 'WS', '--name', 'Work', '--machine', ',Mac', '--root', '~/work,/srv/work', '--group', 'Office']
    expect(await run(...argv)).toMatchObject({ dryRun: true, remote: expect.stringContaining('Mac'), change: ['add workspace WS "Work" in tab group Office', 'root folder ~/work on this machine (its home: checked when applied, it must exist)', 'clone root /srv/work on Mac', expect.stringContaining('offers to build the map')] })
    expect(await store.projects()).toEqual([])
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind: 'user', at: Date.now() } })
    await run(...argv, '--propose')
    const card = (await store.coordinator(MAIN))!.cards!.at(-1)!
    expect(card).toMatchObject({ label: 'New workspace WS', change: { argv } })
    const done = await actOnCard({ store, applyChange: (a: string[], lines: string[]) => applyProposedChange(deps(), a, lines) } as never, card.id, undefined)
    expect(done).toMatchObject({ state: 'done', outcome: { lines: ['WS: added, coordinator started (it offers to build the map)'] } })
    expect(await store.project('WS')).toMatchObject({ kind: 'workspace', git: false, name: 'Work', path: '/home/user/work', group: '*group:o', shared: { machines: ['mac'], clones: { mac: '/srv/work' } } })
    expect(started.splice(0)).toEqual(['WS'])
  })

  it('lists the v2 projects read now from the herdr-projects board, with the v3 project made from each', async () => {
    expect(await run('v2')).toEqual({ fromV2: false })
    herdrProjects = path.resolve(__dirname, 'fixtures/v2-install/herdr-projects')
    await run('project', 'add', 'APP', '--machine', '', '--path', '/home/user/code/app', '--apply')
    const r = await run('v2') as { projects: { key: string, project: string | null, tasks: unknown[] }[] }
    expect(r).toMatchObject({ fromV2: true, report: path.join(dir, 'migration-report.md') })
    // APP keeps its own key; the others get free ones.
    expect(r.projects.map(p => [p.key, p.project, p.tasks.length])).toEqual([['APP', 'APP', 2], ['GONE', null, 0], ['MYDOCS', null, 0], ['SITE', null, 1]])
  })

  it('brings every v2 project over in one card: the checked ones added, their coordinators started, no workflow needed', async () => {
    herdrProjects = path.resolve(__dirname, 'fixtures/v2-install/herdr-projects')
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind: 'user', at: Date.now() } })
    expect(parseAlfredCommand(['v2', 'import', '--only', 'app,site', '--start', 'no'])).toEqual({ name: 'v2 import', apply: false, only: ['APP', 'SITE'], start: false })
    await run('v2', 'import', '--propose')
    const card = (await store.coordinator(MAIN))!.cards![0]!
    // One line per project; GONE's folder is missing: no checkbox.
    expect(card).toMatchObject({ label: 'Projects from wherdr v2', change: { argv: ['v2', 'import'], picks: ['APP', null, 'MYDOCS', 'SITE'], start: true } })
    expect(card.change!.lines[1]).toBe('GONE "gone" on this machine, folder /home/user/code/gone: cannot be added: This folder does not exist')
    // MYDOCS unchecked: skipped. APP's coordinator fails to start: SITE still goes on.
    const choice = { picks: ['APP', 'SITE'], start: true }
    const done = await actOnCard({ store, applyChange: (argv: string[], lines: string[], c?: typeof choice) => applyProposedChange(deps(), argv, lines, c) } as never, card.id, undefined, false, choice)
    expect(done).toMatchObject({ state: 'done', outcome: { lines: ['APP: added; coordinator not started: agent missing', 'SITE: added, coordinator started (its first message is typed once it is ready)'] } })
    expect((await store.projects()).map(p => [p.key, p.from])).toEqual([['APP', undefined], ['SITE', undefined]])
    expect(started).toEqual(['SITE'])
    // --only and --start no are the card's defaults; an Apply without a choice keeps them.
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind: 'user', at: Date.now() } })
    await run('v2', 'import', '--only', 'mydocs', '--start', 'no', '--propose')
    const narrow = (await store.coordinator(MAIN))!.cards![0]!
    expect(narrow.change).toMatchObject({ argv: ['v2', 'import'], picks: [null, 'MYDOCS'], on: ['MYDOCS'], start: false })
    expect(await actOnCard({ store, applyChange: (argv: string[], lines: string[], c?: typeof choice) => applyProposedChange(deps(), argv, lines, c) } as never, narrow.id, undefined)).toMatchObject({ outcome: { lines: ['MYDOCS: added'] } })
    expect(started).toHaveLength(1)
    // A project without a template: its coordinator starts all the same.
    expect(await run('coordinator', 'start', 'APP')).toMatchObject({ dryRun: true, change: ['start the coordinator of APP with claude on this machine'] })
  })

  // WHR-349: with Projects off, the user's message from the composer is Alfred's user turn, and the
  // import card turns Projects on with its own checkbox.
  it('with Projects off: a message from the composer is a user turn; the import card\'s checkbox turns Projects on', async () => {
    herdrProjects = path.resolve(__dirname, 'fixtures/v2-install/herdr-projects')
    await store.setEnabled(false)
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, terminal: 'host/t1' })
    await userMessageTo(store, 'host/t1', 'Yes please, set up my v2 projects.')
    expect((await store.coordinator(MAIN))!.turn).toMatchObject({ kind: 'user', said: 'Yes please, set up my v2 projects.' })
    await run('v2', 'import', '--propose')
    const card = (await store.coordinator(MAIN))!.cards![0]!
    expect(card.change).toMatchObject({ pm: true })
    const apply = (choice: object) => actOnCard({ store, applyChange: (argv: string[], lines: string[], c?: never) => applyProposedChange(deps(), argv, lines, c) } as never, card.id, undefined, false, { picks: ['SITE'], start: false, ...choice } as never)
    await expect(apply({ pm: false })).rejects.toThrow('Turn on project management')
    expect(await store.enabled()).toBe(false)
    expect(await apply({ pm: true })).toMatchObject({ state: 'done', outcome: { lines: ['SITE: added'] } })
    expect(await store.enabled()).toBe(true)
  })

  it('adds a note to the coordinator\'s memory.md after a yes only', async () => {
    expect(parseAlfredCommand(['project', 'memory', 'WEB', '--propose'])).toEqual({ error: expect.stringContaining('no card') })
    const execs: { argv: string[], input?: string }[] = []
    const call = async (m: string, p: { argv: string[], input?: string }) => {
      if (m !== 'machine.exec') return {}
      execs.push(p)
      return { code: 0, stdout: Buffer.from(p.argv[2] === 'printf %s "$HOME"' ? '/home/user' : '').toString('base64') }
    }
    const withCall = () => ({ ...deps(), call }) as unknown as Parameters<typeof runAlfredCommand>[0]
    const memory = (input: string, ...more: string[]) => runAlfredCommand(withCall(), token, { argv: ['project', 'memory', 'WEB', ...more], input })
    await run('project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--apply')
    const note = '- Goal from v2\'s autopilot: Ship it\n\n- Squash merges only\n'
    // Shown first: nothing written (a no ends here).
    expect(await memory(note)).toMatchObject({ dryRun: true, change: ['add to the end of the memory.md of WEB\'s coordinator, on this machine:', '- Goal from v2\'s autopilot: Ship it', '- Squash merges only'] })
    expect(execs.filter(e => e.input)).toEqual([])
    await expect(memory('\n \n')).rejects.toThrow('No lines to add')
    // After the yes: appended to the coordinator's own memory.md.
    expect(await memory(note, '--apply')).toMatchObject({ applied: true, result: { file: '/home/user/.wherdr/pm/coordinators/WEB/memory.md', added: 2 } })
    const write = execs.find(e => e.input)!
    expect(write.argv.slice(4)).toEqual(['/home/user/.wherdr/pm/coordinators/WEB/memory.md', expect.stringMatching(/^# Memory/)])
    expect(Buffer.from(write.input!, 'base64').toString()).toBe('- Goal from v2\'s autopilot: Ship it\n- Squash merges only\n')
     // A member has no coordinator of its own: its workspace's gets the note.
    const ok = async (_m: string, p: string) => p.replace(/^~/, '/home/user')
    await store.addProject({ key: 'ws', name: 'Work', machine: '', path: '~/work', kind: 'workspace' }, ok)
    await store.addProject({ key: 'api', machine: '', path: '~/work/api', workspace: 'ws' }, ok)
    expect((await runAlfredCommand(withCall(), token, { argv: ['project', 'memory', 'API'], input: note })).change[0]).toBe('add to the end of the memory.md of WS\'s coordinator, on this machine:')
  })

  it('Alfred\'s wherdr script sends stdin with project memory (shown or applied) and theme propose', async () => {
    const http = await import('node:http')
    const { execFile } = await import('node:child_process')
    const { WHERDR_SCRIPT } = await import('../shared/pm/coordinator')
    const bodies: { argv64: string[], input64?: string }[] = []
    const server = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { bodies.push(JSON.parse(raw)); res.end('{}') }) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    await fs.mkdir(path.join(dir, 'bin'))
    await fs.writeFile(path.join(dir, 'bin/wherdr'), WHERDR_SCRIPT, { mode: 0o755 })
    const env = { PATH: process.env.PATH, WHERDR_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
    const send = (...args: string[]) => new Promise<void>((resolve) => { execFile(path.join(dir, 'bin/wherdr'), ['alfred', ...args], { env }, () => resolve()).stdin!.end('- Squash merges only\n') })
    try {
      await send('project', 'memory', 'APP')
      await send('project', 'memory', 'APP', '--apply')
      await send('theme', 'propose')
    }
    finally { server.close() }
    expect(bodies.map(b => Buffer.from(b.input64 ?? '', 'base64').toString())).toEqual(['- Squash merges only\n', '- Squash merges only\n', '- Squash merges only\n'])
  })

  it('shows the project\'s guards and changes them after its dry run', async () => {
    expect(parseAlfredCommand(['project', 'guards', 'WEB', '--merge-others', 'me'])).toEqual({ error: '--merge-protected and --merge-others are user or engine' })
    await run('project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--template', 'example:common', '--apply')
    expect(await run('project', 'guards', 'WEB')).toEqual({ project: 'WEB', guards: common.guards ?? {} })
    const argv = ['project', 'guards', 'WEB', '--protect', 'main,v3', '--merge-others', 'user']
    expect(await run(...argv)).toMatchObject({ dryRun: true, next: expect.stringContaining('--propose') })
    // WHR-512: guards change by the user's click only, never --apply, even in a user turn.
    await expect(run(...argv, '--merge-protected', 'engine', '--apply')).rejects.toThrow('project guards is never changed by Alfred')
    await run(...argv, '--propose')
    const card = (await store.coordinator(MAIN))!.cards!.at(-1)!
    await actOnCard({ store, applyChange: (a: string[], lines: string[]) => applyProposedChange(deps(), a, lines) } as never, card.id, undefined)
    expect((await store.workflow('WEB'))!.guards).toMatchObject({ protected: ['main', 'v3'], merge: { others: 'user' } })
  })

  it('allows another machine with its clone after a dry run, runs its check, and removes it', async () => {
    await run('project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--apply')
    await expect(run('project', 'machine', 'add', 'WEB', 'this', '--clone', '/src/web')).rejects.toThrow('this machine is the project\'s own machine')
    await expect(run('project', 'machine', 'add', 'WEB', 'Mac', '--clone', 'relative')).rejects.toThrow('clones.mac')
    expect(await run('project', 'machine', 'add', 'WEB', 'Mac', '--clone', '~/project')).toMatchObject({
      dryRun: true, change: ['project WEB: its tasks may run on Mac, in its clone ~/project', 'then the readiness check of Mac runs (read-only)'], remote: expect.stringContaining('Mac'),
    })
    expect((await store.project('WEB'))!.machines).toBeUndefined()
    expect(await run('project', 'machine', 'add', 'WEB', 'Mac', '--clone', '~/project', '--apply')).toMatchObject({
      applied: true, result: { project: { machines: ['', 'mac'], clones: { mac: '~/project' } }, ready: { refused: 'gh login: not logged in' } },
    })
    expect(await run('project', 'machine', 'remove', 'WEB', 'Mac')).toMatchObject({ dryRun: true, change: ['project WEB: its tasks no longer start on Mac (tasks already there stay)'] })
    await run('project', 'machine', 'remove', 'WEB', 'Mac', '--apply')
    expect(await store.project('WEB')).not.toHaveProperty('machines')
    expect(await run('project', 'machine', 'remove', 'WEB', 'Mac')).toMatchObject({ unchanged: true })
  })

  it('makes the folder checks of --apply in the dry run on this machine', async () => {
    expect(await run('project', 'add', 'APP', '--machine', '', '--path', '~/app')).toMatchObject({ dryRun: true, change: ['add project APP "APP"', 'folder /home/user/app on this machine (checked: a git repository)', 'template none'] })
    expect(checked).toEqual([':~/app'])
    await run('project', 'add', 'APP', '--machine', '', '--path', '~/app', '--apply')
    await expect(run('project', 'add', 'APP2', '--machine', '', '--path', '/home/user/app')).rejects.toThrow('This folder is already a project: APP')
    failCheck = true
    await expect(run('project', 'add', 'OUT', '--machine', '', '--path', '/opt/x')).rejects.toThrow('path: a folder inside the home folder')
  })

  it('proposes a setting as a card the user applies or cancels, only in the user\'s turn', async () => {
    const turn = async (kind: 'user' | 'wake') => store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind, at: Date.now(), said: 'type the replies slower' } })
    expect(await run('setting', 'set', 'typewriterSpeed', 'slow')).toMatchObject({ dryRun: true, change: ['setting typewriterSpeed: (default) → "slow"'] })
    await turn('wake')
    await expect(run('setting', 'set', 'typewriterSpeed', 'slow', '--propose')).rejects.toThrow('never in a wake')
    await turn('user')
    const out = await run('setting', 'set', 'typewriterSpeed', 'slow', '--propose') as { note: string }
    const card = (await store.coordinator(MAIN))!.cards![0]!
    expect(out.note).toContain(`action ${card.id}`)
    expect(card).toMatchObject({ kind: 'setting', label: 'Conversation › Typewriter', setting: { key: 'typewriterSpeed', after: 'slow', said: 'type the replies slower', target: 'conversation.typewriter' } })
    expect(await run('settings')).toMatchObject({ settings: {} }) // nothing changed yet
    const act = (id: string, cancel = false) => actOnCard({ store, settingsFile: path.join(dir, 'settings.json') } as never, id, undefined, cancel)
    await expect(actOnCard({ store } as never, card.id, 'Bearer abc')).rejects.toThrow(/never a token/)
    expect(await act(card.id)).toMatchObject({ state: 'done', outcome: { text: 'Applied by you' } })
    expect(await run('settings')).toMatchObject({ settings: { typewriterSpeed: 'slow' } })
    // A second proposal over the old value goes stale once the setting moved; a cancelled one runs nothing.
    await run('setting', 'set', 'theme', 'vesper', '--propose')
    const theme = (await store.coordinator(MAIN))!.cards![0]!.id
    expect(await act(theme, true)).toMatchObject({ state: 'dismissed' })
    expect(await act(theme)).toMatchObject({ state: 'dismissed' })
    await run('setting', 'set', 'typewriterSpeed', 'off', '--propose')
    const back = (await store.coordinator(MAIN))!.cards![0]!.id
    await patchSettings({ typewriterSpeed: 'fast' }, { file: path.join(dir, 'settings.json') })
    expect(await act(back)).toMatchObject({ state: 'stale' })
    expect(await run('settings')).toMatchObject({ settings: { typewriterSpeed: 'fast' } })
  })

  // WHR-427: a custom theme, checked as an import is; only the user's Apply saves and picks it.
  it('proposes a custom theme as a card: a bad file is refused with why, Apply saves and picks it, the limit refuses', async () => {
    const file = { ...themeFile(THEMES[0]!), name: 'Navy Ember' }
    const propose = (input: unknown) => runAlfredCommand(deps(), token, { argv: ['theme', 'propose'], input })
    const settingsFile = path.join(dir, 'settings.json')
    expect(parseAlfredCommand(['theme', 'propose', 'x'])).toEqual({ error: expect.stringContaining('theme propose < theme.json') })
    await expect(propose('{')).rejects.toThrow('Not valid JSON: fix the theme file and run it again')
    await expect(propose(JSON.stringify({ ...file, light: { ...file.light, bg: 'navy' } }))).rejects.toThrow('"light.bg" is not a #rrggbb color')
    await expect(propose(JSON.stringify({ ...file, dark: { ...file.dark, ansi: [] } }))).rejects.toThrow('"dark.ansi" must be 16 #rrggbb colors')
    await expect(propose(JSON.stringify({ ...file, name: 'x'.repeat(9000) }))).rejects.toThrow('larger than 8 KB')
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind: 'wake', at: Date.now() } })
    await expect(propose(JSON.stringify({ ...file, name: 'Navy Ember' }))).rejects.toThrow('never in a wake')
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind: 'user', at: Date.now(), said: 'a navy theme' } })
    const out = await propose(JSON.stringify({ ...file, dark: { ...file.dark, muted: file.dark.bg } })) as { note: string, belowWcagAA: { dark: string[], light: string[] } }
    expect(out.belowWcagAA).toEqual({ dark: expect.arrayContaining([expect.stringMatching(/^muted on bg 1.00/)]), light: [] })
    const card = (await store.coordinator(MAIN))!.cards![0]!
    expect(out.note).toContain(`action ${card.id}`)
    expect(card).toMatchObject({ kind: 'theme', label: 'Navy Ember', theme: { file: { name: 'Navy Ember' }, said: 'a navy theme' } })
    expect(await readSettings(settingsFile)).toEqual({}) // nothing saved yet
    const act = (id: string) => actOnCard({ store, settingsFile } as never, id, undefined)
    expect(await act(card.id)).toMatchObject({ state: 'done', outcome: { text: 'Applied by you' } })
    const s = await readSettings(settingsFile), saved = readCustomThemes(s.customThemes ?? null)
    expect(saved).toMatchObject([{ label: 'Navy Ember', group: 'custom' }])
    expect(s.theme).toBe(saved[0]!.id)
    // At the limit: refused, the card stays open for a later Apply.
    await patchSettings({ customThemes: writeCustomThemes(Array.from({ length: CUSTOM_THEMES_MAX }, (_, i) => ({ ...saved[0]!, id: `custom-${i}` }))) }, { file: settingsFile })
    await propose(JSON.stringify({ ...file, name: 'Second' }))
    const next = (await store.coordinator(MAIN))!.cards![0]!.id
    await expect(act(next)).rejects.toThrow(`At most ${CUSTOM_THEMES_MAX} custom themes`)
    expect((await store.coordinator(MAIN))!.cards![0]).toMatchObject({ id: next, state: 'open' })
  })

  it('proposes a project change as a card: the user\'s Apply makes it while its dry run still holds', async () => {
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind: 'user', at: Date.now(), said: 'set up web' } })
    await run('project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--propose')
    const add = (await store.coordinator(MAIN))!.cards![0]!
    expect(add).toMatchObject({ kind: 'change', label: 'New project WEB', change: { argv: ['project', 'add', 'WEB', '--machine', '', '--path', '/src/web'], project: 'WEB', said: 'set up web' } })
    expect(add.change).not.toHaveProperty('target')
    expect(await store.projects()).toEqual([])
    const act = (id: string) => actOnCard({ store, applyChange: (argv: string[], lines: string[]) => applyProposedChange(deps(), argv, lines) } as never, id, undefined)
    expect(await act(add.id)).toMatchObject({ state: 'done', outcome: { text: 'Applied by you' } })
    expect(await store.projects()).toMatchObject([{ key: 'WEB' }])
    // Proposed over no template; the template changed before the click: nothing runs.
    await run('project', 'template', 'WEB', 'example:common', '--propose')
    const tpl = (await store.coordinator(MAIN))!.cards![0]!
    expect(tpl).toMatchObject({ label: 'Project WEB › Workflow', change: { lines: ['project WEB template: none → example:common'], target: 'project.workflow' } })
    await run('project', 'template', 'WEB', 'example:vibe', '--apply')
    expect(await act(tpl.id)).toMatchObject({ state: 'stale' })
    expect((await store.project('WEB'))!.from).toMatchObject({ template: 'vibe' })
  })

  it('starts a project coordinator with the user\'s first offered agent that can run it, no model', async () => {
    await run('project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--apply')
    expect(await run('coordinator', 'start', 'WEB')).toMatchObject({ dryRun: true, change: ['start the coordinator of WEB with claude on this machine'] })
    // Settings › Agents: omp first (it may run a project coordinator, but never by default), Claude unchecked.
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ v: 1, settings: { agentOrder: '["omp","claude","codex"]', hiddenAgents: '["claude"]' } }))
    expect(await run('coordinator', 'start', 'WEB')).toMatchObject({ change: ['start the coordinator of WEB with codex on this machine'] })
    expect(await run('coordinators')).toMatchObject({ coordinators: [{ project: '_main' }, { project: 'WEB', agent: 'codex' }] })
    expect(await run('coordinator', 'start', 'WEB', '--program', 'claude')).toMatchObject({ change: ['start the coordinator of WEB with claude on this machine'] })
    expect(await run('coordinator', 'start', 'WEB', '--program', 'omp')).toMatchObject({ change: ['start the coordinator of WEB with omp on this machine'] })
    await expect(run('coordinator', 'start', 'WEB', '--program', 'codex', '--model', 'gpt-6')).rejects.toThrow()
    // An explicit omp default is kept while omp is offered.
    await setCoordinatorAgent(store, 'WEB', { program: 'omp' })
    expect(await run('coordinators')).toMatchObject({ coordinators: [{ project: '_main' }, { project: 'WEB', agent: 'omp' }] })
    // Hidden, omp is no longer offered: the default moves back to a Claude or Codex.
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ v: 1, settings: { agentOrder: '["omp","claude","codex"]', hiddenAgents: '["omp"]' } }))
    expect(await run('coordinators')).toMatchObject({ coordinators: [{ project: '_main' }, { project: 'WEB', agent: 'claude' }] })
    // omp is the default only when neither Claude nor Codex is offered.
    await store.saveCoordinator({ ...(await store.coordinator('WEB'))!, agent: undefined })
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ v: 1, settings: { agentOrder: '["omp","claude","codex"]', hiddenAgents: '["claude","codex"]' } }))
    expect(await run('coordinator', 'start', 'WEB')).toMatchObject({ change: ['start the coordinator of WEB with omp on this machine'] })
  })

  // WHR-387: the tab open at the user's message, the tabs with their projects, a brief per tab or all.
  it('knows the open tab, lists the groups and briefs one group or all', async () => {
    const groups = [{ id: '*group:perso', name: 'Perso', machines: [''] }, { id: '*group:work', name: 'Work', machines: ['mac'] }]
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ v: 1, settings: { machineGroups: JSON.stringify(groups), machineBarHidden: JSON.stringify(['', 'mac']) } }))
    await run('project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--apply')
    await run('project', 'add', 'API', '--machine', 'mac', '--path', '/src/api', '--apply')
    await store.saveTask({ id: 'WEB-1', project: 'WEB', title: 'Login page', description: '', type: 'feature', state: 'working', step: { at: 1, yourTurn: { reason: 'action', badge: 'Merge' } } as never })
    await store.saveCoordinator({ ...(await store.coordinator(MAIN))!, terminal: 'host/t1' })
    await userMessageTo(store, 'host/t1', 'How is it going?', '*group:work')
    expect(await run('groups')).toEqual({ open: 'Work', groups: [{ name: 'Perso', kind: 'group', projects: ['WEB'] }, { name: 'Work', kind: 'group', projects: ['API'] }] })
    expect(await run('brief')).toMatchObject({ scope: 'Work', open: 'Work', projects: [{ project: 'API', merged: [], waiting: [], coordinator: 'not started' }], machines: [], quotas: [{ status: 'quota:claude', near: ['week 92% used'] }], others: ['all', 'Perso'] })
    // A machine's status line names it by key; a label with a space never makes one (it would not parse).
    const [local, mac] = machines as { label: string, status: string }[]
    local!.label = 'Mac Studio'
    mac!.status = 'offline'
    try {
      expect((await run('brief', '--group', 'work') as { machines: unknown[] }).machines).toEqual([{ name: 'Mac', state: 'offline', status: 'machine:mac' }])
      expect((await run('brief', '--group', 'perso') as { machines: unknown[] }).machines).toEqual([{ name: 'Mac Studio', state: 'full' }])
    } finally { local!.label = 'this'; mac!.status = 'online' }
    expect(await run('brief', '--group', 'perso')).toMatchObject({ scope: 'Perso', projects: [{ project: 'WEB', waiting: [{ id: 'WEB-1', what: 'Merge' }] }], machines: [{ name: 'this', state: 'full', status: 'machine:this' }] })
    expect((await run('brief', '--all') as { projects: unknown[] }).projects).toHaveLength(2)
    expect((await store.coordinator(MAIN))!.briefs).toEqual({ '*group:work': expect.any(Number), '*group:perso': expect.any(Number), 'all': expect.any(Number) })
    await expect(run('brief', '--group', 'Home')).rejects.toThrow('Unknown scope Home')
  })
})

describe('Alfred and a project\'s workflow and coordinator', () => {
  let dir = '', store: ReturnType<typeof createPmStore>, token = ''
  const sent: unknown[] = []
  let panes: { id: string, coreAddress: string, status: string }[] = []
  const deps = () => ({
    store, machines: () => [{ key: '', label: 'this', local: true, status: 'online' }], panes: () => panes, urls: { local: 'http://127.0.0.1:7690' },
    settingsFile: path.join(dir, 'settings.json'), check: async (_m: string, f: string) => f, chat: async () => [{ role: 'assistant', text: 'Proposed: see the review', ts: null }],
    call: async (m: string, p: unknown) => { sent.push([m, p]); return {} },
  }) as unknown as Parameters<typeof runAlfredCommand>[0]
  const run = (argv: string[], input?: string) => runAlfredCommand(deps(), token, { argv, input })
  const turn = async (kind: 'user' | 'wake', said?: string) => store.saveCoordinator({ ...(await store.coordinator(MAIN))!, turn: { kind, at: Date.now(), ...(said ? { said } : {}) } })

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alfred-wf-'))
    store = createPmStore(path.join(dir, 'pm'))
    await store.setEnabled(true)
    await issueAlfredToken(store, dir)
    token = (await fs.readFile(path.join(dir, ALFRED_TOKEN_FILE), 'utf8')).trim()
    await turn('user')
    await run(['project', 'add', 'WEB', '--machine', '', '--path', '/src/web', '--apply'])
    sent.length = 0
    panes = []
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('proposes a workflow change only in the user\'s turn; the user accepts it in the same review', async () => {
    await turn('wake')
    await expect(run(['project', 'workflow', 'edit', 'WEB'], '{}')).rejects.toThrow('only for a turn that comes from the user')
    // WHR-473: another project's workflow, copied onto one with only the minimal default (guards included).
    await turn('user', 'copy the company workflow')
    expect(await run(['project', 'workflow', 'edit', 'WEB'], JSON.stringify(company))).toMatchObject({ proposed: true })
    expect(await answerProposal(deps(), 'WEB', true)).toEqual({ accepted: true })
    expect((await store.workflow('WEB'))!).toMatchObject({ taskTypes: company.taskTypes, guards: company.guards })
    await turn('user', 'add a docs step')
    await run(['project', 'template', 'WEB', 'example:company', '--apply'])
    const wf = (await store.workflow('WEB'))!
    await expect(run(['project', 'workflow', 'edit', 'NOPE'], JSON.stringify(wf))).rejects.toThrow('Unknown project NOPE')
    await expect(run(['project', 'workflow', 'edit', 'WEB'], 'not json')).rejects.toThrow('not valid JSON')
    await expect(run(['project', 'workflow', 'edit', 'WEB'], JSON.stringify({ ...wf, taskTypes: 3 }))).rejects.toThrow('taskTypes')
    await expect(run(['project', 'workflow', 'edit', 'WEB'], JSON.stringify({ ...wf, guards: { protected: ['x'] } }))).rejects.toThrow('use wherdr alfred project guards WEB')
    await turn('wake')
    await expect(run(['project', 'workflow', 'edit', 'WEB'], JSON.stringify({ ...wf, instructions: 'Docs too.' }))).rejects.toThrow('never a wake')
    await turn('user', 'add a docs step')
    expect(await run(['project', 'workflow', 'edit', 'WEB'], JSON.stringify({ ...wf, instructions: 'Docs too.' }))).toMatchObject({ proposed: true })
    expect(await store.workflow('WEB')).toEqual(wf)
    expect((await store.coordinator('WEB'))!.proposal).toMatchObject({ by: 'main', said: 'add a docs step', saidAt: expect.any(Number), base: wf.version ?? 1 })
    expect(await answerProposal(deps(), 'WEB', true)).toEqual({ accepted: true })
    expect((await store.workflow('WEB'))!.instructions).toBe('Docs too.')
    expect((await store.workflowLog('WEB')).at(-1)).toMatchObject({ by: 'main coordinator', said: 'add a docs step' })
  })

  it('tells a running coordinator, logged as from Alfred, and reads its last reply', async () => {
    await expect(run(['tell', 'NOPE', 'hi'])).rejects.toThrow('Unknown project NOPE')
    await expect(run(['last', 'WEB'])).rejects.toThrow('The coordinator of WEB is not running')
    await store.saveCoordinator({ project: 'WEB', tokenHash: '', terminal: 't-web' })
    panes = [{ id: 'p1', coreAddress: 't-web', status: 'idle' }]
    await turn('user', 'ask WEB for a workflow')
    expect(await run(['tell', 'WEB', 'propose a workflow'])).toMatchObject({ told: 'WEB' })
    // The user's message relayed is marked as theirs; Alfred's own prefix is not doubled.
    await run(['tell', 'WEB', 'From Alfred, for the user: propose a workflow'])
    const relayed = { terminal: 't-web', text: 'From Alfred, for the user: propose a workflow' }
    expect(sent).toEqual([['terminal.send', relayed], ['terminal.send', relayed]])
    // WHR-512: a relay turn (the user's words kept for the log), never the user's own turn.
    expect((await store.coordinator('WEB'))!.turn).toMatchObject({ kind: 'relay', said: 'ask WEB for a workflow' })
    expect((await store.projectLog('WEB')).at(-1)).toMatchObject({ by: 'Alfred', text: 'told the coordinator: propose a workflow' })
    // In Alfred's wake, the coordinator's turn is a wake too.
    await turn('wake')
    await run(['tell', 'WEB', 'anything blocked?'])
    expect((await store.coordinator('WEB'))!.turn).toMatchObject({ kind: 'wake' })
    expect(sent.at(-1)).toEqual(['terminal.send', { terminal: 't-web', text: 'From Alfred: anything blocked?' }])
    expect(await run(['last', 'WEB'])).toEqual({ project: 'WEB', working: false, from: 'conversation', text: 'Proposed: see the review', at: null })
  })

  it('routes a request to the right coordinator and reports the task it added', async () => {
    await run(['project', 'add', 'TV', '--machine', '', '--path', '/src/tv', '--name', 'Living room TV', '--apply'])
    await store.saveCoordinator({ project: 'TV', tokenHash: '', terminal: 't-tv' })
    panes = [{ id: 'p2', coreAddress: 't-tv', status: 'idle' }]
    await store.addTask({ project: 'TV', title: 'Older task', type: 'simple' })
    await new Promise(r => setTimeout(r, 5))
    await turn('user', 'on the TV, the progress bar does not show')
    await run(['tell', 'TV', 'The progress bar under an episode does not show'])
    expect(sent).toEqual([['terminal.send', { terminal: 't-tv', text: 'From Alfred, for the user: The progress bar under an episode does not show' }]])
    // The coordinator adds the task, as if the user had written to it.
    const added = await store.addTask({ project: 'TV', title: 'Show the progress bar under an episode', type: 'simple' })
    await store.addTask({ project: 'WEB', title: 'Another project', type: 'simple' })
    expect(await run(['last', 'TV'])).toMatchObject({ project: 'TV', tasks: [{ id: added.id, title: 'Show the progress bar under an episode' }] })
  })
})

describe('POST /api/alfred/cli', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../server/utils/alfredCli') })
  const call = async (peer: string, headers: Record<string, string>) => {
    const run = vi.fn(async () => ({ ok: true }))
    vi.doMock('../server/utils/alfredCli', () => ({ runAlfredCommand: run }))
    vi.stubGlobal('defineApi', (h: unknown) => h)
    vi.stubGlobal('getRequestHeader', (e: { node: { req: { headers: Record<string, string> } } }, k: string) => e.node.req.headers[k])
    vi.stubGlobal('getRequestURL', () => new URL('http://127.0.0.1:7690/api/alfred/cli'))
    const handler = (await import('../server/api/alfred/cli.post')).default as unknown as (e: unknown, b: unknown) => Promise<unknown>
    const result = await handler({ node: { req: { socket: { remoteAddress: peer }, headers } } }, { argv: ['projects'] }).catch((e: Error) => e)
    return { result, run }
  }

  it('runs a call from this machine with its token', async () => {
    const { result, run } = await call('127.0.0.1', { authorization: `Bearer ${'a'.repeat(64)}` })
    expect(result).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(expect.anything(), 'a'.repeat(64), { argv: ['projects'] })
  })

  it('refuses a call from the tailnet, direct or relayed, whatever its token', async () => {
    for (const [peer, headers] of [['100.101.102.103', {}], ['127.0.0.1', { 'x-forwarded-for': '100.101.102.103' }]] as const) {
      const { result, run } = await call(peer, { ...headers, authorization: `Bearer ${'a'.repeat(64)}` })
      expect(result).toMatchObject({ message: 'wherdr alfred works on wherdr\'s own machine only' })
      expect(run).not.toHaveBeenCalled()
    }
  })
})

describe('cliTokenCall (guard)', () => {
  const bearer = `Bearer ${'a'.repeat(64)}`
  it('lets a token stand for the passkey on Alfred\'s route from this machine only', () => {
    expect(cliTokenCall('/api/alfred/cli', { ok: true, zone: 'local' }, bearer)).toBe(true)
    expect(cliTokenCall('/api/alfred/cli', { ok: true, zone: 'tailnet' }, bearer)).toBe(false)
    expect(cliTokenCall('/api/alfred/cli', { ok: true, zone: 'local' }, 'Bearer x')).toBe(false)
    expect(cliTokenCall('/api/pm/cli', { ok: true, zone: 'tailnet' }, bearer)).toBe(true)
    expect(cliTokenCall('/api/settings', { ok: true, zone: 'local' }, bearer)).toBe(false)
  })
})
