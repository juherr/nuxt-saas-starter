// SPDX-License-Identifier: MIT
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import organizationMiddleware from '~/middleware/organization.global'

// The organization middleware activates the organization named by the URL slug.
// A refused set-active must never lead to another set-active in the same
// navigation (#147): the middleware redirects at most once, to an organization
// it does not need to activate, or to the forbidden page.

interface Org { id: string, slug: string }

const { navigateToMock, auth } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  auth: {
    loggedIn: false,
    orgs: [] as { id: string, slug: string }[],
    activeOrganizationId: undefined as string | undefined,
    setActiveError: null as { message: string } | null,
    setActive: vi.fn(),
    fetchSession: vi.fn(),
    activeOrg: { value: { data: null as unknown } }
  }
}))

mockNuxtImport('navigateTo', () => navigateToMock)

mockNuxtImport('useAuth', () => () => ({
  loggedIn: { get value() { return auth.loggedIn } },
  session: ref({ activeOrganizationId: auth.activeOrganizationId }),
  fetchSession: auth.fetchSession,
  useActiveOrganization: () => auth.activeOrg,
  organization: {
    list: async () => ({ data: auth.orgs }),
    setActive: auth.setActive
  }
}))

mockNuxtImport('useAsyncData', () => async (_key: string, handler: () => Promise<unknown>) => ({
  data: ref(await handler())
}))

const A: Org = { id: 'A', slug: 'org-a' }
const B: Org = { id: 'B', slug: 'org-b' }
const MAX_HOPS = 6

// Runs the middleware on `path`, then on every path it redirects to, like the
// router would, and returns the paths it navigated through.
async function navigate(path: string) {
  const visited = [path]
  let current = path
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    navigateToMock.mockClear()
    const resolved = useRouter().resolve(current)
    const to = { ...resolved, name: resolved.name ?? undefined }
    await organizationMiddleware(to, to)
    const target = navigateToMock.mock.calls[0]?.[0]
    if (typeof target !== 'string')
      break
    visited.push(target)
    current = target
  }
  return visited
}

describe('the organization middleware', () => {
  beforeEach(() => {
    auth.loggedIn = true
    auth.orgs = [A, B]
    auth.activeOrganizationId = undefined
    auth.setActiveError = null
    auth.activeOrg.value.data = null
    navigateToMock.mockReset()
    auth.fetchSession.mockReset()
    auth.setActive.mockReset()
    auth.setActive.mockImplementation(async ({ organizationId }: { organizationId: string }) => {
      if (auth.setActiveError)
        return { data: null, error: auth.setActiveError }
      auth.activeOrganizationId = organizationId
      return { data: {}, error: null }
    })
  })

  const dashboard = (org: Org) => useLocalePath()(`/${org.slug}/dashboard`)

  it('ends at the forbidden page when set-active is refused and no organization is active', async () => {
    auth.setActiveError = { message: 'refused' }

    const visited = await navigate(dashboard(A))

    expect(auth.setActive).toHaveBeenCalledTimes(1)
    expect(visited).toEqual([dashboard(A), useLocalePath()('/403')])
  })

  it('ends at the forbidden page when set-active is refused and the active organization was left', async () => {
    auth.setActiveError = { message: 'refused' }
    auth.activeOrganizationId = 'C'

    const visited = await navigate(dashboard(A))

    expect(auth.setActive).toHaveBeenCalledTimes(1)
    expect(visited).toEqual([dashboard(A), useLocalePath()('/403')])
  })

  it('goes back to the active organization when set-active is refused', async () => {
    auth.setActiveError = { message: 'refused' }
    auth.activeOrganizationId = B.id

    const visited = await navigate(dashboard(A))

    expect(auth.setActive).toHaveBeenCalledTimes(1)
    expect(visited).toEqual([dashboard(A), dashboard(B)])
    expect(auth.fetchSession).not.toHaveBeenCalled()
  })

  it('activates the requested organization without redirecting', async () => {
    auth.activeOrganizationId = B.id

    const visited = await navigate(dashboard(A))

    expect(auth.setActive).toHaveBeenCalledWith({ organizationId: A.id })
    expect(auth.fetchSession).toHaveBeenCalledTimes(1)
    expect(auth.activeOrg.value.data).toEqual(A)
    expect(visited).toEqual([dashboard(A)])
  })

  it('leaves an organization that is already active alone', async () => {
    auth.activeOrganizationId = A.id

    const visited = await navigate(dashboard(A))

    expect(auth.setActive).not.toHaveBeenCalled()
    expect(visited).toEqual([dashboard(A)])
  })

  it('redirects an unknown slug to the active organization', async () => {
    auth.activeOrganizationId = B.id

    const visited = await navigate(useLocalePath()('/unknown/dashboard'))

    expect(visited).toEqual([useLocalePath()('/unknown/dashboard'), dashboard(B)])
    expect(auth.setActive).not.toHaveBeenCalled()
  })

  it('redirects an unknown slug to the first organization when the active one is not listed', async () => {
    auth.activeOrganizationId = 'C'

    const visited = await navigate(useLocalePath()('/unknown/dashboard'))

    expect(visited).toEqual([useLocalePath()('/unknown/dashboard'), dashboard(A)])
    expect(auth.setActive).toHaveBeenCalledTimes(1)
  })

  it('ends at the forbidden page when an unknown slug leads to a refused set-active', async () => {
    auth.setActiveError = { message: 'refused' }
    auth.activeOrganizationId = 'C'

    const visited = await navigate(useLocalePath()('/unknown/dashboard'))

    expect(visited).toEqual([useLocalePath()('/unknown/dashboard'), dashboard(A), useLocalePath()('/403')])
    expect(auth.setActive).toHaveBeenCalledTimes(1)
  })

  it('keeps the locale prefix on the forbidden page', async () => {
    auth.setActiveError = { message: 'refused' }
    const i18n = useNuxtApp().$i18n
    await i18n.setLocale('fr')
    try {
      const visited = await navigate('/fr/org-a/dashboard')

      expect(visited).toEqual(['/fr/org-a/dashboard', '/fr/403'])
      expect(auth.setActive).toHaveBeenCalledTimes(1)
    }
    finally {
      await i18n.setLocale('en')
    }
  })
})
