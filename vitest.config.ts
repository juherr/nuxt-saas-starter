// SPDX-License-Identifier: MIT
import { fileURLToPath } from 'node:url'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'

// One project per kind of test (https://nuxt.com/docs/4.x/getting-started/testing):
// - unit: server code in plain Node, without booting Nuxt;
// - nuxt: components mounted in the Nuxt runtime (mountSuspended);
// - e2e: builds and starts the app, or targets the running app at
//   NUXT_TEST_APP_URL, so it only runs on demand (pnpm test).
// Inline projects inherit this root config since Vitest 5, so the root only
// carries what every project shares.
export default defineConfig({
  test: {
    coverage: {
      // Without `include`, Vitest only reports the files the tests loaded,
      // so untested sources would not show up at all.
      include: [
        'app/**/*.{ts,vue}',
        'server/**/*.ts',
        'shared/**/*.ts',
        'emails/**/*.{ts,tsx}',
        'create-admin.ts'
      ],
      exclude: ['**/*.d.ts'],
      reporter: ['html'],
      reportsDirectory: 'tests/coverage'
    },
    projects: [
      {
        resolve: {
          alias: {
            '~~': fileURLToPath(new URL('./', import.meta.url)),
            'hub:kv': fileURLToPath(new URL('./tests/unit/stubs/hub-kv.ts', import.meta.url))
          }
        },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          // Above Vitest's 5 s / 10 s defaults so a loaded machine (parallel
          // runs, CI) does not time out tests that pass when rerun alone.
          testTimeout: 15000,
          hookTimeout: 15000
        }
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['tests/components/**/*.test.ts'],
          environment: 'nuxt',
          testTimeout: 30000,
          // Hooks mount the Nuxt app too: keep them on the test budget.
          hookTimeout: 30000,
          environmentOptions: {
            nuxt: {
              domEnvironment: 'happy-dom'
            }
          },
          setupFiles: './tests/setup.ts'
        }
      }),
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          setupFiles: ['./tests/setup.ts', './tests/e2e/setup.ts']
        }
      }
    ]
  }
})
