// WHR-427: a theme Alfred proposes shows as a card: its swatches and sample in
// the current mode with the editor's contrast check; Edit opens the editor on
// it unsaved; at the custom-themes limit, Apply is off and the card says why.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ActionCard from '~/components/ActionCard.vue'
import { customThemes, themeMode } from '~/composables/useTheme'
import { THEMES } from '~/utils/themes'
import { CUSTOM_THEMES_MAX, themeFile } from '~/utils/customThemes'
import type { UiCard } from '#shared/uiActions'

const navy = { ...THEMES.find(t => t.id === 'gruvbox')!, label: 'Navy Ember' }
const card: UiCard = { id: 'a1b2c3d4e5f60718', by: 'Alfred', at: Date.now(), kind: 'theme', task: '', shown: '', label: 'Navy Ember', stamp: 'theme:Navy Ember', state: 'open', theme: { file: themeFile({ ...navy, c: { ...navy.c, muted: navy.c.bg } }), said: 'a navy theme' } }
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
mockNuxtImport('api', () => api)

afterEach(() => { customThemes.value = []; document.body.innerHTML = ''; api.mockReset() })

it('shows the proposed theme with its contrast check, opens it unsaved in the editor, and cancels', async () => {
  themeMode.value = 'dark'
  api.mockImplementation(async (url: string) => ({ card: url === '/api/ui/act' ? { ...card, state: 'dismissed', outcome: { text: 'Cancelled by you', at: Date.now() } } : card }))
  const w = await mountSuspended(ActionCard, { attachTo: document.body, props: { id: card.id } })
  await vi.waitFor(() => expect(w.find('[data-testid="theme-proposal"]').exists()).toBe(true))
  expect(w.text()).toContain('Theme proposed · by Alfred')
  expect(w.text()).toContain('Navy Ember')
  expect(w.find<HTMLElement>('[data-testid="theme-preview"]').element.style.getPropertyValue('--bg')).toBe(navy.c.bg)
  expect(w.find('[data-testid="theme-contrast"]').text()).toContain('muted on bg 1.00 < 4.5')

  await w.find('[data-testid="theme-edit"]').trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="theme-editor"]')).not.toBeNull())
  expect(document.querySelector<HTMLInputElement>('[data-testid="theme-name"]')!.value).toBe('Navy Ember')
  expect(customThemes.value).toEqual([]) // not saved by opening it

  await w.find('[data-testid="setting-cancel"]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-testid="action-outcome"]').text()).toContain('Cancelled by you'))
  expect(api).toHaveBeenLastCalledWith('/api/ui/act', { id: card.id, cancel: true })
  w.unmount()
})

it('at the custom-themes limit, Apply is off and the card points to the editor', async () => {
  customThemes.value = Array.from({ length: CUSTOM_THEMES_MAX }, (_, i) => ({ ...navy, id: `custom-${i}`, group: 'custom' as const }))
  api.mockResolvedValue({ card })
  const w = await mountSuspended(ActionCard, { attachTo: document.body, props: { id: card.id } })
  await vi.waitFor(() => expect(w.find('[data-testid="theme-full"]').exists()).toBe(true))
  expect(w.find('[data-testid="theme-full"]').text()).toContain('delete one in the theme editor')
  expect(w.find('[data-testid="setting-apply"]').attributes('disabled')).toBeDefined()
  w.unmount()
})
