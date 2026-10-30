<script setup lang="ts">
// Input bar (UChatPrompt): on touch, one row at rest; while editing, the
// model toolbar moves below the full-width field. Working and empty: "Stop" (Escape),
// via UChatPromptSubmit ("streaming" state).
// Photos shrunk in the browser (2048 px, JPEG) then stored on the server;
// their path goes with the message. Other files the agent can read (PDF,
// text, code, notebooks) are stored on its machine as they are (/api/attach).
import type { Pane, QueuedMessage, SlashCommand } from '#shared/types'
import type { DraftAtt } from '~/composables/useDraft'
import { unreference } from '#shared/reference'
import { quotesIn, removeQuote } from '~/utils/questionReply'
import { attachQuoteMirror } from '~/utils/quoteMirror'
import { isAgentCommand } from '#shared/commandScreen'
import { isSlashCommand } from '#shared/queuedMatch'
import { viaPrompt } from '#shared/sendRoute'
import type { AttachKind } from '#shared/attachments'
import { refusalText, sortForAgent } from '~/utils/fileDrop'
import { uploadPhoto } from '~/utils/photoUpload'
import { lostPhotosText, restoreDraft } from '~/utils/queuedCancel'
import { isLongPaste, messageBody } from '#shared/pastedText'
import { rememberPastes } from '~/utils/sentPastes'
import { enterSends as enterSendsFor } from '~/utils/layoutMode'
import { kbOpen } from '~/composables/useViewport'
import { PromptHistory, historyDirection } from '~/utils/promptHistory'
import { createTouchTap } from '~/utils/touchTap'
import { tracePaste } from '~/utils/pasteJournal'
import { pasteHtmlText } from '~/utils/pasteHtml'

// `escStops`: Escape is free for Stop (the conversation search, which closes on it, is shut).
// `termShown`: the terminal is on screen, so no notice offers to open it.
// `takeBack`: conversation view; a prompt Claude puts back into its field on Stop
// comes back here instead (never in the terminal view, where the user sees Claude's field).
const props = defineProps<{ pane: Pane | undefined, paneId: string, sendKeys: (keys: string[]) => Promise<void>, conversation?: boolean, escStops?: boolean, takeBack?: boolean, unanswered?: number, termShown?: boolean }>()
const emit = defineEmits<{ sent: [queued: QueuedMessage | null], showTerminal: [], showUnanswered: [] }>()

// Claude Code update installed: the status line restarts the agent.
// Claude Code error status ("Auto-update failed…"): in red, like in the terminal.
// Text left in Codex's field (pane.codexField): it would be sent glued before
// the next message. Clear: Ctrl+U and Backspace, line by line (a field of a
// few lines; harmless on an empty field), only offered while Codex rests.
const codexFieldHint = computed(() => tl('Text typed in Codex’s terminal, or arrived there by mistake: your next message would be sent after it.', 'Texte tapé dans le terminal de Codex, ou arrivé là par erreur : ton prochain message serait envoyé à sa suite.'))
const clearingField = ref(false)
async function clearCodexField() {
  clearingField.value = true
  try { await props.sendKeys(Array.from({ length: 10 }, () => ['ctrl+u', 'backspace']).flat()) }
  finally { clearingField.value = false }
}
const noticeIsError = computed(() => /\b(failed|error)\b/i.test(props.pane?.claudeNotice || ''))
const updateReady = computed(() => Boolean(props.pane?.claudeNotice && /Restart to update/i.test(props.pane.claudeNotice) && canRestart(props.pane)))
const restartLabel = computed(() => {
  const r = props.pane?.restart
  if (!r) return ''
  const who = kindLabel(r.agent)
  // Codex update in its terminal: one more step between the stop and the relaunch.
  if (r.update && r.phase === 'stopping') return tl(`Exiting ${who}…`, `Fermeture de ${who}…`)
  if (r.phase === 'updating') return tl(`Updating ${who} in its terminal…`, `Mise à jour de ${who} dans son terminal…`)
  return r.phase === 'stopping' ? tl(`Stopping ${who}…`, `Arrêt de ${who}…`) : tl(`Restarting ${who} on the same conversation…`, `Relance de ${who} sur la même conversation…`)
})
async function copyUpdate() {
  const c = props.pane?.restart?.update
  if (!c) return
  try {
    await navigator.clipboard.writeText(c)
    toast(tl('Command copied: paste it into the terminal of this pane.', 'Commande copiée : colle-la dans le terminal de ce panneau.'))
  } catch { toast(t('Copy failed'), true) }
}

// Conversation draft (text + photos), kept when switching conversations.
const draft = useDraft(props.paneId)
const text = toRef(draft, 'text')
const promptRef = ref<{ textareaRef?: HTMLTextAreaElement } | null>(null)
const ta = computed(() => promptRef.value?.textareaRef || null)
const fieldFocused = ref(false)
// Android can dismiss the keyboard while leaving the textarea focused.
watch(kbOpen, open => { if (!open) fieldFocused.value = false })
const fileInput = ref<HTMLInputElement | null>(null)
const anyFileInput = ref<HTMLInputElement | null>(null)
const sending = ref(false)
// On a touch keyboard, Enter adds a line; the button below the field sends.
// An iPad with a proven hardware keyboard (utils/layoutMode.ts): Enter sends.
const enterSends = computed(() => enterSendsFor({ desk: desk.value, touch: Boolean(isIOS || touchKeyboard), tablet: tablet.value, hardwareKeyboard: hardwareKeyboard.value, softKeyboard: kbOpen.value }))

