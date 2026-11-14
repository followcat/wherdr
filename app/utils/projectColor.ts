// A project color as a CSS value: its theme token, else the closest state color.
const FALLBACK: Record<string, string> = { violet: 'mauve', blue: 'blue', teal: 'teal', green: 'green', amber: 'blocked', orange: 'blocked', red: 'rose', pink: 'rose' }
export const projectColorVar = (c: string) => `var(--project-${c}, var(--${FALLBACK[c] ?? 'mauve'}))`
