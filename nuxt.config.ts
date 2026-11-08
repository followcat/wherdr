// wherdr (herdr-web) — PWA to drive, from your phone, the coding agents running in Herdr.
// Client-only app (no SSR) served by Nitro, which also hosts the whole
// Herdr gateway (API, WebSockets, Web Push): see server/.
import { CSP_BASE, CSP_DICTATION_WORKER, CSP_WEBGPU_WORKER, DICTATION_WORKER_PATH, WEBGPU_WORKER_PATH } from './server/utils/csp'
import { ICON_SCAN_GLOBS } from './shared/iconScan'
import { lazyChunks, PRECACHE_GLOBS, RUNTIME_ONLY_GLOBS } from './shared/precache'
import { execFileSync } from 'node:child_process'
import { v3Version } from './shared/v3Version'
import { BOOT_THEME_KEY } from './shared/bootTheme'

// Demo build (`VITE_WHERDR_DEMO=1 nuxt generate`, served at wherdr.dev/demo/):
// the same app, static, with no server at all — app/demo/ answers the API in
// the browser — and no service worker. See app/demo/shim.ts.
const demo = process.env.VITE_WHERDR_DEMO === '1'
// Chunks left out of the service worker precache (shared/precache.ts).
const lazy = lazyChunks()
// v3's own version (shared/v3Version.ts), from the commit being built.
const buildCommit = (() => {
  if (process.env.WHERDR_COMMIT) return process.env.WHERDR_COMMIT
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return process.env.GITHUB_SHA }
})()

