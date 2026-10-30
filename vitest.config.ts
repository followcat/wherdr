import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

// Two projects:
// - unit: pure server / shared / app / website modules, plain Node (fast, no Nuxt).
// - components: Vue components mounted in a Nuxt environment (auto-imports,
//   Nuxt UI) on happy-dom, files in tests/components/.
export default defineConfig({
  test: {
    projects: [
      {
        // Fixed TS transform options (the ones Nuxt's generated tsconfig sets):
        // given inline, Vite's oxc transform does not look up a tsconfig.json per
        // file, so the suite runs in a fresh clone without any generated .nuxt —
        // including the website/ modules, whose tsconfig.json extends website/.nuxt.
        // (Vite's OxcOptions type omits `tsconfig`, but the transform honours it.)
        oxc: {
          tsconfig: { compilerOptions: { target: 'ESNext', verbatimModuleSyntax: true, useDefineForClassFields: true } },
        } as Record<string, unknown>,
        test: {
          name: 'unit',
          include: ['tests/*.test.ts'],
          environment: 'node',
          // Some tests spawn real subprocesses (plugin installs, socket
          // responders); under a full parallel run 5s is not enough.
          testTimeout: 30000,
        },
      },
      await defineVitestProject({
        test: {
          name: 'components',
          include: ['tests/components/**/*.test.ts'],
          environment: 'nuxt',
          environmentOptions: { nuxt: { domEnvironment: 'happy-dom' } },
          // The first mount builds the Nuxt app: slow on small machines.
          testTimeout: 20000,
        },
      }),
    ],
  },
})
