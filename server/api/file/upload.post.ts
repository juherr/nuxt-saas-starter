// SPDX-License-Identifier: MIT
import { readMultipartFormData } from 'h3'
import { checkUploadContent } from '~~/server/services/file/contentSniffer'
import { createFileService, useFileManagerConfig } from '~~/server/services/file/fileService'
import { RateLimitUnavailableError, UploadRateLimiter } from '~~/server/services/file/rateLimiter'
import {
  checkDeclaredBodyLength,
  MAX_FILES_PER_UPLOAD,
  maxUploadBodySize,
  resolveAllowedMimeTypes,
  resolveMaxFileSize
} from '~~/server/services/file/uploadPolicy'
import { requestClientIp } from '~~/server/utils/requestClientIp'
import { DEMO_MODE_RESTRICTED } from '~~/shared/utils/demoMode'

export default defineEventHandler(async (event) => {
  const config = useFileManagerConfig()
  const maxFileSize = resolveMaxFileSize(config.maxFileSize)
  const allowedMimeTypes = resolveAllowedMimeTypes(config.allowedMimeTypes)

  const user = await requireAuth(event)

  // The public demo stores no file: refuse before the rate limiter writes
  // to its store and before the body is read.
  if (useRuntimeConfig(event).public.demoMode) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Uploads are disabled in the demo',
      data: { code: DEMO_MODE_RESTRICTED }
    })
  }

  // Refuse before buffering: h3 reads the whole body into memory.
  const bodyLength = checkDeclaredBodyLength(
    getRequestHeader(event, 'content-length'),
    getRequestHeader(event, 'transfer-encoding'),
    maxUploadBodySize(maxFileSize)
  )
  if (!bodyLength.ok) {
    throw createError(bodyLength.statusCode === 411
      ? { statusCode: 411, statusMessage: 'Content-Length required' }
      : { statusCode: 413, statusMessage: `Upload exceeds maximum allowed size of ${formatFileSize(maxFileSize)}` })
  }

  // Counts every attempt that passes the length check, valid or not.
  if (config.uploadRateLimit) {
    const { maxUploadsPerWindow, windowSizeMinutes } = config.uploadRateLimit
    const rateLimiter = new UploadRateLimiter(windowSizeMinutes, maxUploadsPerWindow)

    let result
    try {
      result = await rateLimiter.checkAndIncrement(user.id)
    } catch (error) {
      if (error instanceof RateLimitUnavailableError) {
        throw createError({
          statusCode: 503,
          statusMessage: 'Upload temporarily unavailable, please retry later'
        })
      }
      throw error
    }

    if (!result.allowed) {
      throw createError({
        statusCode: 429,
        statusMessage: `Upload rate limit exceeded. Maximum ${maxUploadsPerWindow} uploads per ${windowSizeMinutes} minutes. Current count: ${result.currentCount}`
      })
    }
  }

  const formData = await readMultipartFormData(event)
  if (!formData) {
    throw createError({
      statusCode: 400,
      statusMessage: 'No files provided'
    })
  }

  const validFiles = formData.filter(
    (part): part is typeof part & { filename: string } => Boolean(part.data && part.filename)
  )
  if (validFiles.length > MAX_FILES_PER_UPLOAD) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Only one file can be uploaded at a time'
    })
  }
  const fileData = validFiles[0]
  if (!fileData) {
    throw createError({
      statusCode: 400,
      statusMessage: 'No files provided'
    })
  }

  const fileSize = fileData.data.length

  // Validate file size
  if (fileSize > maxFileSize) {
    throw createError({
      statusCode: 413,
      statusMessage: `File size exceeds maximum allowed size of ${formatFileSize(maxFileSize)}`
    })
  }

  // The declared type is client input: the bytes decide.
  const content = checkUploadContent(fileData.type, fileData.data, allowedMimeTypes)
  if (!content.ok) {
    throw createError({
      statusCode: 415,
      statusMessage: 'File type is not allowed or does not match its content.'
    })
  }

  const fileService = await createFileService()

  try {
    const file = await fileService.uploadFile(
      fileData.data,
      fileData.filename,
      content.type,
      user.id,
      requestClientIp(event),
      getHeader(event, 'user-agent')
    )
    return {
      success: true,
      file
    }
  } catch (error) {
    // An h3 error was raised on purpose: its status and message are public.
    if ((error as { statusCode?: number }).statusCode) {
      throw error
    }
    console.error('[file/upload]', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Upload failed'
    })
  }
})