export default defineNuxtConfig({
  ssr: false,
  // Server and app run on herdr-core only (the demo answers the API itself).
  runtimeConfig: { public: { core: !demo, version: v3Version(buildCommit) } },
  modules: demo ? ['@nuxt/ui'] : ['@nuxt/ui', '@vite-pwa/nuxt'],
  plugins: demo ? ['~/demo/plugin.client'] : [],
  // No server code in the demo build (nothing to prerender against, nothing that
  // could run), and none of public/ (the install manifests: the demo is not installable).
  ...(demo ? { serverDir: 'demo-without-server', dir: { public: 'demo-without-public' } } : {}),
  css: ['~/assets/css/main.css'],
  typescript: { strict: true },
  devtools: { enabled: false },
  telemetry: false,

  // Fixed dark theme; bundled fonts (@fontsource, see main.css), never loaded from the network.
  ui: {
    colorMode: false,
    fonts: false,
    theme: { colors: ['primary', 'neutral', 'success', 'warning', 'error', 'info'] },
  },

  // Icons bundled: no network call at runtime
  // (the icon API would sit behind the lock anyway).
  icon: {
    provider: 'none',
    fallbackToApi: false,
    serverBundle: false,
    customCollections: [{ prefix: 'herdr', dir: './app/assets/icons' }],
    clientBundle: {
      scan: { globInclude: ICON_SCAN_GLOBS },
      includeCustomCollections: true,
      // Icons used by Nuxt UI components (close, check…).
      icons: [
        'lucide:x', 'lucide:check', 'lucide:chevron-down', 'lucide:chevron-up', 'lucide:chevron-right',
        'lucide:chevron-left', 'lucide:loader-circle', 'lucide:info', 'lucide:circle-alert',
        'lucide:triangle-alert', 'lucide:circle-check', 'lucide:circle-x', 'lucide:minus',
        'lucide:arrow-left', 'lucide:arrow-right', 'lucide:search', 'lucide:ellipsis',
        // Machines (computed names, not always seen by the scan).
        'lucide:server', 'lucide:laptop', 'lucide:unplug',
      ],
    },
  },

  // #/… addresses: links in notifications already sent (/#/a/<pane>)
  // and the installed icon stay valid.
  router: { options: { hashMode: true } },

  app: {
    baseURL: demo ? '/demo/' : '/',
    head: {
      title: 'wherdr',
      htmlAttrs: { lang: 'en', class: 'dark' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content' },
        { name: 'description', content: 'Control your Herdr code agents' },
        // Titanium is used before JS loads; app.vue updates these for saved choices.
        { key: 'theme-color', name: 'theme-color', content: '#12151b' },
        { key: 'color-scheme', name: 'color-scheme', content: 'dark' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        // "black" rather than "black-translucent": with translucent, iOS 26 shortens
        // the installed app by the height of the status bar… from the bottom (894 px out of 956).
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black' },
        { name: 'apple-mobile-web-app-title', content: 'wherdr' },
        { name: 'robots', content: 'noindex, nofollow' },
      ],
      // Startup background, painted before the styles and the app load (no
      // white frame on a reload): Titanium, or the theme last shown on this
      // device (useTheme.ts keeps its colour; the theme's own styles replace it).
      style: [{ innerHTML: 'html{background:var(--bg,#12151b)}' }],
      script: [{ innerHTML: `try{var t=JSON.parse(localStorage.getItem('${BOOT_THEME_KEY}')||'null'),d=document.documentElement;if(t&&/^#[0-9a-f]{3,8}$/i.test(t.bg)){d.style.setProperty('--bg',t.bg);d.className=t.light?'light':'dark'}}catch(e){}` }],
      // The manifest (FR or EN depending on the chosen language) is added by app.vue.
      link: demo
        // Demo: the icons of the site that serves it (wherdr.dev).
        ? [{ rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' }, { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }]
        : [
            // App icon (">_" + orange dot). An installation can replace it without
            // touching the code: set BRANDING_DIR to your branding folder.
            { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png?v=5' },
            { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icons/icon-192.png?v=5' },
            { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png?v=5' },
          ],
    },
  },

  // Custom service worker (app/service-worker/sw.ts), compiled by vite-pwa in
  // injectManifest mode. The FR/EN manifests are files in public/.
  vite: { plugins: demo ? [] : [lazy.plugin] },

  pwa: {
    strategies: 'injectManifest',
    srcDir: 'service-worker',
    filename: 'sw.ts',
    injectRegister: false,
    manifest: false,
    registerWebManifestInRouteRules: true,
    injectManifest: {
      rollupFormat: 'iife',
      minify: false,
      // App shell, scripts, styles and interface fonts; terminal icon fonts,
      // xterm.js and PDF.js are cached on first use (shared/precache.ts).
      globPatterns: PRECACHE_GLOBS,
      globIgnores: ['**/node_modules/**', ...RUNTIME_ONLY_GLOBS],
      manifestTransforms: [lazy.manifestTransform],
    },
    client: { installPrompt: false, periodicSyncForUpdates: 0 },
    devOptions: { enabled: false },
  },

  nitro: demo
    // Its own output folder: `.output` stays the app (npm package).
    ? { preset: 'static', output: { dir: '.output-demo' } }
    : {
        preset: 'node-server',
        experimental: { websocket: true },
        // The build's files also kept gzipped and brotli-compressed, served so
        // to a browser that takes it (2.6 MB → about 0.8 MB on a first load).
        compressPublicAssets: { gzip: true, brotli: true },
        // Scripts handed to machines (Claude status line installer):
        // bundled, the repository is not in the image.
        serverAssets: [{ baseName: 'scripts', dir: '../scripts', pattern: 'install-claude-statusline.sh' }],
      },

  // A /_nuxt file the current build lacks goes on to the previous builds'
  // copies (server/routes/_nuxt/[...path].get.ts) instead of Nitro's 404.
  hooks: {
    'nitro:config'(config) {
      for (const dir of config.publicAssets || []) if (dir?.baseURL === '/_nuxt/') dir.fallthrough = true
    },
  },

  // App code always revalidated (otherwise an iPhone keeps the old version
  // after an update); only fingerprinted files (/_nuxt/) and
  // icons are kept.
  routeRules: {
    '/**': { headers: {
      'cache-control': 'no-cache',
      'content-security-policy': CSP_BASE,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    } },
    // Only these worker responses allow compiling WebAssembly (server/utils/csp.ts).
    [DICTATION_WORKER_PATH]: { headers: { 'content-security-policy': CSP_DICTATION_WORKER } },
    [WEBGPU_WORKER_PATH]: { headers: { 'content-security-policy': CSP_WEBGPU_WORKER } },
    '/icons/**': { headers: { 'cache-control': 'public, max-age=86400' } },
    '/_nuxt/**': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
  },

  // Never reload automatically after a deployment (Nuxt would reload
  // on the next navigation): app/plugins/app-version.client.ts detects the
  // new build and shows a "Reload" banner.
  experimental: { emitRouteChunkError: 'manual', checkOutdatedBuildInterval: false },

  compatibilityDate: '2025-07-15',
})
