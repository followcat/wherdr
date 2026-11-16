import { describe, expect, it } from 'vitest'
import { decisionRef, messageRef, pointRef, refLine, parseRef, refSegments, refsIn, taskRef, unreference } from '../shared/reference'
import { addAnswer, addQuote, answerOf, removeQuote } from '../app/utils/questionReply'
import { messageBody } from '../shared/pastedText'
import { restoreDraft } from '../app/utils/queuedCancel'

const samples = [
  'The cache — server side — is ready : continue?',
  '↳ nested arrow : "quoted" « words » — ✅',
  'هل ننشر الإصدار؟ مرحبا',
  'Keep `cache_key` as is?',
  'First line\nSecond line',
  '🔧'.repeat(250),
  'Prefix ' + 'long explanation '.repeat(120) + 'suffix',
]
const factories = {
  message: (s: string) => messageRef(s, '11:37', 'k3f'),
  point: (s: string) => pointRef(s, '11:37'),
  decision: (s: string) => decisionRef('3', s, '11:37', false, 'k3f2'),
  decisions: (s: string) => decisionRef('1-2,4', s, '11:37', true),
  task: (s: string) => taskRef('Problem:', s),
}

// Every type of reference against awkward excerpts, with and without a code.
describe('reference round trip matrix', () => {
  for (const [kind, factory] of Object.entries(factories)) {
    for (const [i, sample] of samples.entries()) {
      it(`${kind}: round trips sample ${i + 1} through draft, outgoing text and segments`, () => {
        const ref = factory(sample)
        expect(parseRef(refLine(ref))).toEqual(ref)
        const draft = addAnswer('', ref, 'Yes — keep it : ✅')!
        const sent = messageBody(draft, [], [])
        expect(refSegments(sent)).toEqual([{ kind: 'ref', ref }, { kind: 'text', text: 'Yes — keep it : ✅' }])
        expect(answerOf(sent, ref)).toBe('Yes — keep it : ✅')
      })
    }
    it(`${kind}: keeps an unanswered reference and removes only its line`, () => {
      const ref = factory('Keep it?')
      const draft = addQuote('', ref)!
      expect(answerOf(draft, ref)).toBe('')
      const answered = `${draft}Free answer`
      expect(removeQuote(answered, refsIn(answered)[0]!)).toBe('Free answer')
    })
    it(`${kind}: handles an empty excerpt without an invalid marker`, () => {
      const line = refLine(factory(''))
      expect(line === '' || parseRef(line) !== null).toBe(true)
    })
  }
  it('migrates the old whole-message queue marker, retaining the body', () => {
    const draft = { text: '', atts: [] }
    restoreDraft(draft, '↳ Replying to your message from 11:37 ("Keep the cache?")\n\nYes')
    expect(draft.text).toBe('↳ Quote message 11:37 : Keep the cache? —\nYes')
  })
  it('keeps old quoted queue entries readable and editable', () => {
    const draft = { text: '', atts: [] }
    restoreDraft(draft, '> Keep the cache?\nYes')
    expect(draft.text).toBe('> Keep the cache?\nYes')
    expect(refSegments(messageBody(draft.text, [], []))[0]).toEqual({ kind: 'quote', text: 'Keep the cache?' })
  })
  it('preserves lookalikes outside the recognized syntax', () => {
    for (const s of ['↳ note —', '↳ Quote point 11:37 : words — answer', '> manually typed', ' ↳ Quote point 11:37 : words —', '\\↳ Quote point 11:37 : words —']) {
      expect(refsIn(s)).toEqual([])
      expect(unreference(s)).toBe(s)
    }
  })
})
