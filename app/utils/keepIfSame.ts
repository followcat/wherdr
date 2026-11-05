// A live push hands a new pane object even when what a view reads from it is
// unchanged. A computed that returns `keepIfSame(old, next)` keeps its previous
// value when the new one is equal as JSON, so whatever reads it (a template, a
// slot) re-renders only on a real change. Plain data only.
export function keepIfSame<T>(prev: T | undefined, next: T): T {
  if (prev === undefined || prev === next) return next
  try { return JSON.stringify(prev) === JSON.stringify(next) ? prev : next }
  catch { return next }
}

// One object per distinct key: the same props object for a child on each render.
export function keyedMemo<K, V>(build: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>()
  return (key) => {
    let v = cache.get(key)
    if (v === undefined) {
      if (cache.size > 200) cache.clear()
      v = build(key)
      cache.set(key, v)
    }
    return v
  }
}

// One result per object (a conversation block): rebuilt only with the object.
export function weakMemo<K extends object, V>(build: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>()
  return (key) => {
    if (cache.has(key)) return cache.get(key)!
    const v = build(key)
    cache.set(key, v)
    return v
  }
}