type Att = DraftAtt
const attachments = toRef(draft, 'atts')
const expanded = computed(() => fieldFocused.value || kbOpen.value || text.value.length > 0 || attachments.value.length > 0)
// What the text refers to ("↳ … —" lines, see shared/reference.ts): one chip
// each above the field, to remove it.
const quotes = computed(() => quotesIn(text.value))
// "native" mode (Settings › Conversation, utils/quoteTokens.ts): the
// reference lines of the field drawn as tokens by a mirror behind it, while
// the text holds one.
let mirror: ReturnType<typeof attachQuoteMirror> | null = null
watch([() => quoteMode.value === 'native' && quotes.value.length > 0, ta], ([on, el]) => {
  if (mirror && (!on || !el)) { mirror.destroy(); mirror = null }
  if (on && el && !mirror) mirror = attachQuoteMirror(el)
}, { immediate: true, flush: 'post' })
// Text set from script (a quote added, a send): no input event, redraw once rendered.
watch(text, () => nextTick(() => mirror?.render()), { flush: 'post' })
onBeforeUnmount(() => { mirror?.destroy(); mirror = null })

const canSend = computed(() => Boolean(text.value.trim() || attachments.value.length))
const readOnly = computed(() => Boolean(props.pane?.stopped || props.pane?.prompt?.unavailable) || !eventsOpen.value || offlineView.value || paneStale(props.pane))
// Offline, no Stop: UChatPromptSubmit ignores `disabled` in "streaming" mode.
// omp running the user's "!" / "$" command stays idle: Stop cancels the command.
const shellRun = computed(() => Boolean(props.pane && props.pane.agent === 'omp' && props.pane.ompShell && props.pane.status !== 'working'))
const stopMode = computed(() => Boolean(!readOnly.value && props.pane && props.pane.agent && (props.pane.status === 'working' || shellRun.value) && !canSend.value))
// Claude Code's grayed-out suggestion (see parseClaudeSuggestion): placeholder of the
// empty field; Tab puts it in the field, without sending it. A touch screen has no Tab:
// a "Use" button inside the field, on the right, does the same (`suggestTap`).
const suggestion = computed(() => (!readOnly.value && !canSend.value && props.pane?.claudeSuggestion) || null)
const suggestTap = computed(() => Boolean(suggestion.value && !enterSends.value))
function useSuggestion() {
  const s = suggestion.value
  if (!s) return
  text.value = s
  focusEnd()
}
// The field's text stops before the button, whatever the language's label.
const suggestBtn = ref<HTMLButtonElement | null>(null)
const suggestRoom = ref(0)
watch(suggestTap, () => nextTick(() => { suggestRoom.value = suggestBtn.value ? suggestBtn.value.offsetWidth + 16 : 0 }), { immediate: true })
// The button keeps the keyboard as it is: up, the caret goes to the end of the text;
// down, it stays down (a tap on the field opens it to edit).
function tapSuggestion() {
  const s = suggestion.value
  if (!s) return
  const typing = Boolean(ta.value && document.activeElement === ta.value)
  text.value = s
  if (typing) focusEnd()
}
const placeholder = computed(() => {
  const p = props.pane
  if (!p) return t('Message to agent…')
  if (p.status === 'blocked') return t('Type a reply…')
  if (suggestion.value) return suggestion.value
  if (p.agent) return tl(`Message to ${kindLabel(p.agent)}…`, `Message à ${kindLabel(p.agent)}…`)
  return t('Command…')
})

