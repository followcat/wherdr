import { describe, expect, it } from 'vitest'
import {
  ATTACH_LIMITS, agentReads, closeTrailingMention, attachmentDisplayName, attachmentIcon, attachmentRef, checkAttachment,
  classifyAttachment, isStoredAttachmentName, looksLikeText, parseAttachmentLine, safeAttachmentName, storedAttachmentName,
} from '../shared/attachments'

const enc = (s: string) => new TextEncoder().encode(s)
const PDF = enc('%PDF-1.7\n%âãÏÓ\n')
const BIN = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2])

describe('attachment kinds', () => {
  it('tells text from binary by its first bytes', () => {
    expect(looksLikeText(enc('const a = 1\n'))).toBe(true)
    expect(looksLikeText(enc('héllo wörld'))).toBe(true)
    // A multibyte character cut at the end of the sample.
    expect(looksLikeText(enc('ok é').subarray(0, 4))).toBe(true)
    expect(looksLikeText(BIN)).toBe(false)
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41, 0x42]))).toBe(false)
  })

  it('classifies by name, type and content', () => {
    expect(classifyAttachment('a.png', 'image/png', BIN)).toEqual({ kind: 'image' })
    expect(classifyAttachment('IMG_1.HEIC', '', BIN)).toEqual({ kind: 'image' })
    expect(classifyAttachment('spec.pdf', 'application/pdf', PDF)).toEqual({ kind: 'pdf' })
    expect(classifyAttachment('fake.pdf', 'application/pdf', enc('hello'))).toEqual({ refused: 'binary' })
    expect(classifyAttachment('nb.ipynb', '', enc('{"cells": []}'))).toEqual({ kind: 'notebook' })
    expect(classifyAttachment('icon.svg', 'image/svg+xml', enc('<svg/>'))).toEqual({ kind: 'text' })
    // Any extension, or none, when the content is text.
    expect(classifyAttachment('main.zig', '', enc('pub fn main() void {}'))).toEqual({ kind: 'text' })
    expect(classifyAttachment('Makefile', '', enc('all:\n\techo'))).toEqual({ kind: 'text' })
    expect(classifyAttachment('data.weird', '', BIN)).toEqual({ refused: 'binary' })
  })

  it('refuses archives, media, office documents and programs by name', () => {
    expect(classifyAttachment('src.zip', '', enc('PK'))).toEqual({ refused: 'archive' })
    expect(classifyAttachment('src.tar.gz', '', BIN)).toEqual({ refused: 'archive' })
    expect(classifyAttachment('demo.mov', '', BIN)).toEqual({ refused: 'video' })
    expect(classifyAttachment('clip', 'video/mp4', BIN)).toEqual({ refused: 'video' })
    expect(classifyAttachment('memo.m4a', '', BIN)).toEqual({ refused: 'audio' })
    expect(classifyAttachment('plan.docx', '', BIN)).toEqual({ refused: 'office' })
    expect(classifyAttachment('tool.exe', '', BIN)).toEqual({ refused: 'executable' })
  })
})

describe('accepted per agent kind', () => {
  it('lets only Claude Code read PDFs', () => {
    expect(agentReads('claude', 'pdf')).toBe(true)
    expect(agentReads('codex', 'pdf')).toBe(false)
    expect(agentReads('omp', 'pdf')).toBe(false)
    for (const agent of ['claude', 'codex', 'omp']) {
      expect(agentReads(agent, 'text')).toBe(true)
      expect(agentReads(agent, 'notebook')).toBe(true)
      expect(agentReads(agent, 'image')).toBe(true)
    }
  })

  it('checks kind, agent and size together', () => {
    const pdf = { name: 'spec.pdf', type: 'application/pdf', size: 1000 }
    expect(checkAttachment('claude', pdf, PDF)).toEqual({ ok: true, kind: 'pdf' })
    expect(checkAttachment('codex', pdf, PDF)).toEqual({ ok: false, reason: 'pdf', kind: 'pdf' })
    expect(checkAttachment('claude', { ...pdf, size: ATTACH_LIMITS.pdf + 1 }, PDF)).toEqual({ ok: false, reason: 'too_large', kind: 'pdf' })
    expect(checkAttachment('claude', { ...pdf, size: ATTACH_LIMITS.pdf }, PDF).ok).toBe(true)
    const txt = { name: 'log.txt', type: 'text/plain', size: ATTACH_LIMITS.text + 1 }
    expect(checkAttachment('codex', txt, enc('x'))).toEqual({ ok: false, reason: 'too_large', kind: 'text' })
    expect(checkAttachment('codex', { ...txt, size: 0 }, enc(''))).toEqual({ ok: false, reason: 'empty' })
    expect(checkAttachment('codex', { name: 'a.zip', type: '', size: 10 }, enc('PK'))).toEqual({ ok: false, reason: 'archive' })
  })
})

