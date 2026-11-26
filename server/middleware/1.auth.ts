// SPDX-License-Identifier: MIT
import { requireAuth } from '~~/server/utils/auth'
import { hasRole } from '~~/shared/utils/permissions'

export default defineEventHandler(async (event) => {
  const path = event.path

  if (path?.startsWith('/api/admin')) {
    const user = await requireAuth(event)
    if (!hasRole(user.role, 'admin')) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        message: 'Admin access required.'
      })
    }
  }
})
