// SPDX-License-Identifier: MIT
import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import type { OrgPermissionRequest, OrgRole } from '~~/shared/utils/permissions'
import { and, eq, inArray } from 'drizzle-orm'
import { member as memberTable, organization as organizationTable, subscription as subscriptionTable } from '~~/server/db/schema'
import { getAuthSession } from '~~/server/utils/auth'
import { useDB } from '~~/server/utils/db'
import { createStripeClient } from '~~/server/utils/stripe'
import { hasRole, orgRolesGrant } from '~~/shared/utils/permissions'

type Database = Awaited<ReturnType<typeof useDB>>

export interface BillingOrganization {
  id: string
  stripeCustomerId?: string | null
}

/** The organization with this id, or undefined when there is none. */
export function findOrganization(db: Database, organizationId: string) {
  return db.query.organization.findFirst({
    where: eq(organizationTable.id, organizationId)
  })
}

type AuthSession = NonNullable<Awaited<ReturnType<typeof getAuthSession>>>

const sessionsByEvent = new WeakMap<H3Event, AuthSession>()

/**
 * Requires a signed-in user and answers 401 otherwise. Routes call it
 * before reading their input, so an anonymous caller never gets a 400.
 * The session is kept for the rest of the request, so a later
 * `requireOrganizationRole` on the same event does not look it up again.
 */
export async function requireAuthSession(event: H3Event): Promise<AuthSession> {
  const known = sessionsByEvent.get(event)
  if (known) {
    return known
  }

  const session = await getAuthSession(event)
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  sessionsByEvent.set(event, session)
  return session
}

/**
 * Requires a signed-in member of the organization whose stored role passes
 * `allows`. Anonymous callers get 401. A non-member and a member refused by
 * `allows` get the same 403, so the answer does not reveal membership.
 */
async function requireOrganizationMember(
  event: H3Event,
  organizationId: string,
  allows: (role: string) => boolean
) {
  const session = await requireAuthSession(event)

  const db = await useDB()
  const member = await db.query.member.findFirst({
    where: and(
      eq(memberTable.organizationId, organizationId),
      eq(memberTable.userId, session.user.id)
    )
  })

  if (!member || !allows(member.role)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  return { session, member }
}

/**
 * Requires a signed-in user who is a member of the organization and, when
 * `roles` is given, whose stored role, a single role or a role list such
 * as `owner,admin`, holds at least one of them. Casing must still match.
 * Without `roles`, any membership passes, whatever its role value.
 * Anonymous callers get 401. A non-member and a member with another role
 * get the same 403, so the answer does not reveal membership.
 */
export function requireOrganizationRole(
  event: H3Event,
  organizationId: string,
  roles?: readonly OrgRole[]
) {
  return requireOrganizationMember(event, organizationId, role => !roles || hasRole(role, roles))
}

/**
 * Requires a signed-in member of the organization whose stored role is
 * granted `request` by the organization access control (`ac`), the model
 * better-auth's own organization and API key endpoints check: see
 * `orgRolesGrant`. Anonymous callers get 401; a non-member and a member
 * without the permission get the same 403.
 */
export function requireOrganizationPermission(
  event: H3Event,
  organizationId: string,
  request: OrgPermissionRequest
) {
  return requireOrganizationMember(event, organizationId, role => orgRolesGrant(role, request))
}

const subscriptionNotFound = () =>
  createError({ statusCode: 404, statusMessage: 'Subscription not found' })

const customerIdOf = (customer: Stripe.Subscription['customer'] | null | undefined) =>
  typeof customer === 'string' ? customer : customer?.id

async function retrieveIfExists(stripe: Stripe, subscriptionId: string) {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId)
  } catch (error: any) {
    if (error?.code === 'resource_missing') {
      return undefined
    }
    throw error
  }
}

/**
 * Resolves a client-supplied Stripe subscription id to a subscription that
 * belongs to `org`: the organization must hold a local record of it, and
 * Stripe must bill it to the organization's customer. Every failed check
 * answers the same 404. This only reads; callers update afterwards.
 */
export async function resolveOwnedSubscription(
  db: Database,
  stripe: Stripe,
  org: BillingOrganization,
  subscriptionId: string
): Promise<Stripe.Subscription> {
  if (!org.stripeCustomerId) {
    throw subscriptionNotFound()
  }

  // No unique index on stripeSubscriptionId: any matching record will do.
  const record = await db.query.subscription.findFirst({
    where: and(
      eq(subscriptionTable.referenceId, org.id),
      eq(subscriptionTable.stripeSubscriptionId, subscriptionId)
    )
  })
  if (!record || record.referenceId !== org.id || record.stripeSubscriptionId !== subscriptionId) {
    throw subscriptionNotFound()
  }

  const subscription = await retrieveIfExists(stripe, subscriptionId)
  if (!subscription || customerIdOf(subscription.customer) !== org.stripeCustomerId) {
    throw subscriptionNotFound()
  }

  return subscription
}

