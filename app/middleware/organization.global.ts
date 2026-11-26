// SPDX-License-Identifier: MIT
export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn, organization, useActiveOrganization, fetchSession, session } = useAuth()

  if (!loggedIn.value)
    return

  const routeSlug = to.params.slug as string
  if (!routeSlug || routeSlug === 't')
    return

  // Don't run on non-dashboard routes if they happen to have a slug param but aren't organization related
  // Assuming all routes with :slug are organization routes based on app structure

  // Check if we need to switch organization
  const activeOrgId = (session.value as any)?.activeOrganizationId

  // Use cached org list to avoid fetching on every navigation
  // getCachedData returns undefined to ensure fresh data on each full page load
  const { data: orgs } = await useAsyncData('user-organizations', async () => {
    const { data } = await organization.list()
    return data
  }, {
    getCachedData: () => undefined
  })

  if (!orgs.value || orgs.value.length === 0)
    return

  const targetOrg = orgs.value.find((o: any) => o.slug === routeSlug)

  if (targetOrg) {
    if (targetOrg.id !== activeOrgId) {
      // Organization mismatch, set active organization
      const { error } = await organization.setActive({ organizationId: targetOrg.id })
      if (error) {
        // The session stays on its organization: leave the requested one, never mark it active.
        // Only the active org is a safe fallback: arriving there needs no set-active. Any other
        // org would be refused too and redirect back, looping inside one SSR request (#147).
        // Without one, /403 as the route guards do: it has no :slug, so this middleware stops
        // there, and it is translated, unlike Nuxt's default error page (no app/error.vue).
        console.error('[middleware/organization] setActive failed', error)
        const sessionOrg = orgs.value.find(o => o.id === activeOrgId)
        if (sessionOrg)
          return navigateTo(useLocalePath()(`/${sessionOrg.slug}/dashboard`))
        return navigateTo(useLocalePath()('/403'))
      }
      await fetchSession()

      // Update activeOrg ref immediately to update UI
      const activeOrg = useActiveOrganization()
      if (activeOrg.value) {
        activeOrg.value.data = targetOrg
      }
    }
  } else {
    // Invalid slug: redirect to the active org, which needs no set-active, else the first one
    const fallbackOrg = orgs.value.find(o => o.id === activeOrgId) ?? orgs.value[0]
    if (fallbackOrg) {
      // Prevent infinite redirect if we are already redirected
      const localePath = useLocalePath()
      const targetPath = localePath(`/${fallbackOrg.slug}/dashboard`)
      if (to.path !== targetPath) {
        return navigateTo(targetPath)
      }
    }
  }
})
