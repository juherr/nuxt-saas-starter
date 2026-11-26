// SPDX-License-Identifier: MIT
//
// Screenshots every page still open when an e2e test fails into
// test-results/e2e/, which the CI `e2e` job uploads: the pages the test
// opened, and those a beforeAll or an earlier test opened and it reused.
// @nuxt/test-utils takes no screenshot itself, and its own afterEach
// clears the test context before this file's hooks run, so the browsers
// are recorded at launch instead (tests/unit/e2eScreenshotPatch.test.ts
// checks that the patched chromium is the one @nuxt/test-utils launches).
import type { Browser, Page } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { beforeEach } from 'vitest'

const outputDir = join(process.cwd(), 'test-results', 'e2e')
const browsers = new Set<Browser>()

const launch = chromium.launch.bind(chromium)
chromium.launch = async (options) => {
  const browser = await launch(options)
  browsers.add(browser)
  browser.on('disconnected', () => browsers.delete(browser))
  return browser
}

function openPages(): Page[] {
  return [...browsers].flatMap(browser => browser.contexts().flatMap(context => context.pages()))
}

function fileSafe(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
}

beforeEach(({ task, onTestFailed }) => {
  onTestFailed(async () => {
    const pages = openPages().filter(page => !page.isClosed())
    if (pages.length === 0)
      return
    // fullName starts with the test file's path.
    const name = fileSafe(task.fullName)
    await mkdir(outputDir, { recursive: true })
    await Promise.all(pages.map((page, index) =>
      page.screenshot({ path: join(outputDir, `${name}-${index + 1}.png`), fullPage: true, timeout: 5_000 })
        .catch((error: unknown) => console.warn(`e2e screenshot of ${page.url()} failed:`, error))
    ))
  })
})
