// Font stack of the terminals (xterm). "Wherdr Symbols" (lines, blocks,
// agent controls) comes first; "Wherdr Nerd Symbols" fills the Nerd Font
// icons (Private Use Area) after JetBrains Mono. Both faces are declared in
// assets/css/main.css with a unicode-range: a file is only downloaded when
// one of its glyphs is displayed.
export const TERM_FONT = '"Wherdr Symbols", "JetBrains Mono Variable", "JetBrains Mono", "Wherdr Nerd Symbols", ui-monospace, "SF Mono", Menlo, monospace'

// Settings › Appearance › Interface size › Large enlarges the terminal text by
// ~15% on a computer (`desk`); the device's own text size stays the base.
// Phones have no Interface size setting and are never scaled.
export function scaledTermFont(n: number, desk: boolean, scale: 'md' | 'lg'): number {
  return Math.min(30, Math.round(n * (desk && scale === 'lg' ? 1.15 : 1)))
}

/** Run `redraw` each time the document finishes loading a font face. */
export function onFontsLoaded(redraw: () => void): () => void {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts?.addEventListener) return () => {}
  fonts.addEventListener('loadingdone', redraw)
  return () => fonts.removeEventListener('loadingdone', redraw)
}
