// SPDX-License-Identifier: MIT
/**
 * In-memory stand-in for `stripe.subscriptions.list` and `.retrieve`.
 *
 * `list` mirrors the SDK's `ApiListPromise` (stripe/types/lib.d.ts): awaiting
 * it gives the first page only (`data`, `has_more`), while iterating it with
 * `for await` walks every page. Code that reads `.data` alone therefore sees
 * page 1 only, as it would against Stripe.
 */

export interface FakeSubscription {
  id: string
  customer: string
  status: string
  /** Since API 2025-03-31.basil the period lives on the item (stripe 23 `SubscriptionItem`). */
  items: { data: Array<{ id: string, price: { id: string, recurring: { interval: string } }, quantity: number, current_period_end: number }> }
  default_payment_method: string
  trial_end: number | null
}

export const FAKE_TRIAL_END = 1_900_000_000
export const FAKE_PERIOD_END = 1_800_000_000

export function fakeSubscription(id: string, status: string, customer = 'cus_a'): FakeSubscription {
  const trialEnd = status === 'trialing' ? FAKE_TRIAL_END : null
  return {
    id,
    customer,
    status,
    items: {
      data: [{
        id: `si_${id}`,
        price: { id: 'price_test_current', recurring: { interval: 'month' } },
        quantity: 1,
        // While trialing, Stripe ends the item's period with the trial.
        current_period_end: trialEnd ?? FAKE_PERIOD_END
      }]
    },
    default_payment_method: `pm_${id}`,
    trial_end: trialEnd
  }
}

export interface StripeSubscriptionsState {
  /** The customer's subscriptions as Stripe lists them, page by page, all statuses mixed. */
  pages: FakeSubscription[][]
  /** Subscriptions Stripe knows but does not list for this customer (another customer's). */
  elsewhere?: FakeSubscription[]
}

export function fakeListPromise<T>(pages: T[][]) {
  const firstPage = { object: 'list' as const, data: pages[0] ?? [], has_more: pages.length > 1 }
  return Object.assign(Promise.resolve(firstPage), {
    async* [Symbol.asyncIterator]() {
      for (const page of pages) {
        yield* page
      }
    }
  })
}

const resourceMissing = (id: string) =>
  Object.assign(new Error(`No such subscription: '${id}'`), { code: 'resource_missing', statusCode: 404 })

export function stripeSubscriptionsFake(state: StripeSubscriptionsState) {
  const known = [...state.pages.flat(), ...(state.elsewhere ?? [])]

  return {
    retrieve: async (id: string) => {
      const found = known.find(sub => sub.id === id)
      if (!found) {
        throw resourceMissing(id)
      }
      return found
    },
    list: (params: { customer: string, status?: string, limit?: number }) => {
      const pages = state.pages
        .map(page => page.filter(sub => sub.customer === params.customer && (params.status === 'all' || sub.status === params.status)))
        .map(page => (params.limit ? page.slice(0, params.limit) : page))
      return fakeListPromise(pages)
    }
  }
}
