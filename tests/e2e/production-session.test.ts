// SPDX-License-Identifier: MIT
//
// One browser session through the flows a signed-in user goes through,
// with a single UI sign-in for the whole file. The CI `e2e` job runs this
// file a second time against the same build restarted with
// NODE_ENV=production, where better-auth's rate limiter is on and allows
// 3 requests per 10 s to each /sign-in path per client IP: signing in
// once per test instead would make that run fail with 429s.
//
// The tests share one page (one browser context, so one cookie jar) and
// run in order: the second one needs the session the first one checks.
// Organization names carry a per-run suffix, since the job runs this file
// twice on one database and each run adds organizations to the user.
import type { Page } from 'playwright-core'
import { createPage, setup } from '@nuxt/test-utils/e2e'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Organization {
  id: string
  name: string
  slug: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} must be set`)
  return value
}

describe('production session', async () => {
  const host = process.env.NUXT_TEST_APP_URL
  await setup({
    host
  })

  const suffix = Date.now().toString(36)
  const userName = 'E2E User'
  let page: Page

  // The status is checked so that a rate-limited sign-in fails on its
  // 429 rather than on a page that never leaves /signin.
  async function signIn(): Promise<Page> {
    const signInPage = await createPage('/signin')
    await signInPage.fill('input[name="email"]', requiredEnv('NUXT_TEST_EMAIL'))
    await signInPage.fill('input[name="password"]', requiredEnv('NUXT_TEST_PASSWORD'))
    const [response] = await Promise.all([
      signInPage.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/auth/sign-in/email'),
      signInPage.click('button[type="submit"]')
    ])
    expect(response.status(), 'sign-in status').toBe(200)
    await signInPage.waitForURL(`${host}/`)
    return signInPage
  }

  beforeAll(async () => {
    page = await signIn()
  })

  afterAll(async () => {
    await page?.close()
  })

  // The visible organization switcher of the dashboard sidebar; the
  // mobile menu holds a second one.
  function switcher(name: string) {
    return page.getByRole('button', { name }).filter({ visible: true }).first()
  }

  async function activeOrganizationId(): Promise<string | null> {
    const response = await page.request.get(`${host}/api/auth/get-session?disableCookieCache=true`)
    expect(response.status()).toBe(200)
    const body = await response.json() as { session?: { activeOrganizationId?: string | null } } | null
    return body?.session?.activeOrganizationId ?? null
  }

  async function organizationBySlug(slug: string): Promise<Organization> {
    const response = await page.request.get(`${host}/api/auth/organization/list`)
    expect(response.status()).toBe(200)
    const organizations = await response.json() as Organization[]
    const found = organizations.find(organization => organization.slug === slug)
    if (!found)
      throw new Error(`organization ${slug} is not in the user's list`)
    return found
  }

  // Settings, since a team past the first one owned needs an upgrade:
  // the dashboard layout sends its other pages to billing, which opens
  // the upgrade modal over the switcher.
  async function expectActive(organization: { name: string, slug: string }) {
    await page.waitForURL(`${host}/${organization.slug}/settings`)
    await switcher(organization.name).waitFor()
    expect(await activeOrganizationId()).toBe((await organizationBySlug(organization.slug)).id)
  }

  // The switcher keeps the current page and swaps the slug.
  async function switchTo(from: { name: string }, to: { name: string }) {
    await switcher(from.name).click()
    await page.getByRole('menuitem', { name: to.name }).click()
  }

  it('signs in through the form and lands on the app with a session', async () => {
    expect(page.url()).toEqual(`${host}/`)
    // The landing page shows Dashboard instead of Get started once the
    // client sees the session.
    await page.getByRole('link', { name: 'Dashboard' }).first().waitFor()
    const cookies = await page.context().cookies()
    expect(cookies.some(cookie => cookie.name.endsWith('better-auth.session_token'))).toBe(true)
  })

  it('creates a second organization and switches between them from the switcher', async () => {
    // /dashboard sends a user without an organization to /onboarding (the
    // first run on a fresh database), and any other to the active one.
    await page.goto(`${host}/dashboard`)
    await page.waitForURL(url => url.pathname === '/onboarding' || /^\/[^/]+\/(?:dashboard|billing)$/.test(url.pathname))
    let first: { name: string, slug: string }
    if (new URL(page.url()).pathname === '/onboarding') {
      first = { name: `E2E Prod A ${suffix}`, slug: `e2e-prod-a-${suffix}` }
      await page.getByPlaceholder('Team Name (e.g. Acme Inc)').fill(first.name)
      await page.getByRole('button', { name: 'Create Team' }).click()
      await page.waitForURL(`${host}/${first.slug}/dashboard`)
      await page.getByRole('heading', { name: `Welcome back, ${userName}!` }).waitFor()
    } else {
      first = await organizationBySlug(new URL(page.url()).pathname.split('/')[1] ?? '')
    }
    await page.goto(`${host}/${first.slug}/settings`)
    await expectActive(first)

    // Creating a team from the switcher makes it the active one; a second
    // owned team lands on its billing page to offer the upgrade.
    const second = { name: `E2E Prod B ${suffix}`, slug: `e2e-prod-b-${suffix}` }
    await switcher(first.name).click()
    await page.getByRole('menuitem', { name: 'Create organization' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create New Team' })
    await dialog.getByPlaceholder('Acme Inc').fill(second.name)
    await dialog.getByRole('button', { name: 'Create Team' }).click()
    await page.waitForURL(url => url.pathname === `/${second.slug}/billing`)
    await page.goto(`${host}/${second.slug}/settings`)
    await expectActive(second)

    await switchTo(second, first)
    await expectActive(first)
    await switchTo(first, second)
    await expectActive(second)
    // Ends on the first team, so the next run starts on a team that needs
    // no upgrade.
    await switchTo(second, first)
    await expectActive(first)
  }, 60_000)
})
