import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPark, MAX_PARKED, terminalIdentity } from '../app/utils/terminalPark'

// The parked-terminal cache: bounds, eviction, identity. The idle limit lives
// on the controller (useTerminal.park), not here — see TerminalPark.test.ts.
function viewer() {
  return { dispose: vi.fn() }
}

describe('terminalPark', () => {
  let park: ReturnType<typeof createPark>
  let one: ReturnType<typeof viewer>
  let two: ReturnType<typeof viewer>
  let three: ReturnType<typeof viewer>

  beforeEach(() => {
    park = createPark()
    one = viewer()
    two = viewer()
    three = viewer()
  })

  it('keeps the two most recently parked terminals and disposes the oldest', () => {
    park.keep('p1', { identity: 'a/t1', viewer: one })
    park.keep('p2', { identity: 'a/t2', viewer: two })
    park.keep('p3', { identity: 'a/t3', viewer: three })
    expect(MAX_PARKED).toBe(2)
    expect(park.keys()).toEqual(['p2', 'p3'])
    // Eviction disposes: the controller's dispose closes its socket.
    expect(one.dispose).toHaveBeenCalledTimes(1)
    expect(two.dispose).not.toHaveBeenCalled()
    expect(three.dispose).not.toHaveBeenCalled()
  })

  it('re-parking a pane refreshes its recency instead of adding an entry', () => {
    park.keep('p1', { identity: 'a/t1', viewer: one })
    park.keep('p2', { identity: 'a/t2', viewer: two })
    park.keep('p1', { identity: 'a/t1', viewer: one })
    park.keep('p3', { identity: 'a/t3', viewer: three })
    expect(park.keys()).toEqual(['p1', 'p3'])
    expect(two.dispose).toHaveBeenCalledTimes(1)
    expect(one.dispose).not.toHaveBeenCalled()
  })

  it('taking a parked terminal removes it without disposing it', () => {
    park.keep('p1', { identity: 'a/t1', viewer: one })
    expect(park.take('p1', 'a/t1')).toBe(one)
    expect(one.dispose).not.toHaveBeenCalled()
    expect(park.size()).toBe(0)
    expect(park.take('p1', 'a/t1')).toBeNull()
  })

  it('drops an entry whose terminal changed identity while parked', () => {
    park.keep('p1', { identity: 'a/t1', viewer: one })
    expect(park.take('p1', 'a/t9')).toBeNull()
    expect(one.dispose).toHaveBeenCalledTimes(1)
    expect(park.size()).toBe(0)
  })

  it('drops a pane that left the state, or whose terminal changed, and keeps the rest', () => {
    park.keep('p1', { identity: 'a/t1', viewer: one })
    park.keep('p2', { identity: 'a/t2', viewer: two })
    const live = new Map([['p1', 'a/t1'], ['p2', 'a/t9']])
    park.reconcile(key => live.get(key) ?? null)
    expect(park.keys()).toEqual(['p1'])
    expect(two.dispose).toHaveBeenCalledTimes(1)
    expect(one.dispose).not.toHaveBeenCalled()
  })

  it('forgets a viewer that disposed itself without disposing it again', () => {
    park.keep('p1', { identity: 'a/t1', viewer: one })
    park.forget(one)
    expect(park.size()).toBe(0)
    expect(one.dispose).not.toHaveBeenCalled()
  })

  it('dispose()ting an unknown key changes nothing', () => {
    park.keep('p1', { identity: 'a/t1', viewer: one })
    park.drop('nope')
    expect(park.size()).toBe(1)
    expect(one.dispose).not.toHaveBeenCalled()
  })

  it('the identity of a pane is its core address, and nothing for a pane without one', () => {
    expect(terminalIdentity({ coreAddress: 'host-a/t7' })).toBe('host-a/t7')
    expect(terminalIdentity({})).toBeNull()
    expect(terminalIdentity(null)).toBeNull()
    // bornAt churns between snapshots (transcript readers decorate their own
    // copies) and a pane's core address already names its incarnation.
    expect(terminalIdentity({ coreAddress: 'host-a/t7', bornAt: 1000 } as { coreAddress?: string })).toBe('host-a/t7')
    expect(terminalIdentity({ coreAddress: 'host-a/t7', bornAt: 2000 } as { coreAddress?: string })).toBe('host-a/t7')
  })
})
