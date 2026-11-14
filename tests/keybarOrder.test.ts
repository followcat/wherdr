import { describe, expect, it } from 'vitest'
import { isDefaultKeyOrder, mergeKeyOrder, moveKey, PHONE_KEY_IDS, readHiddenKeys, readKeyOrder, shownKeys, writeHiddenKeys, writeKeyOrder, type PhoneKeyId } from '../app/utils/keybarOrder'
import { PHONE_KEYS } from '../app/utils/phoneKeys'

describe('phone key bar order', () => {
  it('keeps the historical order by default', () => {
    expect(readKeyOrder(null)).toEqual([
      'keyboard', 'ctrl', 'esc', 'tab', 'left', 'up', 'down', 'right', 'enter', 'ctrl-c', 'backspace',
      'home', 'end', 'pageup', 'pagedown', 'delete', 'insert', 'alt', 'shift', 'y', 'n',
      ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
    ])
  })

  it('describes every key exactly once', () => {
    expect(Object.keys(PHONE_KEYS).sort()).toEqual([...PHONE_KEY_IDS].sort())
    for (const id of PHONE_KEY_IDS) expect(PHONE_KEYS[id].id).toBe(id)
  })

  it('follows the saved order, then appends the keys it misses in default order', () => {
    const merged = mergeKeyOrder(['enter', 'esc', 'ctrl'])
    expect(merged.slice(0, 3)).toEqual(['enter', 'esc', 'ctrl'])
    expect(merged.slice(3)).toEqual(PHONE_KEY_IDS.filter(id => !['enter', 'esc', 'ctrl'].includes(id)))
  })

  it('ignores unknown, repeated and non-string ids without losing a key', () => {
    const merged = mergeKeyOrder(['tab', 'hyper', 'tab', 42, null, { id: 'esc' }, 'esc'])
    expect(merged.slice(0, 2)).toEqual(['tab', 'esc'])
    expect(merged).toHaveLength(PHONE_KEY_IDS.length)
    expect(new Set(merged)).toEqual(new Set(PHONE_KEY_IDS))
  })

  it('adds a key from a later version at the end of an older saved order', () => {
    const defaults = [...PHONE_KEY_IDS.filter(id => id !== 'f12'), 'f12'] as PhoneKeyId[]
    const saved = PHONE_KEY_IDS.filter(id => id !== 'f12').reverse()
    expect(mergeKeyOrder(saved, defaults)).toEqual([...saved, 'f12'])
  })

  it('reads damaged storage as the default order', () => {
    for (const raw of ['', 'not json', '{"a":1}', '"esc"', 'null', '[]']) expect(readKeyOrder(raw)).toEqual([...PHONE_KEY_IDS])
  })

  it('round-trips a custom order and stores nothing for the default', () => {
    const order = moveKey([...PHONE_KEY_IDS], 'enter', 0)
    const raw = writeKeyOrder(order)
    expect(raw).not.toBeNull()
    expect(readKeyOrder(raw)).toEqual(order)
    expect(writeKeyOrder([...PHONE_KEY_IDS])).toBeNull()
    expect(isDefaultKeyOrder(order)).toBe(false)
    expect(isDefaultKeyOrder(readKeyOrder(null))).toBe(true)
  })

  it('moves a key to an index of the resulting order, clamped', () => {
    const order: PhoneKeyId[] = ['keyboard', 'ctrl', 'esc', 'tab']
    expect(moveKey(order, 'esc', 0)).toEqual(['esc', 'keyboard', 'ctrl', 'tab'])
    expect(moveKey(order, 'ctrl', 2)).toEqual(['keyboard', 'esc', 'ctrl', 'tab'])
    expect(moveKey(order, 'keyboard', 99)).toEqual(['ctrl', 'esc', 'tab', 'keyboard'])
    expect(moveKey(order, 'tab', -3)).toEqual(['tab', 'keyboard', 'ctrl', 'esc'])
  })

  it('stores hidden keys without the keyboard key, and nothing when every key shows', () => {
    expect(readHiddenKeys('["esc","hyper","esc","keyboard",3]')).toEqual(['esc'])
    expect(readHiddenKeys('not json')).toEqual([])
    expect(writeHiddenKeys([])).toBeNull()
    expect(writeHiddenKeys(['keyboard'])).toBeNull()
    expect(writeHiddenKeys(['tab', 'esc'])).toBe('["tab","esc"]')
    expect(shownKeys(['esc', 'keyboard', 'tab'], ['esc'])).toEqual(['keyboard', 'tab'])
  })
})
