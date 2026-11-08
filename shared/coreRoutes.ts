// Routes that answer with herdr-core (WHR-244). One list for the server guard
// (server/middleware/guard.ts) and the client (api() in useHerdr.ts): every
// other /api/ route is "Unavailable with herdr-core". A lot adds its routes in
// its own file, shared/coreRoutes/<lot>.ts, so lots never touch the same lines.
//
// Entry: a path under /api/ without the prefix ('state'), exact: only the
// routes that exist (server/api/). A ':name' segment stands for one path
// segment ('client-plugins/:id/:file'). A 'GET ' prefix ('GET update') allows
// reads only: the route is refused to POST.
import a from './coreRoutes/a'
import b from './coreRoutes/b'
import c from './coreRoutes/c'
import d from './coreRoutes/d'
import e from './coreRoutes/e'
import f from './coreRoutes/f'
import g from './coreRoutes/g'
import h from './coreRoutes/h'
import i from './coreRoutes/i'
import j from './coreRoutes/j'
import k from './coreRoutes/k'
import l from './coreRoutes/l'
import m from './coreRoutes/m'
import n from './coreRoutes/n'
import o from './coreRoutes/o'
import p from './coreRoutes/p'
import q from './coreRoutes/q'
import r from './coreRoutes/r'
import s from './coreRoutes/s'
import t from './coreRoutes/t'
import u from './coreRoutes/u'
import v from './coreRoutes/v'
import w from './coreRoutes/w'
import x from './coreRoutes/x'
import y from './coreRoutes/y'

const BASE = [
  'auth/status', 'auth/lock', 'auth/lock-all', 'auth/disable', 'auth/max-session',
  'auth/login/options', 'auth/login/verify', 'auth/register/options', 'auth/register/verify',
  'core', 'core/terminals', 'client-plugins', 'client-plugins/:id/:file',
  'state', 'config', 'settings', 'health', 'search',
  'chat', 'chat/image', 'prompt', 'input', 'interrupt', 'close', 'agents',
  'dirs', 'isgit', 'quotas', 'claude-statusline', 'claude-setup',
  'machine/add', 'machine/connect', 'machine/core', 'machine/core-rename', 'machine/core-forget',
  'upload', 'attach', 'file', 'keep',
  'dictation/status', 'dictation/key', 'dictation/transcribe', 'dictation/prepare', 'GET dictation/models',
  'dictation/rewrite', 'GET dictation/text-models',
]

export const CORE_ROUTES = [...BASE, ...a, ...b, ...c, ...d, ...e, ...f, ...g, ...h, ...i, ...j, ...k, ...l, ...m, ...n, ...o, ...p, ...q, ...r, ...s, ...t, ...u, ...v, ...w, ...x, ...y]
const readOnly = CORE_ROUTES.filter(r => r.startsWith('GET ')).map(r => r.slice(4))
const open = CORE_ROUTES.filter(r => !r.startsWith('GET '))
const exact = new Set(open.filter(r => !r.includes(':')))
const patterns = open.filter(r => r.includes(':')).map(r => r.split('/'))
const matches = (pattern: string[], rest: string) => {
  const parts = rest.split('/')
  return parts.length === pattern.length && pattern.every((p, i) => p.startsWith(':') ? parts[i] !== '' : p === parts[i])
}

/** `path`: '/api/state', with or without a query string; `method`: 'GET' unless told. */
export function coreRouteAllowed(path: string, method = 'GET'): boolean {
  const m = /^\/api\/([^?#]*)/.exec(path)
  if (!m) return false
  const rest = m[1]!
  if (method.toUpperCase() === 'GET' && readOnly.includes(rest)) return true
  return exact.has(rest) || patterns.some(p => matches(p, rest))
}
