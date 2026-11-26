// SPDX-License-Identifier: MIT
import type { Buffer } from 'node:buffer'
import type { StorageProvider } from '../types'
import { AwsClient } from 'aws4fetch'
import { contentDisposition } from '../servingHeaders'

// eslint-disable-next-line no-control-regex
const UNSAFE_KEY_CHARACTERS = /[\\\u0000-\u001F\u007F]/

/**
 * Object key `key` unchanged when every segment is a plain name, so the
 * request URL cannot be normalized out of the bucket.
 *
 * @throws {Error} on an empty key, a leading `/`, a backslash, a control
 * character, or an empty, `.` or `..` segment.
 */
export const assertStorageKey = (key: string): string => {
  const unsafe = UNSAFE_KEY_CHARACTERS.test(key)
    || key.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  if (unsafe) {
    throw new Error('Storage key is outside the bucket')
  }
  return key
}

// Runtime variable that sets each provider's public URL
const PUBLIC_URL_VARIABLES = {
  s3: 'NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL',
  r2: 'NUXT_FILE_MANAGER_STORAGE_R2_PUBLIC_URL'
} as const

export class S3CompatibleStorageProvider implements StorageProvider {
  name = ''
  readonly missingPublicUrlVariable: string | undefined
  private client: AwsClient | null = null
  private bucketName: string
  private publicUrl?: string
  private provider: 's3' | 'r2'
  private config: any
  private endpoint = ''

  constructor(config: {
    provider: 's3' | 'r2'
    region?: string
    accountId?: string
    accessKeyId: string
    secretAccessKey: string
    bucketName: string
    publicUrl?: string
    endpoint?: string
  }) {
    this.provider = config.provider
    this.bucketName = config.bucketName
    this.publicUrl = config.publicUrl
    this.config = config
    // The bucket hostname getUrl() falls back to is not public by default.
    this.missingPublicUrlVariable = config.publicUrl
      ? undefined
      : PUBLIC_URL_VARIABLES[config.provider]
    if (this.provider === 'r2') {
      this.name = 's3-r2'
    } else if (this.provider === 's3') {
      this.name = 's3'
    } else {
      this.name = 's3-compatible'
    }
  }

  private initializeClient() {
    if (this.client) {
      return
    }

    let region: string

    if (this.config.provider === 'r2') {
      if (!this.config.accountId) {
        throw new Error('Account ID is required for R2 storage')
      }
      this.endpoint = `https://${this.config.accountId}.r2.cloudflarestorage.com`
      region = 'auto'
    } else {
      this.endpoint = this.config.endpoint || 'https://s3.amazonaws.com'
      region = this.config.region || 'us-east-1'
    }

    this.client = new AwsClient({
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region,
      service: 's3'
    })
  }

  private ensureInitialized() {
    if (!this.client) {
      this.initializeClient()
    }
  }

  private objectUrl(key: string) {
    return `${this.endpoint}/${this.bucketName}/${assertStorageKey(key)}`
  }

  /** Stores `file` with its detected `mimeType` and the matching disposition. */
  async upload(file: Buffer, fileName: string, mimeType: string): Promise<{ path: string, url?: string }> {
    this.ensureInitialized()

    const url = this.objectUrl(fileName)

    const response = await this.client!.fetch(url, {
      method: 'PUT',
      body: new Uint8Array(file),
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': contentDisposition(mimeType)
      }
    })

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`)
    }

    return {
      path: fileName,
      url: this.publicUrl ? `${this.publicUrl}/${fileName}` : undefined
    }
  }

  async delete(path: string): Promise<void> {
    this.ensureInitialized()

    const url = this.objectUrl(path)

    const response = await this.client!.fetch(url, {
      method: 'DELETE'
    })

    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete failed: ${response.status} ${response.statusText}`)
    }
  }

  getUrl(path: string): string {
    if (this.publicUrl) {
      return `${this.publicUrl}/${path}`
    }

    if (this.provider === 'r2') {
      return `https://${this.bucketName}.r2.dev/${path}`
    }

    return `https://${this.bucketName}.s3.amazonaws.com/${path}`
  }

  /** @throws {Error} when `path` is not a safe object key. */
  async exists(path: string): Promise<boolean> {
    this.ensureInitialized()
    const url = this.objectUrl(path)

    try {
      const response = await this.client!.fetch(url, {
        method: 'HEAD'
      })

      return response.ok
    } catch {
      return false
    }
  }
}
