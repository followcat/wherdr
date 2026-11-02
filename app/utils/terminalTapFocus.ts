// Whether a finger tap on the terminal may give it the keyboard.
//
// On iOS (WebKit, whatever the browser), focusing xterm's hidden textarea from a
// tap opens the on-screen keyboard over the terminal, even when the user only
// wanted to read or stop a scroll. There, the keyboard comes only from the
// composer or the key bar's "Type in terminal" button. Other engines (Android
// Chrome, Firefox) keep tap-to-type. `navigator.vendor` names the engine, not
// the browser: every iOS browser reports Apple, and a phone user agent emulated
// in Chromium still reports Google.
export function tapFocusesTerminal(vendor: string | undefined): boolean {
  return !/^Apple\b/.test(vendor ?? '')
}

// A mousedown is the compatibility event of a tap when the browser says so,
// or, without `sourceCapabilities` (WebKit), when a touch just happened.
export function mouseFromTouch(firesTouchEvents: boolean | undefined, sinceTouchMs: number): boolean {
  return firesTouchEvents ?? sinceTouchMs < 700
}
