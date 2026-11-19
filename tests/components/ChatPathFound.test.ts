// WHR-455: a path found in none of the agent's folders is drawn muted, with
// why; the paths of a reply are asked in one request.
import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import { resolveWritten, writtenFound } from '~/composables/useWrittenPaths'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p7', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/home/demo/coord', agentSession: null }
const reply: ChatItem = { role: 'assistant', text: 'See `app/x.vue` and `plans/gone.md`.', ts: '2026-01-01T00:00:00Z' }
registerEndpoint('/api/chat', () => ({ available: true, token: 'paths-1', file: '/tmp/demo/t.jsonl', items: [reply], queue: [] }))
const asked: string[][] = []
registerEndpoint('/api/files/resolve', { method: 'POST', handler: async (e) => {
  const { readBody } = await import('h3')
  const b = await readBody<{ paths: string[] }>(e)
  asked.push(b.paths)
  return { found: { 'app/x.vue': [{ where: 'repo', abs: '/home/demo/project/app/x.vue' }], 'plans/gone.md': [] } }
} })

describe('paths in a reply', () => {
  it('mutes the one found nowhere, after one request', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
    try {
      await expect.poll(() => w.findAll('.md-path-missing').map(c => c.text())).toEqual(['plans/gone.md'])
      expect(w.find('.md-path-missing').attributes('title')).toBe('Not found in the agent’s folder, the repository or the notes')
      expect(w.findAll('.md-path:not(.md-path-missing)').map(c => c.text())).toEqual(['app/x.vue'])
      expect(asked).toEqual([['app/x.vue', 'plans/gone.md']])
    } finally {
      w.unmount()
      herdrState.value = { ok: false, workspaces: [], panes: [] }
    }
  })

  it('asks for every path, in requests of at most 200', async () => {
    const asked: number[] = []
    const paths = Array.from({ length: 201 }, (_, i) => `gone/${i}.md`)
    await resolveWritten('w1:p1', paths, async (b) => {
      const ps = (b as { paths: string[] }).paths
      asked.push(ps.length)
      return { found: Object.fromEntries(ps.map(p => [p, []])) }
    })
    expect(asked.sort((a, b) => a - b)).toEqual([1, 200])
    expect(writtenFound('w1:p1', 'gone/200.md')).toEqual([])
  })
})
