// `wherdr pm …`: a project coordinator's commands. The words go to the server
// as they are (POST /api/pm/cli) with the token from WHERDR_PM_TOKEN; the
// server parses them and checks every right. `template edit` reads the new
// template on stdin.
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
  const body = { argv, ...(argv[0] === 'template' && argv[1] === 'edit' ? { input: await readStdin(stdin) } : {}) }
  const r = await request(`${url}/api/pm/cli`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || data.error) throw new CliError(data.error || `HTTP ${r.status}`, 1)
  out.write(`${JSON.stringify(data, null, 2)}\n`)
}
