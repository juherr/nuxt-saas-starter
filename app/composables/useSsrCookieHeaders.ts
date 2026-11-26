// SPDX-License-Identifier: MIT
import type { SsrFetchHooks } from '~/utils/ssrCookies'
import { ssrCookieHeaders, ssrFetchHooks } from '~/utils/ssrCookies'

/**
 * Cookie header for a `$fetch` to the app's own API, in place of `useRequestHeaders(['cookie'])`:
 * during SSR it carries the cookies set by earlier in-process calls of the render (e.g.
 * `setActive`); in the browser it returns no header, as `useRequestHeaders` does. Call it where
 * `useRequestHeaders` could be called (inside the Nuxt context).
 */
export function useSsrCookieHeaders(): Record<string, string> {
  if (import.meta.client)
    return {}
  return ssrCookieHeaders(useRequestEvent())
}

/**
 * Hooks for an SSR `$fetch`/`useFetch` to the app's own API, in place of `useSsrCookieHeaders()`:
 * the cookie of the jar goes out with the request, and the `Set-Cookie` of the response reaches
 * the browser and the later calls of the render. In the browser it returns no hook. Call it where
 * `useRequestEvent` could be called (inside the Nuxt context).
 */
export function useSsrFetchHooks(): SsrFetchHooks {
  if (import.meta.client)
    return {}
  return ssrFetchHooks(useRequestEvent())
}
