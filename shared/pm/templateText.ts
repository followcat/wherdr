// A template written as JSON text: read it, check it, and give each problem
// the line it is on. Also the change log's summary of what a save changed.
import { validateTemplate, type Template, type TaskType } from './workflow'

export interface TextError { line: number, path: string, message: string }
// by: 'user', or 'coordinator <KEY>' with the user's sentence that asked for it.
export interface LogEntry { at: number, by: string, version: number, changes: string[], said?: string } // changes: [] = created

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y
const STRING = /"(?:[^"\\\u0000-\u001F]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y

// A small JSON reader that notes the line where each value starts, under the
// paths validateTemplate gives (taskTypes.simple.steps[2].holder).
function read(text: string) {
  const lines = new Map<string, number>()
  let i = 0
  const fail = (message: string): never => { throw Object.assign(new Error(message), { at: i }) }
  const ws = () => { while (/\s/.test(text[i] ?? '')) i++ }
  const token = (re: RegExp, message: string) => {
    re.lastIndex = i
    const m = re.exec(text) ?? fail(message)
    i += m[0].length
    return JSON.parse(m[0]) as unknown
  }
  const value = (path: string): unknown => {
    ws()
    lines.set(path, text.slice(0, i).split('\n').length)
    const open = text[i]
    if (open !== '{' && open !== '[') return token(open === '"' ? STRING : NUMBER, open === undefined ? 'unexpected end of the text' : `unexpected ${open}`)
    i++
    const out: Record<string, unknown> | unknown[] = open === '{' ? {} : []
    const close = open === '{' ? '}' : ']'
    ws()
    if (text[i] === close) return i++, out
    for (;;) {
      ws()
      if (Array.isArray(out)) out.push(value(`${path}[${out.length}]`))
      else {
        if (text[i] !== '"') fail('expected a field name in double quotes')
        const key = token(STRING, 'invalid field name') as string
        ws()
        if (text[i] !== ':') fail('expected : after the field name')
        i++
        // defineProperty: a "__proto__" field stays a plain field.
        Object.defineProperty(out, key, { value: value(path ? `${path}.${key}` : key), enumerable: true, writable: true, configurable: true })
      }
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === close) return i++, out
      fail(`expected , or ${close}`)
    }
  }
  const out = value('')
  ws()
  if (i < text.length) fail('unexpected text after the end')
  return { value: out, lines }
}

// The line of a path, or of its nearest parent that is in the text.
function lineOf(lines: Map<string, number>, path: string) {
  for (let p = path; ; ) {
    if (lines.has(p)) return lines.get(p)!
    const up = p.replace(/(?:\.[^.[\]]+|\[\d+\])$/, '')
    if (up === p) return 1
    p = up
  }
}

// value: what was read, even with errors (the form still shows it).
export function parseTemplateText(text: string): { value?: unknown, template?: Template, errors: TextError[] } {
  let r: ReturnType<typeof read>
  try { r = read(text) }
  catch (e) { return { errors: [{ line: text.slice(0, (e as { at: number }).at).split('\n').length, path: '', message: (e as Error).message }] } }
  const errors = validateTemplate(r.value).map(e => ({ ...e, line: lineOf(r.lines, e.path) }))
  return { value: r.value, errors, ...(errors.length ? {} : { template: r.value as Template }) }
}

// Field order does not count: the form may write a field back at the end.
const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v)
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const stepIds = (tt: TaskType) => tt.steps.map(s => (typeof s === 'string' ? s : s.id))

// What a save changed, one short line each: "simple: + land", "simple.work".
export function templateChanges(old: Template | null, next: Template): string[] {
  if (!old) return []
  const out = (['id', 'guards', 'instructions', 'prefs', 'worktree', 'steps'] as const).filter(k => !same(old[k], next[k])) as string[]
  for (const name of new Set([...Object.keys(old.taskTypes), ...Object.keys(next.taskTypes)])) {
    const a = old.taskTypes[name], b = next.taskTypes[name]
    if (!a || !b) { out.push(`${a ? '-' : '+'} ${name}`); continue }
    if (same(a, b)) continue
    const before = out.length
    const ia = stepIds(a), ib = stepIds(b)
    for (const id of ib) if (!ia.includes(id)) out.push(`${name}: + ${id}`)
    for (const id of ia) if (!ib.includes(id)) out.push(`${name}: - ${id}`)
    for (const id of ib) if (ia.includes(id) && !same(a.steps[ia.indexOf(id)], b.steps[ib.indexOf(id)])) out.push(`${name}.${id}`)
    if (out.length === before) out.push(name) // order, or the type's own fields
  }
  return out
}
