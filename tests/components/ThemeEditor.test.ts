// WHR-396: the custom theme editor starts from a theme, shows its colors live
// in the preview (the app in miniature), warns under WCAG AA, and saves a custom theme that is shown.
// WHR-432: the JSON tab edits the same theme, validated like an import.
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ThemeEditor from '~/components/ThemeEditor.vue'
import { customThemes, themeChoice, themeMode } from '~/composables/useTheme'
import { THEMES } from '~/utils/themes'
import { CUSTOM_THEMES_MAX } from '~/utils/customThemes'

afterEach(() => { customThemes.value = []; themeChoice.value = 'wherdr-titanium'; document.body.innerHTML = '' })

it('edits a copy of the theme with a live preview and contrast check, then saves it as a custom theme', async () => {
  themeMode.value = 'dark'
  const gruvbox = THEMES.find(t => t.id === 'gruvbox')!
  const w = await mountSuspended(ThemeEditor, { attachTo: document.body, props: { open: true, base: gruvbox } })
  await vi.waitFor(() => expect(document.querySelector('[data-testid="theme-editor"]')).not.toBeNull())
  const preview = document.querySelector<HTMLElement>('[data-testid="theme-preview"]')!
  expect(preview.style.getPropertyValue('--bg')).toBe(gruvbox.c.bg)
  // WHR-431: the whole app in miniature: sidebar, conversation, settings, terminal.
  for (const sel of ['.tp-side .card-state.working', '.tp-chat .msg-bubble', '.tp-chat .code-block', '.tp-set [role="switch"]', '.tp-term'])
    expect(preview.querySelector(sel), sel).not.toBeNull()
  const ansiRed = document.querySelector<HTMLInputElement>('input[aria-label="Terminal color 2"]')!
  ansiRed.value = '#123456'
  ansiRed.dispatchEvent(new Event('input'))
  await nextTick()
  expect(preview.querySelector<HTMLElement>('.tp-term .tp-swatches i:nth-child(2)')!.style.background).toBe('#123456')
  expect(document.querySelector('[data-testid="theme-contrast"]')!.textContent).toContain('Contrast meets WCAG AA')

  // Muted text as dark as the background: the preview follows, the check warns.
  const muted = document.querySelector<HTMLInputElement>('input[data-color="muted"]')!
  muted.value = gruvbox.c.bg
  muted.dispatchEvent(new Event('input'))
  await nextTick()
  expect(preview.style.getPropertyValue('--muted')).toBe(gruvbox.c.bg)
  expect(document.querySelector('[data-testid="theme-contrast"]')!.textContent).toContain('muted on bg 1.00 < 4.5')

  document.querySelector<HTMLButtonElement>('[data-testid="theme-save"]')!.click()
  await nextTick()
  expect(customThemes.value).toHaveLength(1)
  expect(customThemes.value[0]).toMatchObject({ label: 'Gruvbox copy', group: 'custom', c: { muted: gruvbox.c.bg } })
  expect(themeChoice.value).toBe(customThemes.value[0]!.id)
  expect(gruvbox.c.muted).not.toBe(gruvbox.c.bg) // the built-in theme is untouched
  w.unmount()
})

it('refuses a new theme past the cap instead of saving one that the next read would drop', async () => {
  const gruvbox = THEMES.find(t => t.id === 'gruvbox')!
  customThemes.value = Array.from({ length: CUSTOM_THEMES_MAX }, (_, i) => ({ ...gruvbox, id: `custom-${i}`, group: 'custom' as const }))
  const w = await mountSuspended(ThemeEditor, { attachTo: document.body, props: { open: true, base: gruvbox } })
  await vi.waitFor(() => expect(document.querySelector('[data-testid="theme-save"]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('[data-testid="theme-save"]')!.click()
  await nextTick()
  expect(customThemes.value).toHaveLength(CUSTOM_THEMES_MAX)
  expect(themeChoice.value).toBe('wherdr-titanium')
  expect(document.querySelector('[data-testid="theme-editor"]')).not.toBeNull() // still open, nothing lost
  w.unmount()
})

it('edits the theme as JSON: a valid edit reaches the swatches and preview, an invalid one blocks Save', async () => {
  themeMode.value = 'dark'
  const gruvbox = THEMES.find(t => t.id === 'gruvbox')!
  const w = await mountSuspended(ThemeEditor, { attachTo: document.body, props: { open: true, base: gruvbox } })
  await vi.waitFor(() => expect(document.querySelector('[data-testid="theme-editor"]')).not.toBeNull())
  const $ = <T extends Element>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`)!
  const preview = $<HTMLElement>('theme-preview')

  // A swatch edit shows in the JSON.
  const accent = document.querySelector<HTMLInputElement>('input[data-color="accent"]')!
  accent.value = '#123456'
  accent.dispatchEvent(new Event('input'))
  await nextTick()
  $<HTMLButtonElement>('theme-tab-json').click()
  await nextTick()
  const area = $<HTMLTextAreaElement>('theme-json')
  const file = JSON.parse(area.value)
  expect(file).toMatchObject({ wherdr: 'theme', name: 'Gruvbox copy', dark: { accent: '#123456' } })

  // A valid JSON edit: the preview follows, the text stays as typed.
  const typed = JSON.stringify({ ...file, dark: { ...file.dark, bg: '#010203' } })
  area.value = typed
  area.dispatchEvent(new Event('input'))
  await nextTick()
  expect(preview.style.getPropertyValue('--bg')).toBe('#010203')
  expect(area.value).toBe(typed)

  // Invalid: the error names the line, the preview keeps the last valid theme, Save is off.
  area.value = '{\n  "wherdr": "theme",\n  oops\n}'
  area.dispatchEvent(new Event('input'))
  await nextTick()
  expect($('theme-json-error').textContent).toBe('Line 3: Not valid JSON')
  expect(preview.style.getPropertyValue('--bg')).toBe('#010203')
  expect($<HTMLButtonElement>('theme-save').disabled).toBe(true)

  // Valid again, back to the colors: the swatch shows the JSON's color, and it saves.
  area.value = typed
  area.dispatchEvent(new Event('input'))
  await nextTick()
  $<HTMLButtonElement>('theme-tab-dark').click()
  await nextTick()
  expect(document.querySelector<HTMLInputElement>('input[data-color="bg"]')!.value).toBe('#010203')
  $<HTMLButtonElement>('theme-save').click()
  await nextTick()
  expect(customThemes.value[0]).toMatchObject({ c: { bg: '#010203', accent: '#123456' } })
  w.unmount()
})
