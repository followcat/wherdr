// `wherdr pm …`: a project coordinator's commands. The words go to the server
// as they are (POST /api/pm/cli) with the token from WHERDR_PM_TOKEN; the
// server parses them and checks every right. `template edit` reads the new
// template on stdin, and notes add|edit|file put their text.
import { CliError } from './core.mjs'

const readStdin = async (stdin) => {
  let text = ''
  for await (const chunk of stdin) text += chunk
  return text
}

export async function pm(argv, { env = process.env, stdin = process.stdin, out = process.stdout, request = fetch } = {}) {
  const token = env.WHERDR_PM_TOKEN
  if (!token) throw new CliError('wherdr pm is for a project coordinator: WHERDR_PM_TOKEN is not set', 2)
  const url = (env.WHERDR_URL || `http://127.0.0.1:${env.PORT || '7683'}`).replace(/\/$/, '')
  const body = { argv, ...((argv[0] === 'template' && argv[1] === 'edit') || (argv[0] === 'notes' && (['add', 'edit'].includes(argv[1]) || (argv[1] === 'file' && argv[2] === 'put'))) ? { input: await readStdin(stdin) } : {}) }
  const r = await request(`${url}/api/pm/cli`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || data.error) throw new CliError(data.error || `HTTP ${r.status}`, 1)
  // Once after a wherdr update: a line to read before the answer.
  const notice = r.headers?.get?.('x-wherdr-notice')
  if (notice) out.write(`${notice}\n`)
  out.write(`${JSON.stringify(data, null, 2)}\n`)
}
