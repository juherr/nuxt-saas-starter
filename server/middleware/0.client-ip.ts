// SPDX-License-Identifier: MIT
import { CLIENT_IP_CONTEXT_KEY, requestClientIp } from '~~/server/utils/requestClientIp'

/**
 * Records the client IP of every request in `event.context`, so an
 * in-process sub-request it makes (SSR `useFetch('/api/auth/get-session')`)
 * keys better-auth's rate limit on the same client (#24).
 */
export default defineEventHandler((event) => {
  event.context[CLIENT_IP_CONTEXT_KEY] = requestClientIp(event) ?? null
})
