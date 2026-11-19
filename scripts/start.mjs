#!/usr/bin/env node
// npm start on every OS: the HOST/PORT defaults without shell syntax, then the
// built server as a child process, so its argv stays .output/server/index.mjs
// (the build and docs lookups and `wherdr status` read it).
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const env = { ...process.env, HOST: process.env.HOST || '127.0.0.1', PORT: process.env.PORT || '7683' }
const child = spawn(process.execPath, [path.join(root, '.output', 'server', 'index.mjs')], { env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { if (child.exitCode === null) child.kill(signal) })
}
child.on('error', (error) => { console.error(error.message); process.exit(1) })
child.on('exit', (code, signal) => {
  if (!signal) process.exit(code ?? 1)
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
})
