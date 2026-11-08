import pkg from '../../package.json'

// Liveness and version, without the lock (server/middleware/guard.ts): the
// one-tap updater (bin/lib/updater.mjs) checks that the new version answers.
// Unlike the static files, it goes through the host check: the phone address
// probes (bin/lib/tailnet.mjs, the installer, the plugin) ask it to tell
// "wherdr answers here" from "wherdr refuses this address".
// `version` is v3's own (shared/v3Version.ts: 3.0.0-dev+<commit>); `release`
// keeps the package version the updater installed and compares.
export default defineEventHandler(() => ({ ok: true, name: 'wherdr', version: useRuntimeConfig().public.version, release: pkg.version }))
