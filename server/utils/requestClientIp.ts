// SPDX-License-Identifier: MIT
import type { H3Event } from 'h3'
import type { ClientIpConfig } from '~~/server/utils/clientIp'
import { parseClientIpConfig, resolveClientIp } from '~~/server/utils/clientIp'

let cached: { key: string, config: ClientIpConfig } | undefined

function clientIpConfig(event: H3Event): ClientIpConfig {
  const { trustedProxies, clientIpHeader } = useRuntimeConfig(event)
  const key = JSON.stringify([trustedProxies, clientIpHeader])
  if (cached?.key !== key) {
    const { config, invalid } = parseClientIpConfig({ trustedProxies, clientIpHeader })
    if (invalid.length > 0) {
      console.warn(`[clientIp] Ignoring invalid NUXT_TRUSTED_PROXIES entries: ${invalid.join(', ')}`)
    }
    cached = { key, config }
  }
  return cached.config
}

/**
 * `event.context` key holding the IP resolved for the request (`null` when
 * none), set by `server/middleware/0.client-ip.ts`.
 */
export const CLIENT_IP_CONTEXT_KEY = 'resolvedClientIp'

/**
 * The IP an in-process sub-request inherits from the request that made it,
 * or `undefined` when the event is not such a sub-request.
 *
 * `event.$fetch` (SSR `useFetch`, `useRequestFetch`) dispatches through
 * node-mock-http: the inner socket has no address and the outer headers are
 * forwarded, but `req.__unenv__` holds the outer `event.context` (h3
 * `fetchWithEvent`). The client controls neither that object nor the key.
 */
function inheritedClientIp(event: H3Event): { ip: string | undefined } | undefined {
  const req = event.node?.req
  const outer: unknown = req && '__unenv__' in req ? req.__unenv__ : undefined
  if (typeof outer !== 'object' || outer === null || !(CLIENT_IP_CONTEXT_KEY in outer)) {
    return undefined
  }
  const ip: unknown = Reflect.get(outer, CLIENT_IP_CONTEXT_KEY)
  return { ip: typeof ip === 'string' ? ip : undefined }
}

/**
 * The client IP of the request, from the socket address unless
 * `NUXT_TRUSTED_PROXIES` or `NUXT_CLIENT_IP_HEADER` say otherwise
 * (`server/utils/clientIp.ts`). An in-process sub-request takes the IP its
 * outer request resolved, never its forwarded headers.
 */
export function requestClientIp(event: H3Event): string | undefined {
  const inherited = inheritedClientIp(event)
  if (inherited) {
    return inherited.ip
  }
  return resolveClientIp({
    socketAddress: getRequestIP(event),
    header: name => getRequestHeader(event, name)
  }, clientIpConfig(event))
}
