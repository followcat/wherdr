import pkg from '../../package.json'

// Liveness and version, without the lock (server/middleware/guard.ts): the
// one-tap updater (bin/lib/updater.mjs) checks that the new version answers.
// Unlike the static files, it goes through the host check: the phone address
// probes (bin/lib/tailnet.mjs, the installer, the plugin) ask it to tell
// "wherdr answers here" from "wherdr refuses this address".
// `version` is the build's (shared/v3Version.ts: <package version>+<commit>);
// `release` is the package version alone.
export default defineEventHandler(() => ({ ok: true, name: 'wherdr', version: useRuntimeConfig().public.version, release: pkg.version }))
