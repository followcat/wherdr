export default defineAppConfig({
  ui: {
    colors: {
      primary: 'indigo',
      neutral: 'slate',
    },
    // Selects: a 44 px touch target, and a menu as wide as its longest choice.
    // The chevron keeps Nuxt UI's spacing (size lg: 12 px, like the text's left padding).
    select: {
      slots: { base: 'min-h-11', content: 'min-w-fit' },
    },
    selectMenu: {
      slots: { base: 'min-h-11', content: 'min-w-fit' },
    },
    // One switch look everywhere: green when on, in every theme (a switch without a color would take primary).
    switch: {
      defaultVariants: { color: 'success' },
    },
    // Same square surface and same colors as the cards and windows.
    toast: {
      slots: {
        root: 'hw-toast',
        title: 'hw-toast-title',
        icon: 'hw-toast-icon',
        description: 'hw-toast-desc',
      },
    },
  },
})