// Enter: UChatPrompt only sends text; a photo alone, or an empty field
// while the agent is working (Stop), go through here.
function onKeydown(e: KeyboardEvent) {
  if (slashOpen.value && !e.isComposing) {
    const n = slashMatches.value.length
    if (e.key === 'ArrowDown') { e.preventDefault(); lastPointer = 'kb'; slashSel.value = (slashSel.value + 1) % n; return }
    if (e.key === 'ArrowUp') { e.preventDefault(); lastPointer = 'kb'; slashSel.value = (slashSel.value - 1 + n) % n; return }
    if (e.key === 'Escape') { e.preventDefault(); slashDismissed.value = true; return }
    if (e.key === 'Tab' || (enterSends.value && e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault()
      e.stopPropagation()
      pickSlash(slashMatches.value[slashSel.value] || slashMatches.value[0]!)
      return
    }
  }
  if (e.key === 'Tab' && !e.shiftKey && !e.isComposing && suggestion.value && !text.value) {
    e.preventDefault()
    useSuggestion()
    return
  }
  if (enterSends.value && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !text.value.trim()) {
    e.preventDefault()
    submit()
  }
}
// Bubble on window, after useCardKeys on document: the active card owns
// arrows in an empty field. Slash suggestions are handled above at the field.
const history = new PromptHistory()
function onHistoryKey(e: KeyboardEvent) {
  const el = ta.value
  if (!el || e.target !== el || slashOpen.value || sending.value) return
  const current = { text: el.value, start: el.selectionStart, end: el.selectionEnd }
  const direction = historyDirection(e, current)
  if (direction === null) return
  const recalled = history.move(direction, current, promptHistoryFor(props.paneId))
  if (!recalled) return
  e.preventDefault()
  text.value = recalled.text
  // A recalled command should be browsable with the next arrow too.
  slashDismissed.value = true
  nextTick(() => {
    slashDismissed.value = true
    el.setSelectionRange(recalled.start, recalled.end)
  })
}
onMounted(() => window.addEventListener('keydown', onHistoryKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onHistoryKey)
  // Leaving the pane while browsing must keep the original unsent draft.
  if (history.draft) text.value = history.draft.text
})
function rememberSent(typed: string) {
  rememberPrompt(props.paneId, typed)
  history.reset()
}
// The button handles Send and Stop itself (one click = one action, without
// going back through the form). In Stop mode ("streaming" status),
// UChatPromptSubmit replaces our @click with its "stop" event:
// @stop is what triggers the interruption.
function onSubmitClick(e: MouseEvent) {
  e.preventDefault()
  submit()
}
// "streaming" status (Stop) ignores :disabled, as UChatPromptSubmit does.
const sendDisabled = computed(() => readOnly.value || (!canSend.value && !stopMode.value) || sending.value || interrupting.value === 'running')
// A touch acts on its own, without the browser's click: on an iPhone with the
// keyboard open, a tap that drifts a pixel becomes a pan and the click never
// comes (utils/touchTap.ts). The field keeps the focus, the keyboard stays up.
const sendPressed = ref(false)
const sendTap = createTouchTap({
  enabled: () => stopMode.value || !sendDisabled.value,
  run: () => { if (stopMode.value) interrupt(); else submit() },
  press: (on) => { sendPressed.value = on },
})
const hint = computed(() => desk.value && !stopMode.value)

async function submit() {
  if (readOnly.value) return toast(t('Sending unavailable offline'), true)
  if (stopMode.value) return interrupt()
  if (attachments.value.some(a => !a.paste && !a.path)) return toast(t(attachments.value.some(a => !a.path && a.file) ? 'File is uploading…' : 'Photo is uploading…'))
  // Photos and files go as file paths (`@<path>` for a text file given to
  // Claude): Claude Code and Codex open them themselves. Pasted texts go as
  // they are, after the typed text (the agent gets one message, as from a paste).
  const pastes = attachments.value.flatMap(a => (a.paste ? [a.paste] : []))
  const paths = attachments.value.flatMap(a => (a.paste ? [] : [a.ref || a.path!]))
  const typed = text.value
  const body = messageBody(typed, pastes, paths)
  const msg = body
  if (!msg || sending.value) return
  const p = props.pane
  // omp question with "Other": the message is its free answer.
  const prompt = p && p.status === 'blocked' ? p.prompt : null
  const free = prompt ? prompt.options.findIndex(o => o.free) : -1
  // A message for the agent: its bubble at once, the field emptied, the send
  // after any earlier one still going (see composables/useOutbox.ts). Failed:
  // the bubble says "Not sent" with Retry / Cancel, nothing is lost.
  if (free < 0 && viaPrompt(p) && !isSlashCommand(msg)) {
    rememberSent(typed)
    text.value = ''
    clearAttachments()
    rememberPastes(pastes)
    haptic()
    emit('sent', null)
    outboxSend(p, props.paneId, msg).then(() => emit('sent', null), (err: Error) => toast(err.message, true))
    return
  }
  sending.value = true
  // Before the send: it tells the server where they sit (see sendMessage).
  rememberPastes(pastes)
  try {
    let queued: QueuedMessage | null = null
    if (prompt && free >= 0) {
      if (!(await choose(props.paneId, free, prompt.options[free]!.label, prompt.identity, { text: msg, question: prompt.question }))) return
    } else queued = await sendMessage(p, props.paneId, msg)
    rememberSent(typed)
    text.value = ''
    clearAttachments()
    haptic()
    emit('sent', queued)
    // "/" command: its result (terminal screen), as from the + menu.
    // A skill or custom command makes the agent reply: no panel.
    const cmd = msg.split(/\s/)[0]!
    const listed = slashCache.get(props.paneId)?.list || slashList.value
    if (free < 0 && p && p.agent && !paths.length && /^\/\S+$/.test(cmd) && !msg.includes('\n') && !isAgentCommand(cmd, listed)) {
      showCommandResult(props.paneId, cmd, listed.some(c => c.source === 'builtin' && `/${c.name}` === cmd))
    }
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
    sending.value = false
  }
}

