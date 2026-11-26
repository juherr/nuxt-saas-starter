// SPDX-License-Identifier: MIT
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRoute, stubNitroGlobals } from './support/nitroGlobals'
import { FAKE_PERIOD_END, fakeSubscription, stripeSubscriptionsFake } from './support/stripeSubscriptionsFake'

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
      // A local row: the subscription is selected through one `retrieve`.
      subscription: {
        findFirst: async () => undefined,
        findMany: async () => [{ referenceId: 'org-a', status: 'active', stripeSubscriptionId: 'sub_yearly' }]
      }
    }
  })
}))
vi.mock('~~/server/utils/stripe', () => ({ createStripeClient }))

beforeAll(stubNitroGlobals)

const load = () => import('~~/server/api/stripe/preview-tier-change.post')

describe('the preview-tier-change endpoint on a scheduled downgrade', () => {
  beforeEach(() => {
    createStripeClient.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('reads the period end from the item of the subscription already loaded', async () => {
    const subscription = fakeSubscription('sub_yearly', 'active')
    subscription.items.data[0]!.price.recurring = { interval: 'year' }
    const subscriptions = stripeSubscriptionsFake({ pages: [[subscription]] })
    const retrieve = vi.fn(subscriptions.retrieve)
    createStripeClient.mockReturnValue({
      subscriptions: { ...subscriptions, retrieve },
      invoices: { createPreview: vi.fn() },
      paymentMethods: { retrieve: vi.fn() }
    })

    // Yearly to monthly on the same tier is a downgrade scheduled at period end.
    const preview = await callRoute<{ isScheduledDowngrade: boolean, periodEnd: string | null }>(
      load,
      { organizationId: 'org-a', newTierKey: 'pro', newInterval: 'month' }
    )

    expect(preview.isScheduledDowngrade).toBe(true)
    expect(preview.periodEnd).toBe(new Date(FAKE_PERIOD_END * 1000).toISOString())
    expect(retrieve).toHaveBeenCalledOnce()
  })
})
