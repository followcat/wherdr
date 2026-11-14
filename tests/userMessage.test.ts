import { describe, expect, it } from 'vitest'
import { userMessageParts } from '../app/utils/userMessage'

describe('a delivered user message: photos and files leave its text', () => {
  it('a herdr-core photo path left as text (Send now, Claude\'s queue) shows as the photo', () => {
    const parts = userMessageParts('what is wrong here?\n/srv/state/herdr-core/s1/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png')
    expect(parts).toEqual({ text: 'what is wrong here?', srcs: ['/uploads/2026-01-01T10-00-00-000Z-a1b2c3.png'], files: [] })
  })

  it('a v2 upload path and an attached file: a photo and a chip, no path in the text', () => {
    const parts = userMessageParts('see\n/home/user/.cache/herdr-web/uploads/a.jpg\n@/home/user/.cache/herdr-web/files/notes.md')
    expect(parts.text).toBe('see')
    expect(parts.srcs).toEqual(['/uploads/a.jpg'])
    expect(parts.files).toEqual([expect.objectContaining({ path: '/home/user/.cache/herdr-web/files/notes.md' })])
  })

  it('an embedded image and another photo left as a path: both shown, the path not in the text', () => {
    const embedded = ['/api/chat/image?pane=p1&file=f&ref=3&i=0']
    const parts = userMessageParts('two shots\n/srv/state/herdr-core/s1/files/t1/2026-01-01T10-00-00-000Z-a1b2c3.png', embedded)
    expect(parts.srcs).toEqual([embedded[0], '/uploads/2026-01-01T10-00-00-000Z-a1b2c3.png'])
    expect(parts.text).toBe('two shots')
  })
})
