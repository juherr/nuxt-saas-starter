// SPDX-License-Identifier: MIT
import type { SsrFetchHooks } from '~/utils/ssrCookies'
import { ssrFetchHooks } from '~/utils/ssrCookies'

/**
 * Hooks for an SSR `$fetch`/`useFetch` to the app's own API, in place of
 * `useRequestHeaders(['cookie'])`: the cookie of the jar goes out with the request, and the
 * `Set-Cookie` of the response reaches the browser and the later calls of the render. In the
 * browser it returns no hook. Call it where `useRequestEvent` could be called (inside the Nuxt
 * context).
 */
export function useSsrFetchHooks(): SsrFetchHooks {
  if (import.meta.client)
    return {}
  return ssrFetchHooks(useRequestEvent())
}
