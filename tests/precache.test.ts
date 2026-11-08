import { matchesGlob } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lazyChunks, PRECACHE_GLOBS, RUNTIME_ONLY_GLOBS } from '../shared/precache'

const precached = (file: string) => PRECACHE_GLOBS.some(g => matchesGlob(file, g))
  && !RUNTIME_ONLY_GLOBS.some(g => matchesGlob(file, g))

const chunk = (fileName: string, facadeModuleId: string | null, o: { dynamic?: boolean, imports?: string[] } = {}) =>
  ({ type: 'chunk' as const, fileName, facadeModuleId, isDynamicEntry: o.dynamic ?? false, imports: o.imports ?? [] })

describe('service worker precache', () => {
  it('keeps the shell, scripts, styles and Latin interface fonts', () => {
    for (const f of [
      '_nuxt/entry.BfKj2vWl.css',
      '_nuxt/V6xNHHvJ.js',
      'manifest.webmanifest',
      '_nuxt/inter-latin-wght-normal.Dx4kXJAl.woff2',
      '_nuxt/archivo-latin-wght-normal.E0tuGl4L.woff2',
      '_nuxt/jetbrains-mono-latin-wght-normal.B9CIFXIH.woff2',
      '_nuxt/wherdr-symbols.C1LsPKmg.woff2',
    ]) expect(precached(f), f).toBe(true)
  })

  it('leaves Nerd icon fonts and non-Latin font subsets to their first use', () => {
    for (const f of [
      '_nuxt/wherdr-nerd-material-1.BdvqkCqW.woff2',
      '_nuxt/wherdr-nerd-powerline.B_kAMxXr.woff2',
      '_nuxt/inter-latin-ext-wght-normal.DO1Apj_S.woff2',
      '_nuxt/inter-cyrillic-ext-wght-normal.BOeWTOD4.woff2',
      '_nuxt/jetbrains-mono-greek-wght-normal.Bw9x6K1M.woff2',
      '_nuxt/archivo-vietnamese-wght-normal.XAtsl5Q_.woff2',
      '_nuxt/pdf.min.t82Z80JU.mjs',
      // The dictation workers come at first use, with the model.
      'workers/dictation-worker.js',
      'workers/dictation-webgpu-worker.js',
      'workers/model-files.js',
    ]) expect(precached(f), f).toBe(false)
  })

  it('drops the lazy xterm chunks from the manifest, nothing else', async () => {
    const lazy = lazyChunks()
    lazy.plugin.generateBundle({}, {
      a: chunk('_nuxt/entry.js', 'node_modules/nuxt/dist/app/entry.js', { imports: ['_nuxt/shared.js'] }),
      b: chunk('_nuxt/xterm.js', '/w/node_modules/@xterm/xterm/lib/xterm.js', { dynamic: true }),
      c: chunk('_nuxt/webgl.js', '/w/node_modules/@xterm/addon-webgl/lib/addon-webgl.js', { dynamic: true }),
      // Also imported statically: needed by the shell, stays precached.
      d: chunk('_nuxt/shared.js', '/w/node_modules/@xterm/addon-fit/lib/addon-fit.js', { dynamic: true }),
      e: chunk('_nuxt/page.js', '/w/app/pages/index.vue', { dynamic: true }),
      f: { type: 'asset' },
    })
    const entries = ['_nuxt/entry.js', '_nuxt/xterm.js', '/_nuxt/webgl.js', '_nuxt/shared.js', '_nuxt/page.js']
      .map(url => ({ url, revision: null }))
    const { manifest } = await lazy.manifestTransform(entries)
    expect(manifest.map(e => e.url)).toEqual(['_nuxt/entry.js', '_nuxt/shared.js', '_nuxt/page.js'])
  })
})