// ------------------------------------------------------------ Stop
// The server sends Escape, sends it again if the agent is still working, stops
// Claude's background tasks (see server/utils/interruptSeq.ts) then says whether the agent
// stopped. Otherwise: lasting message with access to the terminal.
const interrupting = ref<'running' | 'failed' | null>(null)
// What the last Stop targeted: the user's omp command, or the agent's turn.
const stoppingShell = ref(false)
async function interrupt() {
  if (interrupting.value === 'running') return
  haptic()
  interrupting.value = 'running'
  stoppingShell.value = shellRun.value
  try {
    const r = await api<{ stopped: boolean, background: number, shell?: boolean, restored?: string, lost?: number }>('/api/interrupt', { pane_id: props.paneId, restore: Boolean(props.takeBack) })
    interrupting.value = r.stopped ? null : 'failed'
    stoppingShell.value = Boolean(r.shell)
    if (r.shell) {
      if (r.stopped) toast(tl('Command cancelled', 'Commande annulée'))
      return
    }
    // Stopped before any reply: like Claude, the message comes back into the field.
    if (r.restored !== undefined) {
      restoreDraft(draft, r.restored)
      focusEnd()
      const back = tl('Stopped: your message is back in the field', 'Arrêté : ton message est revenu dans le champ')
      if (r.lost) toast(back, true, lostPhotosText(r.lost))
      else toast(back)
    } else if (r.stopped) toast(r.background ? tl(`Agent stopped (${r.background} background task${r.background > 1 ? 's' : ''} stopped)`, `Agent arrêté (${r.background} tâche${r.background > 1 ? 's' : ''} de fond arrêtée${r.background > 1 ? 's' : ''})`) : t('Agent stopped'))
  } catch (err) {
    interrupting.value = null
    toast((err as Error).message, true)
  }
}
// The agent eventually stops (or the user acts in the terminal): the message goes away.
watch(() => props.pane?.status, s => { if (interrupting.value === 'failed' && !stoppingShell.value && s !== 'working') interrupting.value = null })
watch(shellRun, on => { if (interrupting.value === 'failed' && stoppingShell.value && !on) interrupting.value = null })
// Escape (composables/useShortcuts.ts): the Stop button, only while it is shown and
// clickable. The field blurs itself on Escape: it gets the focus back for what comes next.
function stop() {
  if (!props.escStops || !stopMode.value || sending.value || interrupting.value === 'running') return false
  interrupt()
  ta.value?.focus()
  return true
}

// ------------------------------------------------------------ photos
function clearAttachments() {
  for (const a of attachments.value) if (a.url) URL.revokeObjectURL(a.url)
  attachments.value = []
}
// Large preview (same viewer as the conversation), including while
// sending: the local URL (blob) is enough.
function viewAtt(a: Att) { lightboxSrc.value = a.url }
function removeAtt(i: number) {
  const [a] = attachments.value.splice(i, 1)
  if (a && a.url) URL.revokeObjectURL(a.url)
}
watch(() => attachments.value.length, () => nextTick(layout))
// Long text: keep the caret in view once the field reaches its max height.
watch(text, () => nextTick(() => {
  const el = ta.value
  if (!el || el.scrollHeight <= el.clientHeight || document.activeElement !== el) return
  if (el.selectionEnd >= el.value.length - 1) el.scrollTop = el.scrollHeight
}))

