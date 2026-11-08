import { describe, expect, it } from 'vitest'
import { stateMachines } from '../app/utils/homeGrouping'

describe('stateMachines', () => {
  const list = [
    { key: '', status: 'online' as const },
    { key: 'laptop', status: 'connecting' as const },
    { key: 'laptop#work', baseKey: 'laptop', status: 'online' as const },
    { key: 'nas', status: 'offline' as const },
  ]

  it('splits online machines from offline and reconnecting ones', () => {
    const { online, away } = stateMachines(list, null)
    expect(online.map(m => m.key)).toEqual(['', 'laptop#work'])
    expect(away.map(m => m.key)).toEqual(['laptop', 'nas'])
  })

  it('follows the bar selection by base key, in its order', () => {
    const { online, away } = stateMachines(list, ['nas', 'laptop'])
    expect(online.map(m => m.key)).toEqual(['laptop#work'])
    expect(away.map(m => m.key)).toEqual(['nas', 'laptop'])
    expect(stateMachines(list, [])).toEqual({ online: [], away: [] })
  })
})
