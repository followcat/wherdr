// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createPluginHost, type HostDeps } from '../app/utils/pluginHost'
import { createHeaderActionsMount } from '../app/utils/headerActions'

const dir = resolve(__dirname, '../docs/examples/plugins/hello-header')

const hosts: ReturnType<typeof createPluginHost>[] = []

function setup(load: HostDeps['load'], initialDraft: string | null = '') {
  let draftText = initialDraft
  const focus = vi.fn()
  const navs = new Set<(p: string) => void>()
  let prefs = { off: [] as string[], failed: {} as Record<string, string> }
  const host = createPluginHost({
    list: async () => ({ plugins: [{ id: 'hello-header', name: 'Hello header', version: '1.0.0', description: '', main: 'index.js' }], enabled: true }),
    load,
    getDraft: () => draftText,
    setDraft: (t) => { if (draftText !== null) draftText = t },
    insertDraft: (t) => {
      if (draftText !== null) draftText = draftText && !/\s$/.test(draftText) ? `${draftText} ${t}` : draftText + t
    },
    focusDraft: focus,
    currentAgent: () => null,
    subscribeNavigate: (cb) => { navs.add(cb); return () => navs.delete(cb) },
    mountHeaderAction: createHeaderActionsMount(),
    prefs: () => prefs,
    savePrefs: (p) => { prefs = p },
    changed: () => {},
    timeoutMs: 1000,
  })
  hosts.push(host)
  return { host, focus, getDraft: () => draftText, setDraftRaw: (v: string | null) => { draftText = v } }
}

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.setEnabled('hello-header', false)
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

describe('hello-header example plugin', () => {
  it('mounts a button in header-actions, inserts a template and focuses the composer without sending', async () => {
    document.body.innerHTML = '<div class="home-actions"><span data-wherdr="header-actions" class="header-actions"></span></div>'
    const s = setup(() => import(/* @vite-ignore */ pathToFileURL(resolve(dir, 'index.js')).href), '')
    await s.host.init()
    expect(s.host.rows()[0]!.status).toBe('running')
    const button = document.querySelector<HTMLButtonElement>('[data-wherdr="header-actions"] button')!
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).toBeTruthy()
    button.click()
    expect(s.getDraft()).toBeTruthy()
    expect(s.focus).toHaveBeenCalledTimes(1)
  })

  it('removes everything it added when stopped', async () => {
    document.body.innerHTML = '<div class="agent-actions"><span data-wherdr="header-actions" class="header-actions"></span></div>'
    const s = setup(() => import(/* @vite-ignore */ pathToFileURL(resolve(dir, 'index.js')).href))
    await s.host.init()
    expect(document.querySelector('[data-wherdr="header-actions"] button')).not.toBeNull()
    await s.host.setEnabled('hello-header', false)
    expect(document.querySelector('[data-wherdr="header-actions"] button')).toBeNull()
    expect(document.getElementById('hello-header-style')).toBeNull()
  })
})
