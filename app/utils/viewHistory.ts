// Detail routes share the same policy for header back and native browser back.
export function isDetailRoute(path: string, query: Record<string, unknown>): boolean {
  return path.startsWith('/a/') || path.startsWith('/t/')
    || (path === '/board' && Boolean(query.task || query.coordinator || query.conversation))
}

export function internalBack(back: unknown): back is string {
  return typeof back === 'string' && back.startsWith('/') && !back.startsWith('//')
}
