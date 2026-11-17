// Devin's /usage, /context and /session-stats in the conversation: a card with the
// command as a chip, a title, rows, and bars drawn by wherdr for the percentages.
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DevinCommandCard from '~/components/DevinCommandCard.vue'
import type { DevinCommandCard as Card } from '#shared/types'

const USAGE: Card = {
  command: '/usage',
  kind: 'usage',
  windows: [
    { label: 'Daily', percent: 30, reset: 'resets in 4h 39m' },
    { label: 'Weekly', percent: 20, reset: 'resets Nov 22, 4:00 PM (UTC+8)' },
  ],
  session: [{ label: 'Agent messages', value: '1 message' }, { label: 'Model', value: 'SWE-2 Max' }],
  note: null,
}
const CONTEXT: Card = {
  command: '/context',
  kind: 'context',
  model: 'swe-2-max',
  categories: [
    { label: 'System prompt', value: '5.8k', percent: 2 },
    { label: 'Free', value: '248.6k', percent: 95 },
  ],
  total: { used: '13.4k', limit: '262k', percent: 5 },
}
const STATS: Card = {
  command: '/session-stats',
  kind: 'stats',
  rows: [{ label: 'Input tokens', value: '5452 tokens' }],
  models: [{ label: 'SWE-2 Max', value: '13k', percent: 100 }],
  total: '13k tokens',
}
const TEXT: Card = { command: '/context', kind: 'text', lines: ['No context usage available yet. Send a message first.'] }

const mountCard = (card: Card) => mountSuspended(DevinCommandCard, { props: { card, time: '21:39' } })

describe('Devin command card', () => {
  it('shows /usage: its command, the title, the two windows as bars, the session rows', async () => {
    const w = await mountCard(USAGE)
    expect(w.text()).toContain('/usage')
    expect(w.text()).toContain('Usage')
    expect(w.text()).toContain('resets in 4h 39m')
    expect(w.text()).toContain('Agent messages')
    expect(w.text()).toContain('SWE-2 Max')
    const bars = w.findAll('[role="meter"]')
    expect(bars.map(b => b.attributes('aria-valuenow'))).toEqual(['30', '20'])
    expect(bars[0]!.find('i').attributes('style')).toContain('width: 30%')
  })

  it('shows /context: the model, each category with its value, the total', async () => {
    const w = await mountCard(CONTEXT)
    expect(w.text()).toContain('Context usage')
    expect(w.text()).toContain('swe-2-max')
    expect(w.text()).toContain('System prompt')
    expect(w.text()).toContain('248.6k')
    expect(w.text()).toContain('13.4k/262k')
    expect(w.findAll('[role="meter"]').map(b => b.attributes('aria-valuenow'))).toEqual(['2', '95', '5'])
  })

  it('shows /session-stats: the rows, the models with their share, the total', async () => {
    const w = await mountCard(STATS)
    expect(w.text()).toContain('Session stats')
    expect(w.text()).toContain('Input tokens')
    expect(w.text()).toContain('13k tokens')
    expect(w.findAll('[role="meter"]').map(b => b.attributes('aria-valuenow'))).toEqual(['100'])
  })

  it('shows a card it could not read as its text, with no bar', async () => {
    const w = await mountCard(TEXT)
    expect(w.find('pre').text()).toBe('No context usage available yet. Send a message first.')
    expect(w.findAll('[role="meter"]')).toHaveLength(0)
  })

  it('shows the time of the send, muted, on the right of the title', async () => {
    const w = await mountCard(USAGE)
    expect(w.find('time').text()).toBe('21:39')
  })
})
