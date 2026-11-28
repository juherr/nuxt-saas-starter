// SPDX-License-Identifier: MIT
import { useServerAuth } from '~~/server/utils/auth'
import { requestWithResolvedClientIp } from '~~/server/utils/clientIp'
import { requestClientIp } from '~~/server/utils/requestClientIp'

export default defineEventHandler((event) => {
  const serverAuth = useServerAuth()
  // better-auth reads the client IP from one internal header: set it here,
  // replacing any value the client sent (#24).
  return serverAuth.handler(requestWithResolvedClientIp(toWebRequest(event), requestClientIp(event)))
})
