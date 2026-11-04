// What the service worker downloads after each deploy (nuxt.config.ts, pwa.injectManifest):
// the app shell, its scripts and styles, and the fonts of the interface. The rest
// is left to its first use, then kept by the worker like any build file (sw.ts,
// /_nuxt/ branch): the terminal's icon fonts, the font subsets of other scripts
// and the terminal itself (xterm.js). PDF.js stays out too (.mjs, not globbed).

export const PRECACHE_GLOBS = ['**/*.{js,css,png,svg,webmanifest,woff2}']

export const RUNTIME_ONLY_GLOBS = [
  // Symbols Nerd Font sets (≈ 1.1 MB): status bars and prompts in the terminal.
  '**/wherdr-nerd-*.woff2',
  // Inter / Archivo / JetBrains Mono beyond Latin (Latin covers French and English).
  '**/*-{latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-wght-normal.*.woff2',
  // The on-device dictation workers: only for those who turn it on.
  'workers/**',
]

// Modules loaded with import() on first use only (utils/xtermLoader.ts).
const LAZY_MODULE = /\/node_modules\/@xterm\//

// The parts of a Rollup output chunk read here.
interface Chunk { type: 'chunk', fileName: string, isDynamicEntry: boolean, facadeModuleId: string | null, imports: string[] }
type Bundle = Record<string, Chunk | { type: 'asset' }>

// The lazy chunks have hash-only names: a build plugin notes them, the precache
// manifest then drops them. A chunk another chunk imports statically stays.
export function lazyChunks() {
  const files = new Set<string>()
  const plugin = {
    name: 'wherdr:lazy-chunks',
    apply: 'build' as const,
    generateBundle(_options: unknown, bundle: Bundle) {
      const chunks = Object.values(bundle).filter((c): c is Chunk => c.type === 'chunk')
      const imported = new Set(chunks.flatMap(c => c.imports))
      for (const c of chunks) {
        if (c.isDynamicEntry && c.facadeModuleId && LAZY_MODULE.test(c.facadeModuleId) && !imported.has(c.fileName)) files.add(c.fileName)
      }
    },
  }
  const manifestTransform = async <E extends { url: string }>(entries: E[]) => ({
    manifest: entries.filter(e => !files.has(e.url.replace(/^\//, ''))),
    warnings: [] as string[],
  })
  return { plugin, manifestTransform, files }
}
