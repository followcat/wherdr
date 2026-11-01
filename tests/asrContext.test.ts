import { describe, expect, it } from 'vitest'
import { buildAsrContext } from '../app/utils/asrContext'

describe('buildAsrContext', () => {
  it('is empty without any input', () => {
    expect(buildAsrContext({})).toBe('')
    expect(buildAsrContext({ draft: '' })).toBe('')
  })

  it('leads with pane identity terms', () => {
    const ctx = buildAsrContext({ agent: 'devin', machine: 'fvps', name: 'wherdr-mobile' })
    expect(ctx).toBe('devin, fvps, wherdr-mobile')
  })

  it('harvests technical tokens from the draft', () => {
    const ctx = buildAsrContext({ draft: 'check terminalTouch in Composer.vue and restart wherdr.service' })
    expect(ctx).toContain('terminalTouch')
    expect(ctx).toContain('Composer.vue')
    expect(ctx).toContain('wherdr.service')
  })

  it('drops common english words and short tokens', () => {
    expect(buildAsrContext({ draft: 'can you check the thing and fix it up for me' })).toBe('')
  })

  it('uses cwd tail segments only', () => {
    const ctx = buildAsrContext({ cwd: '~/AIcontrol/phone/wherdr' })
    expect(ctx).toContain('phone')
    expect(ctx).toContain('wherdr')
    expect(ctx).not.toContain('AIcontrol') // tail two only
  })

  it('keeps non-ASCII pane names via identity fields', () => {
    const ctx = buildAsrContext({ name: 'Réunion-Équipe', machine: 'böx' })
    expect(ctx).toContain('Réunion-Équipe')
    expect(ctx).toContain('böx')
  })

  it('dedupes case-insensitively keeping first surface form', () => {
    const ctx = buildAsrContext({ name: 'WherDr', draft: 'wherdr WHERDR' })
    expect((ctx.match(/wherdr/gi) || []).length).toBe(1)
  })

  it('weights draft terms over transcript ones', () => {
    const ctx = buildAsrContext({
      draft: 'scrollback bug',
      recent: ['zzzzZebra'],
    })
    // draft weight (3) beats transcript weight (1)
    expect(ctx.indexOf('scrollback')).toBeLessThan(ctx.indexOf('zzzzZebra'))
  })

  it('harvests attachment file names', () => {
    const ctx = buildAsrContext({ files: ['prompt_config.json', '/tmp/asr-worker.js'] })
    expect(ctx).toContain('prompt_config.json')
    expect(ctx).toContain('asr-worker.js')
  })

  it('caps at 30 terms', () => {
    const draft = Array.from({ length: 60 }, (_, i) => `TechWord${i}xx`).join(' ')
    const ctx = buildAsrContext({ draft })
    expect(ctx.split(', ').length).toBe(30)
  })

  it('strips punctuation edges off tokens', () => {
    const ctx = buildAsrContext({ draft: 'edit ./asrContext.ts, then run.' })
    expect(ctx).toContain('asrContext.ts')
    expect(ctx).not.toMatch(/,\./)
  })
})
