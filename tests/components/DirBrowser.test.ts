import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery, setResponseStatus } from 'h3'
import DirBrowser from '~/components/DirBrowser.vue'

const HOME = '/home/user'
const asked: string[] = []
registerEndpoint('/api/dirs', (event) => {
  const q = getQuery(event)
  const path = String(q.path || HOME)
  asked.push(path)
  const remote = q.machine ? { remote: true } : {}
  if (path === `${HOME}/Documents`) return { path, parent: HOME, home: HOME, dirs: [], denied: 'macos', ...remote }
  if (path === `${HOME}/locked`) return { path, parent: HOME, home: HOME, dirs: [], denied: 'permission' }
  if (path === `${HOME}/empty`) return { path, parent: HOME, home: HOME, dirs: [] }
  if (path === `${HOME}/code`) return { path, parent: HOME, home: HOME, dirs: [{ name: 'app', path: `${HOME}/code/app`, git: true }] }
  if (path === `${HOME}/code/app`) return { path, parent: `${HOME}/code`, home: HOME, dirs: [{ name: 'src', path: `${HOME}/code/app/src`, git: false }] }
  if (path === `${HOME}/code/app/src`) return { path, parent: `${HOME}/code/app`, home: HOME, dirs: [] }
  if (path !== HOME) { setResponseStatus(event, 400); return { error: 'Not found', code: 'bad_path' } }
  return { path, parent: null, home: HOME, dirs: ['Documents', 'code', 'empty', 'locked'].map(name => ({ name, path: `${HOME}/${name}`, git: false })) }
})

// Each folder is read through fetch: wait until no row is loading.
async function settle(w: { find: (s: string) => { exists: () => boolean } }) {
  await flushPromises()
  await vi.waitFor(() => expect(w.find('.tree-row').exists() && !w.find('.tree-note.tree-loading').exists()).toBe(true))
}
async function open(start: string, machine = '') {
  const w = await mountSuspended(DirBrowser, { props: { start, machine } })
  await settle(w)
  return w
}
const rows = (w: Awaited<ReturnType<typeof open>>) => w.findAll('.tree-row').map(b => b.text())
const row = (w: Awaited<ReturnType<typeof open>>, label: string) => w.findAll('.tree-row').find(b => b.text().replace(/git$/, '') === label)!

describe('DirBrowser', () => {
  it('opens on the start folder, its parents expanded, and explains a folder macOS refuses over SSH', async () => {
    const w = await open(`${HOME}/Documents`, 'abcd1234')
    expect(rows(w)).toEqual(['~', 'Documents', 'macOS blocks access to this folder', 'code', 'empty', 'locked'])
    expect(w.find('.dir-input').element).toHaveProperty('value', '~/Documents')
    const box = w.find('.dir-denied')
    expect(box.text()).toContain('macOS blocks access to this folder')
    expect(box.text()).toContain('Allow full disk access for remote users')
    expect(w.text()).not.toContain('No subfolders.')
  })

  it('loads a folder once when it is expanded, and marks Git repositories', async () => {
    const w = await open(HOME)
    await row(w, 'code').trigger('click')
    await settle(w)
    expect(rows(w)).toEqual(['~', 'Documents', 'code', 'appgit', 'empty', 'locked'])
    await row(w, 'code').trigger('click')
    await row(w, 'code').trigger('click')
    await settle(w)
    expect(asked.filter(p => p === `${HOME}/code`)).toHaveLength(1)
  })

  it('opens a typed deep folder expanded, and chooses it', async () => {
    const w = await open(HOME)
    await w.find('.dir-input').setValue('~/code/app/src')
    await w.find('form.dir-go').trigger('submit')
    await vi.waitFor(() => expect(rows(w)).toEqual(['~', 'Documents', 'code', 'appgit', 'src', 'No subfolders.', 'empty', 'locked']))
    expect(w.find('.tree-row[data-selected]').text()).toBe('src')
    await w.findAll('button').find(b => b.text() === 'Choose this folder')!.trigger('click')
    expect(w.emitted('choose')).toEqual([[`${HOME}/code/app/src`]])
  })

  it('keeps the tree and says so when a typed folder does not exist', async () => {
    const w = await open(HOME)
    await w.find('.dir-input').setValue('~/nowhere')
    await w.find('form.dir-go').trigger('submit')
    await vi.waitFor(() => expect(w.find('.dir-go-error').exists()).toBe(true))
    expect(w.find('.dir-go-error').text()).toBe('Folder not found or unreadable on this machine.')
    expect(w.find('.tree-row[data-selected]').text()).toBe('~')
  })

  it('points a local Mac to Full Disk Access', async () => {
    const box = (await open(`${HOME}/Documents`)).find('.dir-denied')
    expect(box.text()).toContain('Full Disk Access')
    expect(box.text()).not.toContain('Remote Login')
  })

  it('says "Permission denied" for plain rights, and "No subfolders" only for an empty folder', async () => {
    expect((await open(`${HOME}/locked`)).find('.dir-denied').text()).toContain('Permission denied')
    const empty = await open(`${HOME}/empty`)
    expect(empty.find('.dir-denied').exists()).toBe(false)
    expect(empty.text()).toContain('No subfolders.')
  })
})
