// SPDX-License-Identifier: MIT
import type { Buffer } from 'node:buffer'
import type { DetectedType } from './contentSniffer'
import type { FileManagerConfig, StorageProvider } from './types'
import { and, desc, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { file as fileTable } from '~~/server/db/schema'
import { logAuditEvent } from '~~/server/utils/auditLogger'
import { buildStorageName, sanitizeDisplayName } from './fileNames'
import { createStorageProvider } from './storage/factory'

export const useFileManagerConfig = (): FileManagerConfig => {
  // The generated server runtime config type infers `provider: string` and
  // drops the optional keys, so narrow it to the shape that
  // generateRuntimeConfig() checks with `satisfies FileManagerConfig`.
  const config = useRuntimeConfig().fileManager as FileManagerConfig | undefined
  if (!config) {
    throw createError({
      statusCode: 500,
      statusMessage: 'File manager configuration not found'
    })
  }
  return config
}

const getFileTypeFromMimeType = (mimeType: string) => {
  if (mimeType.startsWith('image/'))
    return 'image'
  if (mimeType.startsWith('video/'))
    return 'video'
  if (mimeType.startsWith('audio/'))
    return 'audio'
  if (mimeType.startsWith('text'))
    return 'text'
  if (mimeType.startsWith('application/'))
    return 'application'
  return 'other'
}

export class FileService {
  private storage: StorageProvider
  private now: () => Date

  constructor(storage: StorageProvider, now: () => Date = () => new Date()) {
    this.storage = storage
    this.now = now
  }

  /**
   * Stores `fileBuffer` under `yyyy-MM-dd/<uuidv7>.<extension>`, from the
   * detected type. The client filename is kept only as display metadata.
   */
  async uploadFile(
    fileBuffer: Buffer,
    clientFileName: string,
    detectedType: DetectedType,
    uploadedBy?: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<FileRecord> {
    // 503, not 500: a server-side setting the client cannot fix, and uploads
    // stay unavailable until the operator sets it; the upload route masks a
    // 500's message but passes this one through.
    const missingVariable = this.storage.missingPublicUrlVariable
    if (missingVariable) {
      throw createError({
        statusCode: 503,
        statusMessage: `File uploads are disabled: the file storage has no public URL. Set ${missingVariable} on the server.`
      })
    }

    const db = await useDB()
    const fileId = uuidv7()
    const fileName = buildStorageName(this.now(), uuidv7(), detectedType.extension)
    const originalName = sanitizeDisplayName(clientFileName)
    const { mimeType } = detectedType
    const fileType = getFileTypeFromMimeType(mimeType)

    try {
      const { path, url } = await this.storage.upload(fileBuffer, fileName, mimeType)

      const fileData = {
        id: fileId,
        originalName,
        fileName,
        mimeType,
        fileType,
        size: fileBuffer.length,
        path,
        url,
        storageProvider: this.storage.name,
        uploadedBy,
        isActive: true
      }

      const [fileRecord] = await db.insert(fileTable).values(fileData).returning()
      if (!fileRecord) {
        throw createError({
          statusCode: 500,
          message: 'Failed to create file record'
        })
      }

      await logAuditEvent({
        userId: uploadedBy,
        category: 'file',
        action: 'upload',
        targetType: 'file',
        targetId: fileRecord.id,
        ipAddress,
        userAgent,
        status: 'success',
        details: JSON.stringify({
          originalName,
          fileName,
          mimeType,
          size: formatFileSize(fileBuffer.length),
          storageProvider: this.storage.name
        })
      })

      return fileRecord
    } catch (error) {
      await logAuditEvent({
        userId: uploadedBy,
        category: 'file',
        action: 'upload',
        targetType: 'file',
        ipAddress,
        userAgent,
        status: 'failure',
        details: JSON.stringify({
          originalName,
          mimeType,
          size: formatFileSize(fileBuffer.length),
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      })
      throw error
    }
  }

  async getFile(id: string): Promise<FileRecord | null> {
    const db = await useDB()
    try {
      const [fileRecord] = await db.select().from(fileTable).where(eq(fileTable.id, id)).limit(1)
      return fileRecord || null
    } catch {
      return null
    }
  }

  async deleteFile(id: string, userId?: string, ipAddress?: string, userAgent?: string): Promise<boolean> {
    const db = await useDB()
    const file = await this.getFile(id)

    if (!file) {
      return false
    }

    const audit = (status: 'success' | 'failure', error?: unknown) => logAuditEvent({
      userId,
      category: 'file',
      action: 'delete',
      targetType: 'file',
      targetId: id,
      ipAddress,
      userAgent,
      status,
      details: JSON.stringify({
        originalName: file.originalName,
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : 'Unknown error' })
      })
    })

    // A stored file that is already gone counts as deleted (the providers
    // ignore a missing file); any other failure keeps the row so that the
    // deletion can be retried instead of orphaning the stored bytes.
    try {
      await this.storage.delete(file.path)
    } catch (error) {
      await audit('failure', error)
      throw error
    }

    await db.delete(fileTable).where(eq(fileTable.id, id))
    await audit('success')

    return true
  }

  async getFilesByUser(userId: string, limit = 50, offset = 0): Promise<FileRecord[]> {
    const db = await useDB()
    return await db.select()
      .from(fileTable)
      .where(and(eq(fileTable.uploadedBy, userId), eq(fileTable.isActive, true)))
      .orderBy(desc(fileTable.createdAt))
      .limit(limit)
      .offset(offset)
  }
}

/**
 * Builds a FileService on the storage provider the runtime configuration
 * selects. Throws when that configuration is missing or incomplete.
 */
export const createFileService = async (): Promise<FileService> =>
  new FileService(await createStorageProvider(useFileManagerConfig().storage))
