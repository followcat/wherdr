// Server messages shown in the app use English keys. French agent data and
// inactive translations remain supported.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { french } from '../app/utils/i18n'
import { fmt } from '../shared/message'
import { agentNotificationTitle } from '../server/utils/push'

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return files(p, ext)
    return ext.test(f) ? [p] : []
  })
}

// Code without its comments (line comments, block comments, shell comments).
const code = (src: string, shell: boolean) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(shell ? /^\s*#.*$/ : /(^|\s)\/\/.*$/, ''))
  .join('\n')

const FRENCH = /[àâçéèêëîïôûùœ]|\b(introuvable|injoignable|invalide|impossible|dossier|inconnue?|déjà)\b/i
// Places that hold French on purpose: the French half of a bilingual pair
// (lang === 'fr', tl-like pairs, titleFr), and text matched in Herdr's output.
const BILINGUAL = /\blang\b|\bfr\b|Fr\b|\bfr:|introuvable\/i/

// Bilingual by design: the coordinator rules and TASKS.md template written in the
// project's language, reply markers and task labels recognized in both languages,
// and the step descriptions (tl pairs passed in by the app).
const BILINGUAL_FILES = new Set(['shared/pm/describe.ts', 'shared/projectBoard.ts', 'shared/replyQuote.ts', 'shared/reference.ts', 'shared/threadLimits.ts'])

const SERVER = [
  ...files('server', /\.ts$/).map(f => ({ f, src: code(readFileSync(f, 'utf8'), false) })),
  ...files('shared', /\.ts$/).map(f => ({ f, src: code(readFileSync(f, 'utf8'), false) })),
  ...files('scripts', /\.sh$/).map(f => ({ f, src: code(readFileSync(f, 'utf8'), true) })),
]

describe('server messages', () => {
  it('contain no raw French outside bilingual pairs', () => {
    const found = SERVER.flatMap(({ f, src }) => src.split('\n').map((l, i) => ({ l, at: `${f}:${i + 1}` })))
      .filter(({ l, at }) => !BILINGUAL_FILES.has(at.split(':')[0]!) && FRENCH.test(l) && /['"`]/.test(l) && !BILINGUAL.test(l))
      .map(({ l, at }) => `${at}: ${l.trim().slice(0, 120)}`)
    expect(found).toEqual([])
  })

  it('have no duplicate key in the French dictionary', () => {
    const src = readFileSync('app/utils/i18n.ts', 'utf8')
    const keys = [...src.matchAll(/^\s*'((?:[^'\\]|\\.)*)':|, '((?:[^'\\]|\\.)*)':/gm)].map(m => m[1] ?? m[2])
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })

  it('are translated back from a filled template, values included', () => {
    const msg = fmt('{machine} is unreachable: {reason}', { machine: 'laptop', reason: 'timed out' })
    expect(msg).toBe('laptop is unreachable: timed out')
    expect(french(msg)).toBe('laptop injoignable : délai dépassé')
    expect(french(fmt('{machine} is unreachable', { machine: 'laptop' }))).toBe('laptop injoignable')
    expect(french(fmt('Folder not found: {path}', { path: '~/demo' }))).toBe('Dossier introuvable : ~/demo')
    expect(french(fmt('{count} tasks', { count: 3 }))).toBe('3 tâches')
    expect(french('Invalid pane')).toBe('pane invalide')
    expect(french('Some text from Herdr')).toBeUndefined()
  })

  it('build agent notification titles in both languages', () => {
    expect(agentNotificationTitle('blocked', 'laptop · Claude')).toEqual({ title: 'laptop · Claude needs your input', titleFr: 'laptop · Claude attend ta réponse' })
    expect(agentNotificationTitle('done', 'Codex')).toEqual({ title: 'Codex has finished', titleFr: 'Codex a terminé' })
  })
})
