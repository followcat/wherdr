// @vitest-environment happy-dom
// WHR-202: a `wherdr` block's `task <ID>` lines, and the row a task shows as.
import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { md, messageChoices, parseWherdrBlock } from '../app/utils/markdown'
import { taskRow, type Card } from '../shared/pm/board'

describe('wherdr blocks', () => {
  it('reads the choices of a message\'s last choices line (Tasks to review)', () => {
    const msg = 'Docker is off.\n\n```wherdr\nchoices "A" | "B"\n```\n\nOr:\n\n```wherdr\nchoices "Docker started, go on" | "Write it without testing" | "Stop here"\n```\n'
    expect(messageChoices(msg)).toEqual(['Docker started, go on', 'Write it without testing', 'Stop here'])
    expect(messageChoices('No block.\n\n```sh\nchoices "A"\n```')).toEqual([])
  })

  it('reads task lines, and leaves any block with a line it does not know as code', () => {
    expect(parseWherdrBlock('task WHR-12\n\n  task ACME-API-4  \n')).toEqual([{ kind: 'task', id: 'WHR-12' }, { kind: 'task', id: 'ACME-API-4' }])
    for (const text of ['', 'task', 'task WHR-12 extra', 'task WHR-12\nmerge WHR-12', 'task <b>-1']) expect(parseWherdrBlock(text)).toBeNull()
  })

  // WHR-283: one option is a one-click confirm; none or more than four stay invalid.
  it('reads choices of 1 to 4 options, and nothing else', () => {
    expect(parseWherdrBlock('choices "OK, fix the test"')).toEqual([{ kind: 'choices', options: ['OK, fix the test'] }])
    expect(parseWherdrBlock('choices "A" | "B" | "C" | "D"')?.[0]).toMatchObject({ options: ['A', 'B', 'C', 'D'] })
    for (const text of ['choices', 'choices ""', 'choices "A" | "B" | "C" | "D" | "E"', 'choices "A" | "a"', 'choices A']) expect(parseWherdrBlock(text)).toBeNull()
  })

  it('draws an invalid block as an ordinary code block', () => {
    ;(globalThis as { t?: (s: string) => string }).t = s => s
    md('') // installs the app's code renderer
    const html = (text: string) => marked.parse(`\`\`\`wherdr\n${text}\n\`\`\``, { gfm: true, async: false }) as string
    expect(html('choices "OK"')).toContain('<button type="button" class="q-choice" data-a="OK">OK</button>')
    for (const text of ['choices "A" | "B" | "C" | "D" | "E"', 'choices', 'merge WHR-12']) {
      expect(html(text)).toContain('class="code-block"')
      expect(html(text)).not.toContain('q-choice')
    }
  })
})

describe('taskRow', () => {
  const card = (c: Partial<Card>) => ({ id: 'CO-4', shown: 'CO-4', project: 'co', title: 'Fix login', column: 'review', phase: 'working', holder: 'reviewer', ...c }) as Card
  it('says what to do in Your turn, else where the task stands and its column', () => {
    expect(taskRow(card({ yourTurn: 'Look at the screenshots\nmore', state: { yourTurn: { reason: 'user' } } as Card['state'], userLabel: 'Merge' })))
      .toMatchObject({ action: 'Look at the screenshots', label: 'Merge' })
    expect(taskRow(card({}))).toMatchObject({ action: 'Being reviewed', label: 'review' })
    expect(taskRow(card({ stopped: { by: 'user', why: 'paused', at: 1 } }))).toMatchObject({ action: 'Stopped: paused' })
    expect(taskRow(card({ phase: 'todo', column: 'To do', holder: 'none' }))).toMatchObject({ action: 'Not started yet', label: 'To do' })
  })
})
