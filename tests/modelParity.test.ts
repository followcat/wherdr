// Parity with wherdr v2 (branch mobile): the same fixtures go through the v3
// port, and every output must equal what v2's own parsers returned, recorded
// once (read-only) into fixtures/modelParity.golden.json. A drift in either
// worktree's parser — or in this port — fails here instead of at an agent.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ompSelectorOnScreen } from '../shared/ompSelector'
import {
  claudeScreenEffort, claudeScreenModel, codexFooterModel, ompScreenEffort, ompScreenModel,
  parseClaudeEffortScreen, parseClaudeEffortSlider,
} from '../server/utils/models'
import { ompSelectorCaption, parseModelMenu, parseOmpSelector, switchConfirmKeys } from '../server/utils/modelMenus'
import {
  devinMenuOpen, devinModelSetEcho, devinStatusModel, devinStatusPair, parseDevinFusion, parseDevinModelMenu,
} from '../server/utils/devinMenu'
import golden from './fixtures/modelParity.golden.json'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const norm = (v: unknown) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)))

// call-key -> the v3 port of the v2 parser, and the extra args the golden run used.
const CALLS: Record<string, { fn: (text: string, ...args: never[]) => unknown, args: unknown[] }> = {
  'parseModelMenu': { fn: parseModelMenu, args: [] },
  'parseOmpSelector': { fn: parseOmpSelector, args: [] },
  'ompSelectorOnScreen': { fn: ompSelectorOnScreen, args: [] },
  'parseDevinModelMenu': { fn: parseDevinModelMenu, args: [] },
  'devinMenuOpen': { fn: devinMenuOpen, args: [] },
  'parseDevinFusion': { fn: parseDevinFusion, args: [] },
  'devinStatusModel': { fn: devinStatusModel, args: [] },
  'devinStatusPair': { fn: devinStatusPair, args: [] },
  'devinModelSetEcho': { fn: devinModelSetEcho, args: [] },
  'claudeScreenModel': { fn: claudeScreenModel, args: [] },
  'claudeScreenEffort': { fn: claudeScreenEffort, args: [] },
  'codexFooterModel': { fn: codexFooterModel, args: [] },
  'parseClaudeEffortScreen': { fn: parseClaudeEffortScreen, args: [] },
  'parseClaudeEffortSlider': { fn: parseClaudeEffortSlider, args: [] },
  'ompScreenModel': { fn: ompScreenModel, args: [] },
  'ompScreenEffort|null': { fn: ompScreenEffort, args: [null] },
  'ompScreenEffort|Claude Sonnet 4.5': { fn: ompScreenEffort, args: ['Claude Sonnet 4.5'] },
  'switchConfirmKeys|Sonnet 4.6': { fn: switchConfirmKeys, args: ['Sonnet 4.6'] },
  'switchConfirmKeys|Opus 5.5': { fn: switchConfirmKeys, args: ['Opus 5.5'] },
  'ompSelectorCaption|anthropic/claude-opus-5-5': { fn: ompSelectorCaption, args: ['anthropic/claude-opus-5-5'] },
  'ompSelectorCaption|anthropic/claude-sonnet-4-5': { fn: ompSelectorCaption, args: ['anthropic/claude-sonnet-4-5'] },
  'ompSelectorCaption|openrouter/z-ai/glm-5.3-flash': { fn: ompSelectorCaption, args: ['openrouter/z-ai/glm-5.3-flash'] },
}

describe('v2 parity: identical output on the same screens', () => {
  for (const [fixture, row] of Object.entries(golden.cases)) {
    describe(fixture, () => {
      for (const [key, expected] of Object.entries(row)) {
        it(key, () => {
          const call = CALLS[key]
          if (!call) throw new Error(`golden key ${key} has no v3 parser mapping`)
          expect(norm(call.fn(fx(fixture), ...(call.args as never[])))).toEqual(expected)
        })
      }
    })
  }
})
