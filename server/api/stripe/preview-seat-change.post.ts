// SPDX-License-Identifier: MIT
import { eq } from 'drizzle-orm'
import { subscription as subscriptionTable } from '~~/server/db/schema'
import { findOrganization, requireAuthSession, requireOrganizationRole, selectActiveSubscription } from '~~/server/utils/billing'
import { useDB } from '~~/server/utils/db'
import { createStripeClient } from '~~/server/utils/stripe'
import { requireSubscriptionItem } from '~~/server/utils/stripeSubscriptionItem'
import { getStripeSubscriptionPeriodEndSeconds } from '~~/server/utils/stripeSubscriptionPeriod'
import { getPlanKeyFromId, getTierForInterval } from '~~/shared/utils/plans'

export default defineEventHandler(async (event) => {
  await requireAuthSession(event)

  const body = (await readBody(event)) ?? {}
  const { organizationId, seats, newInterval } = body

  if (!organizationId || !seats) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing required fields'
    })
  }

  const db = await useDB()

  // Verify ownership
  await requireOrganizationRole(event, organizationId, ['owner'])

  const org = await findOrganization(db, organizationId)

  if (!org || !org.stripeCustomerId) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Organization or Stripe Customer not found'
    })
  }

  const stripe = createStripeClient()

  // Find subscription
  const subscription = await selectActiveSubscription(stripe, db, org)

  // If currently trialing, calculate locally and return immediately (No Proration/Stripe API needed)
  if (subscription.status === 'trialing') {
    // The legacy `plan` field is absent from current Stripe subscriptions:
    // the billing interval lives on the item's recurring price.
    const interval = newInterval || subscription.items.data[0]?.price.recurring?.interval
    if (!interval) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Subscription price has no billing interval'
      })
    }

    // Find the correct plan config to support Legacy Pricing
    // We must check the LOCAL database to see which Plan Version (V1, V2, V3) the user is on,
    // because they might share the same Stripe Price ID.
    const localSub = await db.query.subscription.findFirst({
      where: eq(subscriptionTable.stripeSubscriptionId, subscription.id)
    })

    console.log('[preview-seat-change] Trial - localSub.plan:', localSub?.plan)

    // Get user's current tier and find pricing
    const tierKey = getPlanKeyFromId(localSub?.plan)
    const effectiveTierKey = (tierKey === 'free' ? 'pro' : tierKey) as Exclude<typeof tierKey, 'free'>
    const planConfig = getTierForInterval(effectiveTierKey, interval as 'month' | 'year')

    console.log('[preview-seat-change] Trial - tierKey:', tierKey, 'planConfig:', planConfig)

    // Calculate total: Base Price + (Additional Seats * Seat Price)
    // Base Plan covers 1st seat. Additional seats = seats - 1.
    // Example: Base $99.99 + ((2-1) Seat * $50.00) = $149.99
    const additionalSeats = Math.max(0, seats - 1)
    const totalCents = Math.round((planConfig.price + (additionalSeats * planConfig.seatPrice)) * 100)

    // Get payment method info for trial subscriptions too
    let paymentMethod = null
    if (subscription.default_payment_method) {
      try {
        const pm = await stripe.paymentMethods.retrieve(subscription.default_payment_method as string)
        if (pm.card) {
          paymentMethod = {
            type: 'card',
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year
          }
        }
      } catch (e) {
        console.warn('[preview-seat-change] Could not fetch payment method:', e)
      }
    }

    return {
      amountDue: totalCents,
      total: totalCents,
      subtotal: totalCents,
      currency: subscription.currency || 'usd',
      // The first paid period starts when the trial ends.
      periodEnd: subscription.trial_end ?? getStripeSubscriptionPeriodEndSeconds(subscription),
      lines: [],
      paymentMethod
    }
  }

  // Determine new price if interval changes
  let newPriceId
  if (newInterval) {
    // Get user's current tier
    const localSub = await db.query.subscription.findFirst({
      where: eq(subscriptionTable.stripeSubscriptionId, subscription.id)
    })
    console.log('[preview-seat-change] Local sub:', { plan: localSub?.plan, stripeSubId: subscription.id })

    const tierKey = getPlanKeyFromId(localSub?.plan)
    console.log('[preview-seat-change] Tier key:', tierKey, 'from plan:', localSub?.plan)

    const effectiveTierKey = (tierKey === 'free' ? 'pro' : tierKey) as Exclude<typeof tierKey, 'free'>
    console.log('[preview-seat-change] Effective tier:', effectiveTierKey, 'interval:', newInterval)

    const planConfig = getTierForInterval(effectiveTierKey, newInterval as 'month' | 'year')
    console.log('[preview-seat-change] Plan config:', planConfig)

    newPriceId = planConfig.priceId
  }

  const currentItem = requireSubscriptionItem(subscription)
  const subscriptionItemId = currentItem.id
  const priceId = newPriceId || currentItem.price.id
  const currentSeats = currentItem.quantity || 1
  const isDowngrade = seats < currentSeats

  // Use Stripe SDK v20 - createPreview supports flexible billing mode
  let upcomingInvoice
  try {
    console.log('[preview-seat-change] Creating preview with:', {
      subscriptionId: subscription.id,
      subscriptionItemId,
      seats,
      priceId,
      newInterval,
      currentPriceId: currentItem.price.id,
      isDowngrade
    })

    upcomingInvoice = await stripe.invoices.createPreview({
      subscription: subscription.id,
      subscription_details: {
        proration_behavior: (isDowngrade ? 'create_prorations' : 'always_invoice') as 'create_prorations' | 'always_invoice',
        items: [
          {
            id: subscriptionItemId,
            quantity: seats,
            price: priceId
          }
        ]
      }
    })

    console.log('[preview-seat-change] Stripe preview result:', {
      amount_due: upcomingInvoice.amount_due,
      total: upcomingInvoice.total,
      subtotal: upcomingInvoice.subtotal,
      lines: upcomingInvoice.lines.data.map(l => ({
        description: l.description,
        amount: l.amount
      }))
    })
  } catch (e) {
    console.error('[stripe/preview-seat-change]', e)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to calculate preview'
    })
  }

  // A monthly subscription moving to yearly starts a new period today, so the
  // next billing date is 1 year from now (not the current period end). A seat
  // change on a subscription that is already yearly keeps its period.
  let periodEnd = upcomingInvoice.period_end
  if (newInterval === 'year' && currentItem.price.recurring?.interval === 'month') {
    // When upgrading to yearly, next charge is 1 year from today
    periodEnd = Math.floor(Date.now() / 1000) + 31536000 // 365 days in seconds
  }

  // Get payment method info
  let paymentMethod = null
  if (subscription.default_payment_method) {
    try {
      const pm = await stripe.paymentMethods.retrieve(subscription.default_payment_method as string)
      if (pm.card) {
        paymentMethod = {
          type: 'card',
          brand: pm.card.brand,
          last4: pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year
        }
      }
    } catch (e) {
      console.warn('[preview-seat-change] Could not fetch payment method:', e)
    }
  }

  console.log('[preview-seat-change] Final preview:', {
    isDowngrade,
    amountDue: upcomingInvoice.amount_due,
    periodEnd
  })

  return {
    amountDue: isDowngrade ? 0 : upcomingInvoice.amount_due,
    total: upcomingInvoice.total,
    subtotal: upcomingInvoice.subtotal,
    currency: upcomingInvoice.currency,
    periodEnd,
    lines: upcomingInvoice.lines.data,
    paymentMethod,
    isDowngrade
  }
})
