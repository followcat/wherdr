// WHR-396: the custom theme editor starts from a theme, shows its colors live
// in the preview, warns under WCAG AA, and saves a custom theme that is shown.
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
