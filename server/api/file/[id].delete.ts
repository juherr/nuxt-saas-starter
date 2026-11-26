// SPDX-License-Identifier: MIT
import { createFileService } from '~~/server/services/file/fileService'
import { hasRole } from '~~/shared/utils/permissions'

const fileNotFound = () => createError({ statusCode: 404, statusMessage: 'File not found' })

/**
 * Deletes a file its caller uploaded, or any file for an admin. An unknown
 * file and another user's file get the same 404, so that file ids cannot be
 * probed.
 */
export default defineEventHandler(async (event) => {
  const user = await requireAuth(event)
  const fileId = getRouterParam(event, 'id')

  if (!fileId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'File ID is required'
    })
  }
  const fileService = await createFileService()

  const file = await fileService.getFile(fileId)

  if (!file || (file.uploadedBy !== user.id && !hasRole(user.role, 'admin'))) {
    throw fileNotFound()
  }

  let deleted: boolean
  try {
    deleted = await fileService.deleteFile(
      fileId,
      user.id,
      getRequestIP(event),
      getHeader(event, 'user-agent')
    )
  } catch (error) {
    console.error('[file/delete]', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'File deletion failed'
    })
  }

  return {
    success: deleted,
    message: deleted ? 'File deleted successfully' : 'File not found'
  }
})
