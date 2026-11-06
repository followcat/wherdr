import { describe, expect, it } from 'vitest'
import { agentIcon } from '../../app/utils/agentIcons'
import { kindLabel } from '../../app/utils/format'
import { paneTitle } from '../../shared/paneTitle'
import { TRANSCRIPT_AGENTS } from '../../shared/agentKind'
import type { Pane } from '../../shared/types'

// One agent kind, one name, one icon — wherever a pane is labelled.
describe('Command Code presentation', () => {
  const pane = (o: Partial<Pane> = {}): Pane => ({
    id: 'w1:p1', workspace: 'w1', tab: 't1', tabLabel: null,
    agent: 'cmd', name: 'cmd', label: null, status: 'idle',
    title: '', cwd: '/tmp', agentSession: null, ...o,
  })
  it('labels the same kind Command Code in every surface', () => {
    expect(kindLabel('cmd')).toBe('Command Code')
    expect(paneTitle(pane())).toBe('Command Code')
    expect(agentIcon('cmd')).toBe('i-lucide-square-terminal')
    expect(TRANSCRIPT_AGENTS).toContain('cmd')
  })
})
