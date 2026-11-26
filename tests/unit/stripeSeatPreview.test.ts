// SPDX-License-Identifier: MIT
import type { FakeSubscription } from './support/stripeSubscriptionsFake'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTierForInterval } from '~~/shared/utils/plans'
import { callRoute, stubNitroGlobals } from './support/nitroGlobals'
import { FAKE_TRIAL_END, fakeSubscription, stripeSubscriptionsFake } from './support/stripeSubscriptionsFake'

const createStripeClient = vi.hoisted(() => vi.fn())

vi.mock('~~/server/utils/auth', () => ({ getAuthSession: vi.fn() }))
vi.mock('~~/server/utils/billing', async importActual => ({
  ...(await importActual<typeof import('~~/server/utils/billing')>()),
  requireAuthSession: vi.fn(async () => ({ user: { id: 'u1' } })),
  requireOrganizationRole: vi.fn(async () => ({}))
}))
vi.mock('~~/server/utils/db', () => ({
  useDB: async () => ({
    query: {
      organization: { findFirst: async () => ({ id: 'org-a', stripeCustomerId: 'cus_a' }) },
      // No local row: the subscription is listed from Stripe and priced as pro.
      subscription: { findFirst: async () => undefined, findMany: async () => [] }
    }
  })
}))
vi.mock('~~/server/utils/stripe', () => ({ createStripeClient }))

beforeAll(stubNitroGlobals)

const load = () => import('~~/server/api/stripe/preview-seat-change.post')

/** A trialing subscription as Stripe returns it today: no legacy `plan` field. */
function trialingSubscription(recurring: { interval: string } | null): FakeSubscription {
  const subscription = fakeSubscription('sub_trial', 'trialing')
  expect(subscription).not.toHaveProperty('plan')
  subscription.items.data[0]!.price.recurring = recurring as { interval: string }
  return subscription
}

function stubStripe(subscription: FakeSubscription) {
  const createPreview = vi.fn()
  createStripeClient.mockReturnValue({
    subscriptions: stripeSubscriptionsFake({ pages: [[subscription]] }),
    invoices: { createPreview },
    paymentMethods: { retrieve: vi.fn(async () => ({ card: null })) }
  })
  return { createPreview }
}

describe('the preview-seat-change endpoint on a trialing subscription', () => {
  beforeEach(() => {
    createStripeClient.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('prices the preview with the item price interval when no newInterval is sent', async () => {
    const { createPreview } = stubStripe(trialingSubscription({ interval: 'year' }))
    const yearly = getTierForInterval('pro', 'year')

    const preview = await callRoute<{ total: number, periodEnd: number }>(
      load,
      { organizationId: 'org-a', seats: 2 }
    )

    expect(preview.total).toBe(Math.round((yearly.price + yearly.seatPrice) * 100))
    expect(createPreview).not.toHaveBeenCalled()
  })

  it('ends the previewed period with the trial, not a year from now', async () => {
    stubStripe(trialingSubscription({ interval: 'year' }))

    const preview = await callRoute<{ periodEnd: number }>(load, { organizationId: 'org-a', seats: 2 })

    expect(preview.periodEnd).toBe(FAKE_TRIAL_END)
  })

  it('fails explicitly when the item price has no recurring interval', async () => {
    stubStripe(trialingSubscription(null))

    const outcome = await callRoute(load, { organizationId: 'org-a', seats: 2 })
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toMatchObject({ statusCode: 500, statusMessage: 'Subscription price has no billing interval' })
  })
})

describe('the preview-seat-change endpoint on an active subscription', () => {
  /** What Stripe's preview invoice reports as the end of the period it bills. */
  const INVOICE_PERIOD_END = 1_850_000_000

  function activeSubscription(interval: 'month' | 'year'): FakeSubscription {
    const subscription = fakeSubscription('sub_active', 'active')
    subscription.items.data[0]!.price.recurring = { interval }
    return subscription
  }

  function stubPreviewInvoice(subscription: FakeSubscription) {
    const { createPreview } = stubStripe(subscription)
    createPreview.mockResolvedValue({
      amount_due: 5000,
      total: 5000,
      subtotal: 5000,
      currency: 'usd',
      period_end: INVOICE_PERIOD_END,
      lines: { data: [] }
    })
    return createPreview
  }

  beforeEach(() => {
    createStripeClient.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('keeps the current period end on a seat change of a yearly subscription', async () => {
    const createPreview = stubPreviewInvoice(activeSubscription('year'))

    const preview = await callRoute<{ periodEnd: number }>(
      load,
      { organizationId: 'org-a', seats: 3, newInterval: 'year' }
    )

    expect(createPreview).toHaveBeenCalledOnce()
    expect(preview.periodEnd).toBe(INVOICE_PERIOD_END)
  })

  it('starts a yearly period today when a monthly subscription moves to yearly', async () => {
    stubPreviewInvoice(activeSubscription('month'))
    const before = Math.floor(Date.now() / 1000)

    const preview = await callRoute<{ periodEnd: number }>(
      load,
      { organizationId: 'org-a', seats: 3, newInterval: 'year' }
    )

    expect(preview.periodEnd).toBeGreaterThanOrEqual(before + 31_536_000)
    expect(preview.periodEnd).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 31_536_000)
  })
})
