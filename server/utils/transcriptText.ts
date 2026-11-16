// Shared text handling for JSONL and daemon-backed conversation readers.
export const clip = (s: string, n = 20000) => (s.length > n ? s.slice(0, n) + '…' : s)
// Technical messages injected into a thread are not real user messages.
export const isNoise = (t: string) => /^\s*<(?!command-name)[a-z_-]+[\s>]/i.test(t) || /^\s*Caveat:/.test(t)
