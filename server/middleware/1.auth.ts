// SPDX-License-Identifier: MIT
import { requireAuth } from '~~/server/utils/auth'
import { isSystemAdmin } from '~~/shared/utils/permissions'

export default defineEventHandler(async (event) => {
  const path = event.path

  if (path?.startsWith('/api/admin')) {
    const user = await requireAuth(event)
    if (!isSystemAdmin(user.role)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        message: 'Admin access required.'
      })
    }
  }
})
