// Native recognizers own presentation; the live quota footer also rules out
// a choice list misread from scrollback above Claude's still-visible input.
import type { Choices } from './types'
import { parseUsageLimit } from './usageLimit'
import { hasTranscript } from './agentKind'

export type ScreenInteraction = 'input' | 'native' | 'terminal' | 'working' | 'unknown' | 'managed'

// Deliberately short exception list: these screens are either unrecognized or
// misread as choices by the existing recognizers. Do not generalize this into
// stricter rules for native questions (descriptions, tabs and checkboxes work).
export function terminalException(text: string): boolean {
  // Match the active menu through its final legend. A title or a full old menu
  // quoted above a newer approval must not override that native approval.
  const lines = text.trimEnd().split('\n')
  const at = lines.findLastIndex(l => /^\s*(?:Agent Command Center|Usage)\s*$/.test(l))
  if (at < 0) return false
  const body = lines.slice(at + 1).filter(l => l.trim())
  // Current Codex includes a subtitle before the two-column entries.
  if (lines[at]!.trim() === 'Usage' && body[0]?.trim() === 'Account usage and resets.') body.shift()
  const legend = body.pop()?.trim()
  if (lines[at]!.trim() === 'Agent Command Center') {
    return legend === 'Use arrows to navigate, Enter to open, Escape to return.'
      && body.some(l => /^\s*›\s+\S/.test(l))
      && body.every(l => /^(?:›\s+)?\S.* {2,}\S/.test(l.trim()))
  }
  return legend === 'enter open · esc back' && body.length === 2
    && /^[ \t›]*1\. View analytics {2,}Usage history[ \t]*$/.test(body[0]!)
    && /^[ \t›]*2\. Redeem reset {2,}Check availability[ \t]*$/.test(body[1]!)
}

// Shared by classification and the last-moment native-answer validation.
export function usesTerminalException(o: { text: string, agent?: string | null, status?: string | null }): boolean {
  return o.agent === 'codex' && o.status !== 'unknown' && o.status !== 'working' && terminalException(o.text)
}

// Search the full field, including long drafts and wrapped status bars. Native
// recognition runs first, so a recognized menu cursor never becomes a field.
export function confirmedInput(text: string): boolean {
  const lines = text.trimEnd().split('\n')
  // Devin's prompt glyph is ❭ (U+276D), not the Claude ❯ (U+276F): without it
  // every ready Devin screen fell through to the terminal fallback.
  const at = lines.findLastIndex(l => /^\s*[❯›❭](?:\s|$)/.test(l) || /^!(?:\s|$)/.test(l) || /^╰─(?:\s|$)/.test(l))
  if (at < 0) return false
  const line = lines[at]!
  const below = lines.slice(at + 1).join('\n')
  if (/\b(?:enter|esc|escape)\s+(?:to\s+)?(?:select|open|back|cancel|confirm|close)\b/i.test(below)) return false
  if (/^\s*[❯›❭]\s+\d{1,2}\.\s/.test(line)) return false
  if (/^╰─(?:\s|$)/.test(line)) return true
  if (/^\s*›(?:\s|$)/.test(line)) return /for shortcuts|context left|\b(?:gpt-[\w.-]+|o[1-9](?:-[\w.-]+)?)\b.*·/i.test(below)
  return /^\s*─{3,}/.test(lines[at - 1] || '')
}

export function classifyScreen(o: {
  text: string, agent?: string | null, choices?: Choices | null,
  menu?: unknown, screen?: unknown, settings?: boolean, status?: string | null,
}): ScreenInteraction {
  if (o.status === 'working') return 'working'
  // Only the two active Codex menus override a mistaken list recognition.
  // A completed/closed agent may retain its kind while showing a shell.
  if (usesTerminalException(o)) return 'terminal'
  // The live input and quota footer distinguish this wait from old reply lists.
  if (o.status !== 'unknown' && parseUsageLimit(o.text, o.agent)) return 'native'
  if (o.choices || o.menu || o.screen || o.settings) return 'native'
  // Unsupported agents already have their permanent Terminal view. An absent
  // transcript/input recognizer is not evidence of an interactive screen.
  if (o.status === 'unknown' || !hasTranscript(o.agent) || !o.text.trim()) return 'unknown'
  if (confirmedInput(o.text)) return 'input'
  return 'terminal'
}
