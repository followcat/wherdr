// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createPluginHost, type HostDeps } from '../app/utils/pluginHost'

const dir = resolve(__dirname, '../docs/examples/plugins/hello-mic')

const hosts: ReturnType<typeof createPluginHost>[] = []

function setup(load: HostDeps['load']) {
  const insert = vi.fn()
  const navs = new Set<(p: string) => void>()
  let prefs = { off: [] as string[], failed: {} as Record<string, string> }
  const host = createPluginHost({
    list: async () => [{ id: 'hello-mic', name: 'Hello mic', version: '1.0.0', description: '', main: 'index.js' }],
    load,
    insertDraft: insert,
    currentAgent: () => null,
    subscribeNavigate: (cb) => { navs.add(cb); return () => navs.delete(cb) },
    prefs: () => prefs,
    savePrefs: (p) => { prefs = p },
    changed: () => {},
    timeoutMs: 200,
  })
  hosts.push(host)
  return { host, insert }
}

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.setEnabled('hello-mic', false) // stop its observer
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

describe('hello-mic example plugin', () => {
  it('adds a mic button to the composer slot and inserts the sample text', async () => {
    document.body.innerHTML = '<div data-wherdr="composer"><span data-wherdr="composer-actions"></span></div>'
    const s = setup(() => import(/* @vite-ignore */ pathToFileURL(resolve(dir, 'index.js')).href))
    await s.host.init()
    expect(s.host.rows()[0]!.status).toBe('running')
    const button = document.querySelector<HTMLButtonElement>('[data-wherdr="composer-actions"] .hello-mic')!
    expect(button.getAttribute('aria-label')).toBeTruthy()
    button.click()
    expect(s.insert).toHaveBeenCalledWith('This is a sample dictated text.')
  })

  it('adds the button when the composer appears later, and only once', async () => {
    const s = setup(() => import(/* @vite-ignore */ pathToFileURL(resolve(dir, 'index.js')).href))
    await s.host.init()
    document.body.innerHTML = '<span data-wherdr="composer-actions"></span>'
    await new Promise(r => setTimeout(r, 20))
    expect(document.querySelectorAll('.hello-mic')).toHaveLength(1)
  })

  it('removes everything it added when switched off', async () => {
    document.body.innerHTML = '<span data-wherdr="composer-actions"></span>'
    const s = setup(() => import(/* @vite-ignore */ pathToFileURL(resolve(dir, 'index.js')).href))
    await s.host.init()
    expect(document.querySelector('.hello-mic')).not.toBeNull()
    await s.host.setEnabled('hello-mic', false)
    expect(document.querySelector('.hello-mic')).toBeNull()
    expect(document.getElementById('hello-mic-style')).toBeNull()
  })

  it('a failing load disables the plugin without touching the page', async () => {
    document.body.innerHTML = '<span data-wherdr="composer-actions"></span>'
    const s = setup(async () => { throw new Error('cannot load') })
    await s.host.init()
    expect(s.host.rows()[0]).toMatchObject({ status: 'failed', error: 'cannot load' })
    expect(document.querySelector('.hello-mic')).toBeNull()
  })
})
