// App windows (sheets at the bottom on the phone, centered windows on a
// computer): menus, new agent, rename, image preview, confirmation.

export interface MenuItem {
  kind?: 'action' | 'command' | 'separator' | 'note' | 'group'
  label?: string
  icon?: string
  disabled?: boolean
  danger?: boolean
  cmd?: string
  // Command: its description; action: line under the label.
  desc?: string
  // Line under the label in mono font (an ID…).
  mono?: boolean
  // Keyboard shortcut (computer dropdown menus), Nuxt UI keys.
  kbds?: string[]
  run?: () => void
}

export const menuState = reactive<{ open: boolean, items: MenuItem[], title?: string }>({ open: false, items: [] })
export function openMenu(items: MenuItem[], title?: string) {
  menuState.items = items
  menuState.title = title
  menuState.open = true
}
// Phone: access to Settings from a view's menu (on a computer, the
// sidebar already offers them). Back returns to that view.
export function settingsMenuItems(): MenuItem[] {
  if (desk.value) return []
  return [{ kind: 'separator' }, { label: t('Settings'), icon: 'i-lucide-settings-2', run: () => navigateTo('/settings') }]
}

export const newAgentOpen = ref(false)
// Opened by Settings › Projects › Add project: on a new project, then cleared.
export const newProjectOpen = ref(false)
// Machine to preselect when the sheet opens (a machine's "…" menu), then cleared.
export const newAgentMachine = ref<string | null>(null)
export const renameTarget = ref<string | null>(null)
// What the rename sheet names: a pane, or a tab (its terminal's name, which the tab shows).
export const renameAs = ref<'pane' | 'tab'>('pane')

export const lightboxSrc = ref<string | null>(null)
// Images of the same message, browsable in the viewer (← →, swipe).
export const lightboxSet = ref<string[]>([])
export function openLightbox(srcs: string[], index = 0) {
  lightboxSet.value = srcs
  lightboxSrc.value = srcs[index] ?? null
}

// `tone`: red action button (destructive, the default) or accent. `code`:
// shown in full under the message, in a code box (a command to run).
export const confirmState = reactive<{ open: boolean, message: string, code: string, action: string, tone: 'error' | 'primary', resolve: ((ok: boolean) => void) | null }>({
  open: false, message: '', code: '', action: '', tone: 'error', resolve: null,
})
export function askConfirm(message: string, action: string, tone: 'error' | 'primary' = 'error', code = ''): Promise<boolean> {
  confirmState.resolve?.(false)
  return new Promise((resolve) => {
    confirmState.message = message
    confirmState.code = code
    confirmState.action = action
    confirmState.tone = tone
    confirmState.resolve = resolve
    confirmState.open = true
  })
}
export function answerConfirm(ok: boolean) {
  const r = confirmState.resolve
  confirmState.resolve = null
  confirmState.open = false
  r?.(ok)
}

// A window is open: Escape closes it instead of acting elsewhere.
export const anySheetOpen = computed(() => menuState.open || newAgentOpen.value || Boolean(renameTarget.value)
  || confirmState.open || Boolean(lightboxSrc.value))

// Same entries as a dropdown menu (computer): separate groups, destructive
// actions in red, notes ignored.
export function toDropdown(items: MenuItem[]) {
  const groups: { label?: string, description?: string, icon?: string, disabled?: boolean, color?: 'error', kbds?: string[], ui?: { itemDescription: string }, onSelect: () => void }[][] = [[]]
  for (const it of items) {
    if (it.kind === 'separator' || it.kind === 'group') groups.push([])
    else if (it.kind === 'note') continue
    else {
      groups[groups.length - 1]!.push({
        label: it.kind === 'command' ? `${it.cmd}  ${it.desc}` : it.label,
        ...(it.kind !== 'command' && it.desc ? { description: it.desc } : {}),
        ...(it.mono ? { ui: { itemDescription: 'font-mono' } } : {}),
        icon: it.icon,
        disabled: it.disabled,
        color: it.danger ? 'error' : undefined,
        kbds: it.kbds,
        onSelect: () => { if (!it.disabled) it.run?.() },
      })
    }
  }
  return groups.filter(g => g.length)
}
