// SPDX-License-Identifier: MIT
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// tests/e2e/setup.ts records the browsers by patching chromium.launch on
// the playwright-core it imports. @nuxt/test-utils launches through its
// own `import("playwright-core")`: if that resolved to another copy, the
// patch would never see a browser and failed tests would leave no
// screenshot, without any error.
describe('e2e screenshot patch', () => {
  it('patches the chromium that @nuxt/test-utils launches', async () => {
    const { chromium: ours } = await import('playwright-core')
    const original = ours.launch

    await import('../e2e/setup')

    const testUtilsEntry = createRequire(import.meta.url).resolve('@nuxt/test-utils/e2e')
    const theirsPath = realpathSync(createRequire(testUtilsEntry).resolve('playwright-core'))
    const { chromium: theirs } = await import(pathToFileURL(theirsPath).href)
    expect(theirs.launch).not.toBe(original)
    expect(theirs.launch).toBe(ours.launch)
  })
})
