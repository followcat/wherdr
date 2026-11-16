// @vitest-environment happy-dom
// WHR-378: the Notes panel's open state and linked file, kept on the device
// across a reload; a phone (no room for the panel) does not reopen the sheet.
import { beforeEach, describe, expect, it } from 'vitest'
import { readNotesPanel, saveNotesPanel } from '../app/utils/notesPanel'

describe('Notes panel across a reload', () => {
  beforeEach(() => localStorage.clear())

  it('reopens open, on the linked file shown, and stays closed when closed', () => {
    saveNotesPanel(true, null)
    expect(readNotesPanel(true)).toEqual({ open: true, file: '' })
    saveNotesPanel(true, 'plans/x.md')
    expect(readNotesPanel(true)).toEqual({ open: true, file: 'plans/x.md' })
    saveNotesPanel(false, 'plans/x.md')
    expect(readNotesPanel(true)).toEqual({ open: false, file: '' })
  })

  it('stays closed on a phone layout', () => {
    saveNotesPanel(true, 'plans/x.md')
    expect(readNotesPanel(false)).toEqual({ open: false, file: '' })
  })
})
