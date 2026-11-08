import { describe, expect, it } from 'vitest'
import { BOARD_PATH, BOARD_SETUP_PATH, boardEntry } from '../app/utils/boardEntry'

const project = { key: 'demo', name: 'Demo', machine: '', path: '/tmp/demo', base: 'main', template: 'default' }

// Where the home list's Board button leads (the click itself: tests/components/HomeHeader.test.ts).
describe('boardEntry', () => {
  it('opens Settings › Projects while project management is off or has no project', () => {
    expect(boardEntry({ enabled: false, projects: [] })).toBe(BOARD_SETUP_PATH)
    expect(boardEntry({ enabled: false, projects: [project] as never })).toBe(BOARD_SETUP_PATH)
    expect(boardEntry({ enabled: true, projects: [] })).toBe(BOARD_SETUP_PATH)
    expect(BOARD_SETUP_PATH).toBe('/settings?section=projects')
  })

  it('opens the board with a project, and when the overview is unreadable (the board shows its own error)', () => {
    expect(boardEntry({ enabled: true, projects: [project] as never })).toBe(BOARD_PATH)
    expect(boardEntry(null)).toBe(BOARD_PATH)
    expect(BOARD_PATH).toBe('/board')
  })
})
