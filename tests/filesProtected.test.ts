// The file browser never shows wherdr's data folder (auth.json: the lock's
// signing secret), ~/.ssh or ~/.config/herdr: neither as a path written in a
// conversation, nor in a project that contains them, nor through a symlink.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Machine } from '../server/utils/machines'

const home = mkdtempSync(path.join(tmpdir(), 'wherdr-protected-'))
const app = path.join(home, 'wherdr')
const savedHome = process.env.HOME
process.env.DATA_DIR = path.join(app, 'data')
// A WHERDR_DIR elsewhere: its settings are protected as well as ~/wherdr's.
const custom = path.join(home, 'custom')
process.env.WHERDR_DIR = custom
// The scripts resolve ~/.ssh on the machine itself, from $HOME.
process.env.HOME = home
let files: typeof import('../server/utils/files')
const m = { exec: null, home } as unknown as Machine

beforeAll(async () => {
  mkdirSync(path.join(app, 'data'), { recursive: true })
  writeFileSync(path.join(app, 'data/auth.json'), '{"secret":"s"}\n')
  writeFileSync(path.join(app, 'README.md'), '# app\n')
  writeFileSync(path.join(app, 'wherdr.env'), 'OPENROUTER_API_KEY=sk-or-x\n')
  writeFileSync(path.join(app, 'wherdr.json'), '{}\n')
  writeFileSync(path.join(app, 'wherdr.log'), 'log\n')
  mkdirSync(custom)
  writeFileSync(path.join(custom, 'wherdr.env'), 'OPENROUTER_API_KEY=sk-or-y\n')
  symlinkSync(path.join(custom, 'wherdr.env'), path.join(app, 'env-link'))
  mkdirSync(path.join(home, '.ssh'))
  writeFileSync(path.join(home, '.ssh/id_ed25519'), 'key\n')
  mkdirSync(path.join(home, '.config/herdr'), { recursive: true })
  writeFileSync(path.join(home, '.config/herdr/config.toml'), 'x\n')
  mkdirSync(path.join(home, '.config/other'), { recursive: true })
  writeFileSync(path.join(home, '.config/other/ok.txt'), 'ok\n')
  mkdirSync(path.join(home, 'project'))
  symlinkSync(path.join(app, 'data/auth.json'), path.join(home, 'project/auth-link.json'))
  symlinkSync(path.join(home, '.ssh'), path.join(home, 'project/keys'))
  symlinkSync('data/auth.json', path.join(app, 'secret-link'))
  files = await import('../server/utils/files')
})
afterAll(() => {
  process.env.HOME = savedHome
  delete process.env.WHERDR_DIR
  rmSync(home, { recursive: true, force: true })
})

describe('protected folders in the file browser', () => {
  it('refuses auth.json and keys written in a conversation, preview and download', async () => {
    for (const p of ['~/wherdr/data/auth.json', path.join(app, 'data/auth.json'), '~/.ssh/id_ed25519', '~/.config/herdr/config.toml', '~/wherdr/data/../data/auth.json']) {
      await expect(files.readWrittenPreview(m, home, p)).rejects.toMatchObject({ code: 'protected' })
      await expect(files.readWrittenBytes(m, home, p)).rejects.toMatchObject({ code: 'protected' })
    }
    expect(await files.readWrittenPreview(m, home, '~/.config/other/ok.txt')).toMatchObject({ kind: 'text', text: 'ok\n' })
  })

  it('refuses them inside a browsed project, and through a symlink', async () => {
    // The app's own folder browsed as a project: its data folder stays hidden.
    await expect(files.readFilePreview(m, app, 'data/auth.json')).rejects.toMatchObject({ code: 'protected' })
    await expect(files.readFileBytes(m, app, 'data/auth.json')).rejects.toMatchObject({ code: 'protected' })
    expect(await files.readFilePreview(m, app, 'README.md')).toMatchObject({ kind: 'text', text: '# app\n' })
    // A symlink that stays under the root: checked once resolved, on the machine.
    await expect(files.readFilePreview(m, app, 'secret-link')).rejects.toMatchObject({ code: 'protected' })
    await expect(files.readFileBytes(m, app, 'secret-link')).rejects.toMatchObject({ code: 'protected' })
    const project = path.join(home, 'project')
    await expect(files.readWrittenPreview(m, project, 'auth-link.json')).rejects.toMatchObject({ code: 'protected' })
    await expect(files.readWrittenBytes(m, project, 'keys/id_ed25519')).rejects.toMatchObject({ code: 'protected' })
    // One that leaves the project is refused as before.
    await expect(files.readFilePreview(m, project, 'auth-link.json')).rejects.toMatchObject({ code: 'outside' })
  })

  it('refuses wherdr\'s settings (wherdr.env, wherdr.json), in ~/wherdr and in WHERDR_DIR', async () => {
    for (const p of ['~/wherdr/wherdr.env', '~/wherdr/wherdr.json', path.join(custom, 'wherdr.env'), '~/custom/./wherdr.env']) {
      await expect(files.readWrittenPreview(m, home, p), p).rejects.toMatchObject({ code: 'protected' })
      await expect(files.readWrittenBytes(m, home, p), p).rejects.toMatchObject({ code: 'protected' })
    }
    // Browsed as a project: checked on the machine.
    for (const p of ['wherdr.env', 'wherdr.json']) {
      await expect(files.readFilePreview(m, app, p), p).rejects.toMatchObject({ code: 'protected' })
      await expect(files.readFileBytes(m, app, p), p).rejects.toMatchObject({ code: 'protected' })
    }
    // Through a symlink (resolved on the machine).
    await expect(files.readWrittenPreview(m, app, 'env-link')).rejects.toMatchObject({ code: 'protected' })
    await expect(files.readFilePreview(m, custom, 'wherdr.env')).rejects.toMatchObject({ code: 'protected' })
    // The rest of the folder stays readable.
    expect(await files.readFilePreview(m, app, 'wherdr.log')).toMatchObject({ kind: 'text', text: 'log\n' })
  })
})