async function addImages(files: File[]) {
  for (const f of files) {
    const a = reactive<Att>({ url: URL.createObjectURL(f), path: null })
    attachments.value.push(a)
    try {
      const r = await uploadPhoto(props.paneId, f)
      a.path = r.path
      a.name = r.name
    } catch (err) {
      toast(`${t('Photo upload failed')} : ${(err as Error).message}`, true)
      attachments.value = attachments.value.filter(x => x !== a)
      URL.revokeObjectURL(a.url)
    }
  }
}
// Any file (drop, +, paste): images take the photo path, files the agent
// reads are attached, the others are refused with the reason.
async function addFiles(files: File[]) {
  const p = props.pane
  const { images, files: readable, refused } = await sortForAgent(files, p?.agent)
  if (refused.length) {
    const who = kindLabel(p?.agent)
    const names = refused.map(r => r.file.name).join(', ')
    const why = [...new Set(refused.map(r => refusalText(r.reason, who, r.kind)))]
    toast(tl(`Not attached: ${names}`, `Non joint : ${names}`), true, why.join(' · '))
  }
  if (images.length) addImages(images)
  for (const r of readable) uploadFile(r.file, r.kind)
  return images.length + readable.length
}
async function uploadFile(f: File, kind: AttachKind) {
  const a = reactive<Att>({ url: '', path: null, file: { label: f.name, size: f.size, kind } })
  attachments.value.push(a)
  try {
    const r = await fetch(`/api/attach?pane=${encodeURIComponent(props.paneId)}&name=${encodeURIComponent(f.name)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f,
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(t(d.error || `HTTP ${r.status}`))
    a.path = d.path
    a.name = d.name
    a.ref = d.ref
  } catch (err) {
    toast(`${f.name} : ${t('File upload failed')} — ${(err as Error).message}`, true)
    attachments.value = attachments.value.filter(x => x !== a)
  }
}
function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files || [])]
  input.value = ''
  addFiles(files)
}

// Paste an image: straight into the field (Mac, iPad, and iPhone when
// Safari offers it)…
function onPaste(e: ClipboardEvent) {
  handlePaste(e, e.clipboardData)
}
function onBeforeInput(e: InputEvent) {
  if (e.inputType === 'insertFromPaste') handlePaste(e, e.dataTransfer, e.data || '')
}
function handlePaste(e: Event, data: DataTransfer | null, fallback = '') {
  const el = e.target as HTMLTextAreaElement
  // Snapshot the event payload before returning control to a dictation tool.
  // Never read the system clipboard here: it may already have been restored.
  const raw = data?.getData('text/plain') || fallback
    || pasteHtmlText(data?.getData('text/html') || '')
  tracePaste(e, data, raw.length, el, () => attachments.value.length)
  // Some IME beforeinput events cannot be cancelled; let their native edit run.
  if (!e.cancelable) return
  const files = [...(data?.items || [])]
    .filter(i => i.kind === 'file')
    .map(i => i.getAsFile()).filter((f): f is File => Boolean(f))
  if (files.length) {
    e.preventDefault()
    addFiles(files)
    haptic()
    return
  }
  // Empty/absent event data: leave native beforeinput insertion available.
  if (!raw) return
  e.preventDefault()
  const s = raw.replace(/\r\n?/g, '\n')
  if (isLongPaste(s)) return addPaste(s)
  const plain = unreference(s)
  const before = el.value
  // Preserve the native undo stack where supported, with a synchronous fallback.
  const done = document.activeElement === el && typeof document.execCommand === 'function' && document.execCommand('insertText', false, plain)
  if (!done) {
    const from = el.selectionStart ?? before.length
    el.value = before.slice(0, from) + plain + before.slice(el.selectionEnd ?? from)
    el.setSelectionRange(from + plain.length, from + plain.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // Commit the draft in this tick too, before any reactive refresh.
  text.value = el.value
}
// A card is sent as it was pasted, to the character: nothing reads it as the
// user's words (it is not in the field, and shows as a card once sent).
function addPaste(s: string) {
  attachments.value.push({ url: '', path: null, paste: s })
  haptic()
}

// …or via the + menu, which reads the clipboard (Safari asks for a
// "Paste" confirmation).
async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) return toast(t('Clipboard unavailable here — paste into the message field.'), true)
  try {
    const found: File[] = []
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(x => x.startsWith('image/'))
      if (type) found.push(new File([await item.getType(type)], `presse-papiers.${type.split('/')[1]}`, { type }))
    }
    if (!found.length) return toast(t('No image in the clipboard'), true)
    addImages(found)
  } catch (err) {
    const e = err as Error
    toast(e.name === 'NotAllowedError' ? t('Paste denied') : `${t('Paste failed')} : ${e.message}`, true)
  }
}

// ------------------------------------------------------------ "/" commands
// "/" as the first character: the agent's commands, like the terminal's
// menu (built-in + the machine's skills and commands), filtered as you
// type. Tapping a command puts it in the field; Enter sends it.
// `denied`: macOS refused to list project folders, some commands are missing
// (`remote`: the pane's machine is reached over SSH).
interface SlashDenied { remote: boolean }
const slashCache = new Map<string, { at: number, list: SlashCommand[], denied: SlashDenied | null }>()
const slashList = ref<SlashCommand[]>([])
const slashDenied = ref<SlashDenied | null>(null)
const slashSel = ref(0)
const slashDismissed = ref(false)
const slashListEl = ref<HTMLElement | null>(null)
const slashQuery = computed(() => {
  const m = /^\/(\S*)$/.exec(text.value)
  return props.pane && props.pane.agent && m ? m[1]!.toLowerCase() : null
})
async function loadSlash() {
  const key = props.paneId
  const hit = slashCache.get(key)
  // The known list at once, asked again after a few seconds: a skill or
  // command added on the machine shows up without reloading the app.
  if (hit) {
    slashList.value = hit.list
    slashDenied.value = hit.denied
    if (Date.now() - hit.at < 15000) return
  }
  try {
    const r = await api<{ commands: SlashCommand[], partial?: boolean, denied?: 'macos', remote?: boolean }>(`/api/commands?pane=${encodeURIComponent(key)}`)
    // Built-in commands only (machine's skills unreadable): asked again on
    // the next "/", the last full list stays.
    if (r.partial && hit) return
    const denied = r.denied ? { remote: !!r.remote } : null
    if (!r.partial) slashCache.set(key, { at: Date.now(), list: r.commands, denied })
    if (key === props.paneId) {
      slashList.value = r.commands
      slashDenied.value = denied
    }
  } catch { /* no suggestions */ }
}
watch(slashQuery, (q, old) => {
  if (q === null) { slashDismissed.value = false; return }
  if (old === null || old === undefined) loadSlash()
  slashSel.value = 0
})
watch(() => props.paneId, () => {
  slashList.value = []
  slashDenied.value = null
})
const slashMatches = computed(() => {
  const q = slashQuery.value
  if (q === null) return []
  const starts: SlashCommand[] = []
  const inName: SlashCommand[] = []
  const inDesc: SlashCommand[] = []
  for (const c of slashList.value) {
    const n = c.name.toLowerCase()
    if (n.startsWith(q)) starts.push(c)
    else if (n.includes(q)) inName.push(c)
    else if (q.length > 1 && c.desc.toLowerCase().includes(q)) inDesc.push(c)
  }
  return [...starts, ...inName, ...inDesc]
})
// Nothing matches but macOS hid project commands: the menu says so.
const slashOpen = computed(() => slashQuery.value !== null && !slashDismissed.value && (slashMatches.value.length > 0 || !!slashDenied.value)
  && !(slashMatches.value.length === 1 && slashMatches.value[0]!.name.toLowerCase() === slashQuery.value))
// Hover: only if the mouse really moved. When the list scrolls with the
// keyboard under a still pointer, the browser also emits hovers, which
// would steal the selection.
let lastPointer = ''
function hoverSlash(e: MouseEvent, i: number) {
  const at = `${e.screenX},${e.screenY}`
  const kb = lastPointer === 'kb'
  if (at === lastPointer) return
  lastPointer = at
  // Right after an arrow: the first position seen is that of the still pointer.
  if (kb) return
  slashSel.value = i
}
function pickSlash(c: SlashCommand) {
  text.value = `/${c.name} `
  haptic()
  nextTick(() => ta.value?.focus())
}
watch(slashSel, i => nextTick(() => {
  const el = slashListEl.value?.children[i] as HTMLElement | undefined
  el?.scrollIntoView({ block: 'nearest' })
}))

// ------------------------------------------------------------ menu +
const SLASH: Record<string, [string, string][]> = {
  claude: [['/compact', 'Summarize context'], ['/clear', 'New conversation'], ['/context', 'Context usage'],
    ['/usage', 'Plan usage'], ['/model', 'Change model'], ['/review', 'Code review']],
  codex: [['/compact', 'Summarize context'], ['/new', 'New conversation'], ['/status', 'Session status'],
    ['/model', 'Change model'], ['/review', 'Code review'], ['/diff', 'View diff']],
  omp: [['/compact', 'Summarize context'], ['/new', 'New conversation'], ['/plan', 'Plan mode'],
    ['/model', 'Change model'], ['/fast', 'Priority service tier']],
}
// Images first, then interruption and the agent's commands.
function openPlus() {
  const p = props.pane
  if (!p) return
  const items: MenuItem[] = [
    { label: t('Photo or screenshot'), icon: 'i-lucide-image', run: () => fileInput.value?.click() },
    { label: p.agent === 'claude' ? t('File (PDF, text, code)') : t('File (text, code)'), icon: 'i-lucide-paperclip', run: () => anyFileInput.value?.click() },
    { label: t('Paste copied image'), icon: 'i-lucide-clipboard-paste', run: pasteFromClipboard },
  ]
  if (p.agent) {
    items.push({ kind: 'separator' })
    items.push({ kind: 'command', cmd: 'esc', desc: t('Interrupt agent'), run: () => props.sendKeys(['esc']) })
    for (const [cmd, desc] of SLASH[p.agent] || []) {
      items.push({ kind: 'command', cmd, desc: t(desc), run: () => runSlash(cmd) })
    }
    items.push({ kind: 'note', label: t('Commands that open a menu (model…) can then be controlled in the Terminal tab.') })
  }
  openMenu(items)
}
async function runSlash(cmd: string, result = true) {
  try {
    await api('/api/prompt', { pane_id: props.paneId, text: cmd })
    rememberPrompt(props.paneId, cmd)
    haptic()
  } catch (err) { return toast((err as Error).message, true) }
  if (result) showCommandResult(props.paneId, cmd)
}

// Focus, cursor at the end (text set from outside: "Problem" of the Project
// panel). The focus is given right away, within the gesture, so that the iPhone
// opens the keyboard; the cursor is placed once the text is rendered.
function focusEnd() {
  focusAt(null)
}
function focusAt(at: number | null) {
  ta.value?.focus()
  nextTick(() => {
    const el = ta.value
    if (!el) return
    el.focus()
    const pos = at === null ? el.value.length : Math.min(at, el.value.length)
    el.setSelectionRange(pos, pos)
    if (at === null) el.scrollTop = el.scrollHeight
  })
}
// A one-tap answer written in the field (ChatView's Yes / No / OK to all):
// the caret right after it, so that Enter sends it. Only where Enter sends: on
// a touch keyboard Enter adds a line, and the focus would only open the
// keyboard over the next question.
function focusAnswer(at: number) {
  if (enterSends.value) focusAt(at)
}

defineExpose({
  focus: () => ta.value?.focus(),
  focusEnd,
  focusAnswer,
  blur: () => ta.value?.blur(),
  addImages, addFiles, stop,
})
</script>

<template>
  <div class="composer" :data-agent="pane?.agent || undefined">
    <div v-if="interrupting" class="composer-notice restart" :class="{ failed: interrupting === 'failed' }" role="status">
      <template v-if="interrupting === 'failed'">
        <span class="restart-text">{{ stoppingShell ? tl('The command is still running.', 'La commande tourne encore.') : t('The agent is still working.') }}</span>
        <button v-if="!termShown" type="button" class="notice-btn" @click="emit('showTerminal')">{{ t('View terminal') }}</button>
        <button type="button" class="notice-btn" @click="interrupting = null">{{ t('Hide') }}</button>
      </template>
      <template v-else>
        <span class="notice-spin" aria-hidden="true" />
        <span class="restart-text">{{ stoppingShell ? tl('Cancelling the command…', 'Annulation de la commande…') : t('Stopping…') }}</span>
      </template>
    </div>
    <div v-else-if="pane?.restart" class="composer-notice restart" :class="pane.restart.phase" role="status">
      <template v-if="pane.restart.phase === 'failed'">
        <span class="restart-text">{{ pane.restart.update ? t('Codex update failed') : t('Restart failed') }}{{ tl(': ', ' : ') }}{{ t(pane.restart.error || '') }}</span>
        <button v-if="!termShown" type="button" class="notice-btn" @click="emit('showTerminal')">{{ t('View terminal') }}</button>
        <button v-if="pane.restart.update" type="button" class="notice-btn" @click="copyUpdate"><UIcon name="i-lucide-copy" />{{ t('Copy command') }}</button>
        <button type="button" class="notice-btn" @click="dismissRestart(paneId)">{{ t('Hide') }}</button>
      </template>
      <template v-else>
        <span class="notice-spin" aria-hidden="true" />
        <span class="restart-text">{{ restartLabel }}</span>
      </template>
    </div>
    <UsageLimitCard v-else-if="conversation && pane?.usageLimit" :limit="pane.usageLimit" :read-only="readOnly" :send-keys="sendKeys" @credits="runSlash('/usage-credits', false)" />
    <div v-else-if="pane?.claudeNotice" class="composer-notice" :class="{ error: noticeIsError }" role="status">
      <template v-if="updateReady">
        <span class="restart-text">{{ pane.claudeNotice.replace(/\s*·\s*Restart to update\b.*$/, '') }} ·</span>
        <button type="button" class="notice-btn" :disabled="readOnly" @click="restartAgent(pane)">
          <UIcon name="i-lucide-rotate-cw" />{{ t('Restart to update') }}
        </button>
      </template>
      <template v-else>{{ noticeIsError && !/^[✗✘]/.test(pane.claudeNotice) ? `✘ ${pane.claudeNotice}` : pane.claudeNotice }}</template>
    </div>
    <CodexNotices v-else-if="pane?.codexStatus" :pane="pane" :pane-id="paneId" :read-only="readOnly" />
    <div v-if="pane?.agent === 'codex' && pane.codexField && !interrupting" class="composer-notice codex-field" role="status">
      <UIcon name="i-lucide-text-cursor-input" class="notice-icon" />
      <span class="restart-text" :title="codexFieldHint">{{ tl('In Codex’s field:', 'Dans le champ de Codex :') }} <code>{{ pane.codexField }}</code></span>
      <button type="button" class="notice-btn" :disabled="readOnly || clearingField" :title="codexFieldHint" @click="clearCodexField">{{ tl('Clear', 'Vider') }}</button>
      <button v-if="!termShown" type="button" class="notice-btn" @click="emit('showTerminal')"><UIcon name="i-lucide-terminal" /><span class="notice-label">{{ t('View terminal') }}</span></button>
    </div>
    <div v-if="slashOpen" class="slash-menu" role="listbox" :aria-label="t('Commands')">
      <div v-if="slashMatches.length" ref="slashListEl" class="slash-list">
        <button
          v-for="(c, i) in slashMatches" :key="c.name" type="button" role="option" class="slash-item"
          :class="{ on: i === slashSel }" :aria-selected="i === slashSel"
          @mousedown.prevent @mousemove="hoverSlash($event, i)" @click="pickSlash(c)"
        >
          <span class="slash-name">/{{ c.name }}<small v-if="c.hint"> {{ c.hint }}</small></span>
          <span class="slash-desc">{{ c.desc }}</span>
        </button>
      </div>
      <div v-if="slashDenied" class="slash-denied" role="status">
        <p class="slash-denied-label">
          <UIcon name="i-lucide-shield-alert" />{{ tl('macOS hides this project’s commands', 'macOS masque les commandes de ce projet') }}
        </p>
        <p>
          {{ tl('Typed in full, they still work. To list them, on the Mac:', 'Tapées en entier, elles marchent quand même. Pour les lister, sur le Mac :') }}
          <span class="dir-denied-path">{{ slashDenied.remote
            ? tl('System Settings › General › Sharing › Remote Login ⓘ › “Allow full disk access for remote users”', 'Réglages Système › Général › Partage › Session à distance ⓘ › « Autoriser l’accès complet au disque pour les utilisateurs distants »')
            : tl('System Settings › Privacy & Security › Full Disk Access', 'Réglages Système › Confidentialité et sécurité › Accès complet au disque') }}</span>
        </p>
      </div>
    </div>
    <!-- Questions of the agent's last message the draft does not answer yet
         (ChatView.vue): a tab on the top edge, out of the flow, so that it
         comes and goes without moving the field or the conversation. -->
    <div v-if="unanswered && !readOnly" class="composer-ask-anchor">
      <button type="button" class="composer-ask" @mousedown.prevent @click="emit('showUnanswered')">
        <UIcon name="i-lucide-arrow-up" /><span>{{ unanswered > 1 ? tl(`${unanswered} questions unanswered`, `${unanswered} questions sans réponse`) : tl('1 question unanswered', '1 question sans réponse') }}</span>
      </button>
    </div>
    <div v-if="quotes.length" class="composer-quotes" role="list" :aria-label="t('Quoted questions')">
      <span class="composer-quotes-label">↳ {{ quotes.length }}</span>
      <span v-for="q in quotes" :key="q.start" class="composer-quote" role="listitem">
        <span class="composer-quote-text">{{ q.excerpt }}</span>
        <button type="button" class="composer-quote-x" :aria-label="t('Remove quote')" @mousedown.prevent @click="text = removeQuote(text, q)">
          <UIcon name="i-lucide-x" />
        </button>
      </span>
    </div>
    <UChatPrompt
      ref="promptRef" v-model="text" :disabled="Boolean(pane?.stopped)" :placeholder="pane?.stopped ? t('Restart Codex before sending a message') : readOnly ? t('Draft saved — sending unavailable offline') : placeholder" variant="outline" color="neutral"
      :rows="1" :maxrows="7" :autofocus="false" :submit-on-enter="enterSends && !slashOpen"
      :enterkeyhint="enterSends ? 'send' : 'enter'" autocapitalize="sentences"
      class="prompt" :class="{ suggesting: suggestTap, expanded }" :style="suggestRoom ? { '--suggest-room': `${suggestRoom}px` } : undefined" :ui="{ header: 'prompt-head', body: 'prompt-body', base: 'prompt-input', footer: 'prompt-foot' }"
      @focus="fieldFocused = true" @blur="fieldFocused = false"
      @submit="submit" @keydown="onKeydown" @paste="onPaste" @beforeinput="onBeforeInput"
    >
      <template v-if="attachments.length" #header>
        <div class="attachments">
          <template v-for="(a, i) in attachments" :key="a.url || a.path || a.file?.label || `paste:${i}`">
            <PastedCard v-if="a.paste" :text="a.paste" removable @remove="removeAtt(i)" />
            <FileChip
              v-else-if="a.file" :name="a.file.label" :size="a.file.size" :kind="a.file.kind" :uploading="!a.path" removable
              @remove="removeAtt(i)"
            />
            <div
              v-else class="att" :class="{ up: !a.path }"
              role="button" tabindex="0" :aria-label="t('View image')" @click="viewAtt(a)" @keydown.enter.self="viewAtt(a)"
            >
              <img :src="a.url" alt="">
              <span v-if="!a.path" class="spinner" />
              <button type="button" :aria-label="t('Remove')" @click.stop="removeAtt(i)"><UIcon name="i-lucide-x" /></button>
            </div>
          </template>
        </div>
      </template>
      <template #footer>
        <!-- The focused field's ring (main.css, "Focus border"): out of the footer's flow, over
             the field's border; a turning square under a fixed mask, so only the compositor works. -->
        <span class="fx-ring" aria-hidden="true"><span class="fx-spin" /></span>
        <span class="fx-halo" aria-hidden="true"><span class="fx-spin" /></span>
        <!-- Out of the footer's flow: top right of the field, over its first line. -->
        <button
          v-if="suggestTap" ref="suggestBtn" type="button" class="prompt-suggest" :aria-label="t('Use suggestion')"
          @mousedown.prevent @click="tapSuggestion"
        >
          <UIcon name="i-lucide-corner-down-left" /><span>{{ tl('Use', 'Utiliser') }}</span>
        </button>
        <UButton
          icon="i-lucide-plus" color="neutral" variant="outline" size="sm" class="prompt-plus" :disabled="readOnly"
          :aria-label="t('Photo, file, paste, commands')" @click="openPlus"
        />
        <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFiles">
        <input ref="anyFileInput" type="file" multiple hidden data-testid="attach-any" @change="onFiles">
        <div v-if="pane && (pane.agent === 'claude' || pane.agent === 'codex' || pane.agent === 'omp')" class="prompt-models">
          <ModelPicker :pane="pane" />
        </div>
        <span v-if="hint && suggestion" class="prompt-hint"><UKbd value="tab" size="sm" /> {{ t('suggestion') }} <span class="sep">·</span> <UKbd value="enter" size="sm" /> {{ t('send') }}</span>
        <span v-else-if="hint" class="prompt-hint"><UKbd value="enter" size="sm" /> {{ t('send') }} <span class="sep">·</span> <UKbd value="shift" size="sm" /><UKbd value="enter" size="sm" /> {{ t('new line') }}</span>
        <span v-else-if="desk && escStops && stopMode && interrupting !== 'running'" class="prompt-hint"><UKbd value="escape" size="sm" /> {{ tl('stop', 'arrêter') }}</span>
        <UChatPromptSubmit
          :status="stopMode ? 'streaming' : 'ready'" :disabled="sendDisabled"
          color="primary" variant="solid" streaming-color="neutral" streaming-variant="solid" streaming-icon="i-herdr-stop" size="sm"
          class="prompt-send" :class="{ stop: stopMode, pressed: sendPressed }" :aria-label="stopMode && shellRun ? tl('Cancel the command', 'Annuler la commande') : t(stopMode ? 'Stop the agent' : 'Send')"
          @mousedown.prevent @click="onSubmitClick" @stop="interrupt"
          @touchstart="sendTap.start" @touchend="sendTap.end" @touchcancel="sendTap.cancel"
        />
      </template>
    </UChatPrompt>
    <!-- omp: its status line, as at the bottom of the terminal. -->
    <div v-if="pane?.ompStatus" class="composer-status" :title="[pane.ompStatus.line, pane.ompStatus.meters].filter(Boolean).join('\n')">
      <span class="composer-status-line">{{ pane.ompStatus.line }}</span>
      <span v-if="pane.ompStatus.meters" class="composer-status-meters">{{ pane.ompStatus.meters }}</span>
    </div>
  </div>
</template>
