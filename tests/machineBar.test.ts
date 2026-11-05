import { describe, expect, it } from 'vitest'
import { BAR_ALL, groupedBarItems, readMachineGroups, barMachineSelection, barItems, barPick, moveBarItem, readBarList, readBarPick, setBarItemShown } from '../app/utils/machineBar'

// The local machine's key is ''.
const machines = ['', 'laptop', 'devbox']

describe('machine bar items', () => {
  it('defaults to All, then every machine in the home list order', () => {
    expect(barItems([], machines)).toEqual([BAR_ALL, '', 'laptop', 'devbox'])
  })

  it('keeps the saved order and drops machines that are gone', () => {
    expect(barItems(['devbox', BAR_ALL, 'old', '', 'laptop'], machines)).toEqual(['devbox', BAR_ALL, '', 'laptop'])
  })

  it('puts a new machine last and All first when the saved order lacks them', () => {
    expect(barItems(['laptop', ''], machines)).toEqual([BAR_ALL, 'laptop', '', 'devbox'])
    expect(barItems(['laptop', BAR_ALL], machines)).toEqual(['laptop', BAR_ALL, '', 'devbox'])
  })

  it('ignores duplicates in a saved order', () => {
    expect(barItems(['laptop', 'laptop', BAR_ALL], ['laptop'])).toEqual(['laptop', BAR_ALL])
  })

})

describe('machine bar choice', () => {
  const shown = [BAR_ALL, '', 'laptop']

  it('keeps the saved choice while the bar shows it', () => {
    expect(barPick('laptop', shown)).toBe('laptop')
    // The local machine's key is empty, and still a choice.
    expect(barPick('', shown)).toBe('')
  })

  it('falls back to the first item when the choice is gone or hidden', () => {
    expect(barPick('devbox', shown)).toBe(BAR_ALL)
    expect(barPick(null, shown)).toBe(BAR_ALL)
    expect(barPick('devbox', ['laptop', ''])).toBe('laptop')
    // "All" placed after a machine is still the choice by default.
    expect(barPick(null, ['laptop', BAR_ALL])).toBe(BAR_ALL)
    expect(barPick('laptop', [])).toBeNull()
  })

})

describe('machine bar settings', () => {
  const items = [BAR_ALL, '', 'laptop', 'devbox']

  it('moves an item to a gap of the list', () => {
    expect(moveBarItem(items, 'devbox', 0)).toEqual(['devbox', BAR_ALL, '', 'laptop'])
    expect(moveBarItem(items, BAR_ALL, 4)).toEqual(['', 'laptop', 'devbox', BAR_ALL])
    expect(moveBarItem(items, '', 3)).toEqual([BAR_ALL, 'laptop', '', 'devbox'])
    // Its own gaps: no change.
    expect(moveBarItem(items, 'laptop', 2)).toEqual(items)
    expect(moveBarItem(items, 'laptop', 3)).toEqual(items)
    expect(moveBarItem(items, 'nope', 0)).toEqual(items)
  })

  it('hides and shows an item', () => {
    expect(setBarItemShown([], '', false)).toEqual([''])
    expect(setBarItemShown([''], '', false)).toEqual([''])
    expect(setBarItemShown(['', 'laptop'], '', true)).toEqual(['laptop'])
  })

  it('reads what the device saved, whatever it holds', () => {
    expect(readBarList('["*","","laptop","laptop",3]')).toEqual(['*', '', 'laptop'])
    expect(readBarList('{"a":1}')).toEqual([])
    expect(readBarList('not json')).toEqual([])
    expect(readBarList(null)).toEqual([])
    expect(readBarPick('""')).toBe('')
    expect(readBarPick('"laptop"')).toBe('laptop')
    expect(readBarPick('null')).toBeNull()
    expect(readBarPick('3')).toBeNull()
    expect(readBarPick('oops')).toBeNull()
    expect(readBarPick(null)).toBeNull()
  })
})

describe('saved machine groups', () => {
  const groups = [{ id: '*group:home', name: 'Home', machines: ['laptop', ''] }]
  it('inserts groups after All and preserves custom positions', () => {
    expect(groupedBarItems([], machines, groups)).toEqual([BAR_ALL, '*group:home', ...machines])
    expect(groupedBarItems(['laptop', BAR_ALL, ''], machines, groups)).toEqual(['laptop', BAR_ALL, '*group:home', '', 'devbox'])
    expect(groupedBarItems(['*group:home', 'laptop', BAR_ALL], machines, groups)).toEqual(['*group:home', 'laptop', BAR_ALL, '', 'devbox'])
    expect(groupedBarItems(['*group:old'], machines, [])).toEqual([BAR_ALL, ...machines])
  })
  it('selects the ordered members, including the local key and empty groups', () => {
    expect(barMachineSelection('*group:home', groups)).toEqual(['laptop', ''])
    expect(barMachineSelection(BAR_ALL, groups)).toBeNull()
    expect(barMachineSelection('', groups)).toEqual([''])
    expect(barMachineSelection('*group:empty', [{ id: '*group:empty', name: 'Empty', machines: [] }])).toEqual([])
  })
  it('tolerates corrupt storage, duplicate groups and duplicate members', () => {
    expect(readMachineGroups('invalid')).toEqual([])
    expect(readMachineGroups('{}')).toEqual([])
    expect(readMachineGroups(JSON.stringify([null, { id: 'laptop', name: 'Bad', machines: [] }, ...groups, ...groups]))).toEqual(groups)
    expect(readMachineGroups(JSON.stringify([{ id: '*group:x', name: ' X ', machines: ['', '', 4, '*'] }]))).toEqual([{ id: '*group:x', name: 'X', machines: [''] }])
  })
})
