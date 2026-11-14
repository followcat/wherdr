// WHR-403: Alfred's home files, the name read from its identity.md, and its start message.
import { describe, expect, it } from 'vitest'
import { ALFRED, FIRST_MESSAGE, OWN_FILES, alfredFiles, alfredName, startPrompt, type AlfredContext } from '../shared/pm/alfred'

const ctx: AlfredContext = { home: '/data/alfred', version: '3.0.0', docs: '/opt/wherdr/docs', docFiles: ['overview.md', 'quick-start.md'], pm: false, projects: [], address: { local: 'http://127.0.0.1:7684' } }

describe('alfredName', () => {
  it('reads the Name: line of identity.md, Alfred by default', () => {
    expect(alfredName(OWN_FILES['identity.md'])).toBe(ALFRED)
    expect(alfredName('# Identity\n\nTone: dry\nName:   Jeeves  \n')).toBe('Jeeves')
    expect(alfredName('- **Name:** *Ada*')).toBe('Ada')
    expect(alfredName('name: ' + 'x'.repeat(80))).toHaveLength(40)
    expect(alfredName('Name:\n')).toBe(ALFRED)
    expect(alfredName(null)).toBe(ALFRED)
  })
})

describe('alfredFiles', () => {
  it('ships AGENTS.md (for every agent kind) with its home, own files, the installed docs and the rules', () => {
    const f = alfredFiles(ctx, ['## Coordinating'])
    expect(Object.keys(f)).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'QWEN.md'])
    expect(f['CLAUDE.md']).toBe('@AGENTS.md\n')
    expect(f['GEMINI.md']).toBe('@AGENTS.md\n')
    const a = f['AGENTS.md']!
    expect(a).toContain('wherdr 3.0.0')
    expect(a).toContain('`/data/alfred`')
    expect(a).toContain('identity.md')
    expect(a).toContain('Clean memory.md')
    expect(a).toContain('`/opt/wherdr/docs`')
    expect(a).toContain('overview.md, quick-start.md')
    // The server's own address, and its commands given to copy, not run in Alfred's home.
    expect(a).toContain('This wherdr answers at http://127.0.0.1:7684 on its machine.')
    expect(alfredFiles({ ...ctx, address: { local: 'http://127.0.0.1:7684', remote: 'https://wherdr.example.ts.net' } }, [])['AGENTS.md']).toContain('and at https://wherdr.example.ts.net from the user\'s other devices')
    expect(a).toContain('never in a shell block (its *Run* button would run it here)')
    expect(a).toContain('only after the user\'s yes')
    expect(a).toContain('`wherdr alfred project add <KEY> --machine <key> --path <folder> [--name <name>] [--template <id>] [--apply|--propose]`')
    expect(a).toContain('with `--apply` only after their yes in this chat')
    expect(a).toContain('No `wherdr alfred` command deletes anything')
    expect(a).toContain('The one removal you have is `wherdr pm task remove`')
    expect(a).toContain('Never touch a remote machine')
    expect(a).not.toMatch(/never build|stay light/i)
    expect(a).toContain('You do no coding task yourself and work on no particular project')
    expect(a).toContain('start an agent or a task that does it in the right place')
    expect(a).toContain('honour what memory.md says')
    // Projects off: no coordinator section, a pointer to switch them on.
    expect(a).not.toContain('## Coordinating')
    expect(a).toContain('Settings › Projects')
    expect(alfredFiles({ ...ctx, pm: true }, ['## Coordinating'])['AGENTS.md']).toContain('## Coordinating')
    // The guided setup of v2 projects: only for a user who comes from v2.
    expect(a).not.toContain('## Coming from wherdr v2')
    expect(alfredFiles({ ...ctx, v2: true }, [])['AGENTS.md']).toContain('## Coming from wherdr v2')
    // WHR-243: the first project's setup, only while there is none and not from v2.
    expect(a).toContain('## The first project')
    expect(a).toContain('`wherdr alfred ui open --target projects.setup`')
    expect(alfredFiles({ ...ctx, v2: true }, [])['AGENTS.md']).not.toContain('## The first project')
    expect(alfredFiles({ ...ctx, projects: [{ key: 'WEB', name: 'Web', path: '~/web' }] }, [])['AGENTS.md']).not.toContain('## The first project')
  })
  it('never ships its own files: those are created once', () => {
    expect(Object.keys(alfredFiles(ctx, []))).not.toContain('identity.md')
    expect(Object.keys(OWN_FILES)).toEqual(['identity.md', 'memory.md'])
  })
})

it('greets with the rename question on the first start only', () => {
  expect(startPrompt(true, ALFRED)).toContain(FIRST_MESSAGE)
  expect(startPrompt(false, 'Jeeves')).toMatch(/as Jeeves\.$/)
  expect(startPrompt(false, 'Jeeves')).not.toContain(FIRST_MESSAGE)
  expect(startPrompt(true, ALFRED)).not.toContain('v2')
  expect(startPrompt(true, ALFRED, true)).toMatch(new RegExp(`run \`wherdr alfred v2\` and say exactly: "${FIRST_MESSAGE.replace(/[?]/g, '\\?')}" .*set up those projects`))
  expect(startPrompt(false, 'Jeeves', true)).not.toContain('v2')
})

// WHR-243: a new user with no project is offered the first one's setup.
it('offers to set up the first project when there is none, the v2 offer first', () => {
  const offer = /no project yet.*set up the first one.*setup window/
  expect(startPrompt(true, ALFRED, false, true)).toContain(FIRST_MESSAGE)
  expect(startPrompt(true, ALFRED, false, true)).toMatch(offer)
  expect(startPrompt(true, ALFRED, false, false)).not.toMatch(offer)
  expect(startPrompt(true, ALFRED, true, true)).not.toMatch(offer)
  expect(startPrompt(true, ALFRED, true, true)).toContain('set up those projects')
  expect(startPrompt(false, 'Jeeves', false, true)).not.toMatch(offer)
})