/**
 * Shared guard of the cancel and resume routes: requires a signed-in owner
 * of the client-supplied organization and resolves the client-supplied
 * subscription id to one billed to it. Returns what the route needs to
 * update the subscription.
 */
export async function requireOwnedSubscription(event: H3Event) {
  await requireAuthSession(event)

  const body = (await readBody(event)) ?? {}
  const { subscriptionId, referenceId } = body

  if (!subscriptionId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Subscription ID is required'
    })
  }

  if (!referenceId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Reference ID (Organization ID) is required'
    })
  }

  // subscriptionId and referenceId are client input: check the caller owns
  // the organization, then that the subscription is billed to it.
  await requireOrganizationRole(event, referenceId, ['owner'])

  const db = await useDB()
  const organization = await findOrganization(db, referenceId)
  if (!organization) {
    throw subscriptionNotFound()
  }

  const stripe = createStripeClient()
  await resolveOwnedSubscription(db, stripe, organization, subscriptionId)

  return { stripe, subscriptionId: subscriptionId as string, referenceId: referenceId as string }
}

const ACTIVE_STATUSES = ['active', 'trialing'] as const

const isActiveStatus = (status: string | null | undefined) =>
  (ACTIVE_STATUSES as readonly string[]).includes(status ?? '')

export type SubscriptionChoice<T>
  = | { outcome: 'none' }
    | { outcome: 'one', subscription: T }
    | { outcome: 'many' }

/**
 * Decides between candidate subscriptions, counting one id once. It never
 * picks among several distinct subscriptions: the caller must refuse.
 */
export function chooseSingleSubscription<T extends { id: string }>(candidates: readonly T[]): SubscriptionChoice<T> {
  const distinct = new Map(candidates.map(candidate => [candidate.id, candidate]))
  if (distinct.size === 0) {
    return { outcome: 'none' }
  }
  if (distinct.size > 1) {
    return { outcome: 'many' }
  }
  return { outcome: 'one', subscription: distinct.values().next().value! }
}

/**
 * Local records of the organization that are active or trialing, confirmed
 * by Stripe: the subscription exists, is billed to the organization's
 * customer and is still active or trialing there.
 */
async function verifiedLocalSubscriptions(stripe: Stripe, db: Database, org: BillingOrganization, customerId: string) {
  const rows = await db.query.subscription.findMany({
    where: and(
      eq(subscriptionTable.referenceId, org.id),
      inArray(subscriptionTable.status, [...ACTIVE_STATUSES])
    )
  })
  // No unique index on stripeSubscriptionId: several rows may share one id.
  const ids = new Set(rows
    .filter(row => row.referenceId === org.id && isActiveStatus(row.status))
    .map(row => row.stripeSubscriptionId)
    .filter((id): id is string => !!id))

  const verified: Stripe.Subscription[] = []
  for (const id of ids) {
    const subscription = await retrieveIfExists(stripe, id)
    if (subscription && customerIdOf(subscription.customer) === customerId && isActiveStatus(subscription.status)) {
      verified.push(subscription)
    }
  }
  return verified
}

/** Every active or trialing subscription of the customer, across all list pages. */
async function listedActiveSubscriptions(stripe: Stripe, customerId: string) {
  const listed: Stripe.Subscription[] = []
  for (const status of ACTIVE_STATUSES) {
    // `for await` walks every page (ApiListPromise is an async iterator).
    for await (const subscription of stripe.subscriptions.list({ customer: customerId, status })) {
      listed.push(subscription)
    }
  }
  return listed
}

/**
 * Finds the organization's single active or trialing Stripe subscription.
 * Local records of the organization come first, each confirmed by Stripe;
 * without any, the customer's active and trialing subscriptions are listed.
 * Answers 400 when there is none and 409 when there are several: it never
 * picks one arbitrarily.
 */
export async function selectActiveSubscription(
  stripe: Stripe,
  db: Database,
  org: BillingOrganization
): Promise<Stripe.Subscription> {
  const noActiveSubscription = () =>
    createError({ statusCode: 400, statusMessage: 'No active subscription found' })

  if (!org.stripeCustomerId) {
    throw noActiveSubscription()
  }

  let candidates = await verifiedLocalSubscriptions(stripe, db, org, org.stripeCustomerId)
  if (candidates.length === 0) {
    candidates = await listedActiveSubscriptions(stripe, org.stripeCustomerId)
  }

  const choice = chooseSingleSubscription(candidates)
  if (choice.outcome === 'none') {
    throw noActiveSubscription()
  }
  if (choice.outcome === 'many') {
    throw createError({ statusCode: 409, statusMessage: 'Multiple active subscriptions' })
  }
  return choice.subscription
}
