// A code block's Copy button: the text to the clipboard, "Copied" for a moment.
export function copyCodeBlock(btn: HTMLElement, text: string) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = t('Copied')
    btn.classList.add('done')
    setTimeout(() => {
      btn.textContent = t('Copy')
      btn.classList.remove('done')
    }, 1400)
  }).catch(() => toast(t('Copy failed'), true))
}