describe('stored names', () => {
  it('keeps a safe, readable base name', () => {
    expect(safeAttachmentName('Rapport final (v2).pdf')).toBe('Rapport_final_v2.pdf')
    expect(safeAttachmentName('Report.PDF')).toBe('Report.PDF')
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(safeAttachmentName('C:\\Users\\x\\notes.md')).toBe('notes.md')
    expect(safeAttachmentName('.env')).toBe('env')
    expect(safeAttachmentName('résumé.txt')).toBe('resume.txt')
    expect(safeAttachmentName('$(rm -rf ~);.sh')).toBe('rm_-rf.sh')
    expect(safeAttachmentName('')).toBe('file')
    expect(safeAttachmentName('...')).toBe('file')
    expect(safeAttachmentName('日本語.txt')).toBe('file.txt')
    expect(safeAttachmentName('archive.tar.gz')).toBe('archive.tar.gz')
    const long = safeAttachmentName(`${'a'.repeat(200)}.json`)
    expect(long.length).toBe(80)
    expect(long.endsWith('.json')).toBe(true)
  })

  it('prefixes date and random part, and strips them for display', () => {
    const n = storedAttachmentName('my notes.md', new Date('2026-10-02T10:20:30.456Z'), 'a1b2c3')
    expect(n).toBe('2026-10-02T10-20-30-456Z-a1b2c3-my_notes.md')
    expect(isStoredAttachmentName(n)).toBe(true)
    expect(attachmentDisplayName(n)).toBe('my_notes.md')
    expect(isStoredAttachmentName('../x')).toBe(false)
    expect(isStoredAttachmentName('2026-10-02T10-20-30-456Z-a1b2c3-..')).toBe(false)
    expect(isStoredAttachmentName('2026-10-02T10-20-30-456Z-a1b2c3-a/b')).toBe(false)
  })
})

describe('paths and references', () => {
  const stored = '2026-10-02T10-20-30-456Z-a1b2c3-spec.pdf'

  it('uses @ for text given to Claude, a plain path otherwise', () => {
    const p = '/home/dev/.cache/herdr-web/files/x-notes.md'
    expect(attachmentRef('claude', 'text', p)).toBe(`@${p}`)
    expect(attachmentRef('claude', 'notebook', p)).toBe(`@${p}`)
    expect(attachmentRef('claude', 'pdf', p)).toBe(p)
    expect(attachmentRef('codex', 'text', p)).toBe(p)
  })

  it('recognizes a message line that is only an attached file', () => {
    const p = `/Users/dev/.cache/herdr-web/files/${stored}`
    expect(parseAttachmentLine(p)).toEqual({ path: p, name: 'spec.pdf' })
    expect(parseAttachmentLine(` @${p} `)).toEqual({ path: p, name: 'spec.pdf' })
    expect(parseAttachmentLine(`see ${p}`)).toBeNull()
    expect(parseAttachmentLine('/home/dev/.cache/herdr-web/uploads/a.jpg')).toBeNull()
  })

  it('picks an icon by type', () => {
    expect(attachmentIcon('a.pdf')).toBe('i-lucide-file-text')
    expect(attachmentIcon('a.ipynb')).toBe('i-lucide-notebook-pen')
    expect(attachmentIcon('a.json')).toBe('i-lucide-file-json')
    expect(attachmentIcon('a.ts')).toBe('i-lucide-file-code')
    expect(attachmentIcon('README.md')).toBe('i-lucide-file-type')
  })
})

describe('cancelled message back into the draft', () => {
  it('gives the attached files back as chips', async () => {
    const { restoreDraft } = await import('../app/utils/queuedCancel')
    const p = '/home/dev/.cache/herdr-web/files/2026-10-02T10-20-30-456Z-a1b2c3-notes.md'
    const d = { text: '', atts: [], reply: null } as Parameters<typeof restoreDraft>[0]
    restoreDraft(d, `Look at this\n@${p}`)
    expect(d.text).toBe('Look at this')
    expect(d.atts).toEqual([{ url: '', path: p, name: p.split('/').pop(), file: { label: 'notes.md', size: 0, kind: 'text' }, ref: `@${p}` }])
  })
})

describe('message ending with an @ reference', () => {
  it('gets a trailing space so Enter sends it', () => {
    expect(closeTrailingMention('Read this\n@/home/dev/.cache/herdr-web/files/x-a.md')).toBe('Read this\n@/home/dev/.cache/herdr-web/files/x-a.md ')
    expect(closeTrailingMention('@/home/dev/.cache/herdr-web/files/x-a.md')).toBe('@/home/dev/.cache/herdr-web/files/x-a.md ')
    expect(closeTrailingMention('@/a.md\n/home/dev/.cache/herdr-web/files/x-b.pdf')).toBe('@/a.md\n/home/dev/.cache/herdr-web/files/x-b.pdf')
    expect(closeTrailingMention('ping @alice')).toBe('ping @alice')
    expect(closeTrailingMention('hello')).toBe('hello')
  })
})
