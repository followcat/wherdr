// What a terminal relay needs from a WebSocket (crossws or other), and what it
// gives back (see coreTerm.ts).
export interface WsLike {
  // `options.compress`: per frame, so a small frame skips zlib
  // (wsCompression.ts, termSendOptions).
  send: (data: string, options?: { compress?: boolean }) => void
  close: (code?: number, reason?: string) => void
  isOpen: () => boolean
}

export interface TermSession {
  onMessage: (raw: string) => void
  // `clean`: closed on purpose by the client (not a dropped connection).
  onClose: (clean?: boolean) => void
}
