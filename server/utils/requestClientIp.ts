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
 * The client IP of the request, from the socket address unless
 * `NUXT_TRUSTED_PROXIES` or `NUXT_CLIENT_IP_HEADER` say otherwise
 * (`server/utils/clientIp.ts`).
 */
export function requestClientIp(event: H3Event): string | undefined {
  return resolveClientIp({
    socketAddress: getRequestIP(event),
    header: name => getRequestHeader(event, name)
  }, clientIpConfig(event))
}
