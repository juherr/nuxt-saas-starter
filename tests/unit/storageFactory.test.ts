// SPDX-License-Identifier: MIT
import type { FileManagerConfig } from '~~/server/services/file/types'
import { describe, expect, it } from 'vitest'
import { createStorageProvider } from '~~/server/services/file/storage/factory'

const s3Storage = (s3: NonNullable<FileManagerConfig['storage']['s3']>): FileManagerConfig['storage'] => ({
  provider: 's3',
  s3
})

const completeS3 = {
  region: 'eu-west-3',
  endpoint: '',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  bucketName: 'uploads',
  publicUrl: ''
}

describe('createStorageProvider', () => {
  it('creates the s3 provider when its settings are complete', async () => {
    const provider = await createStorageProvider(s3Storage(completeS3))

    expect(provider.name).toBe('s3')
  })

  it('names the runtime variables an s3 setup is missing', async () => {
    await expect(createStorageProvider(s3Storage({ ...completeS3, accessKeyId: '', bucketName: '' })))
      .rejects
      .toThrow('S3 storage is missing NUXT_FILE_MANAGER_STORAGE_S3_ACCESS_KEY_ID, NUXT_FILE_MANAGER_STORAGE_S3_BUCKET_NAME')
  })
})

describe('the variable a storage needs before its files get a browser URL', () => {
  const r2 = (publicUrl: string): FileManagerConfig['storage'] => ({
    provider: 'r2',
    r2: { accountId: 'account', accessKeyId: 'access-key', secretAccessKey: 'secret-key', bucketName: 'uploads', publicUrl }
  })

  it.each([
    ['s3 without a public URL', s3Storage(completeS3), 'NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL'],
    ['s3 with a public URL', s3Storage({ ...completeS3, publicUrl: 'https://cdn.example.test' }), undefined],
    ['r2 without a public URL', r2(''), 'NUXT_FILE_MANAGER_STORAGE_R2_PUBLIC_URL'],
    ['r2 with a public URL', r2('https://files.example.test'), undefined],
    ['s3 with a blank public URL', s3Storage({ ...completeS3, publicUrl: '   ' }), 'NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL'],
    ['s3 with a public URL without a scheme', s3Storage({ ...completeS3, publicUrl: 'cdn.example.test' }), 'NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL'],
    ['s3 with a public URL that does not parse', s3Storage({ ...completeS3, publicUrl: 'https://' }), 'NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL'],
    ['r2 with a public URL that is not http(s)', r2('javascript:alert(1)'), 'NUXT_FILE_MANAGER_STORAGE_R2_PUBLIC_URL'],
    ['r2 with a public URL wrapped in spaces', r2('  https://files.example.test  '), undefined],
    ['s3 with a public URL carrying a query string', s3Storage({ ...completeS3, publicUrl: 'https://cdn.example.test/files?v=1' }), 'NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL'],
    ['s3 with a public URL ending with an empty query', s3Storage({ ...completeS3, publicUrl: 'https://cdn.example.test/?' }), 'NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL'],
    ['r2 with a public URL carrying a fragment', r2('https://files.example.test/#top'), 'NUXT_FILE_MANAGER_STORAGE_R2_PUBLIC_URL'],
    ['r2 with a public URL ending with an empty fragment', r2('https://files.example.test#'), 'NUXT_FILE_MANAGER_STORAGE_R2_PUBLIC_URL'],
    ['s3 with a public URL with a path prefix', s3Storage({ ...completeS3, publicUrl: 'https://cdn.example.test/files' }), undefined],
    ['local storage', { provider: 'local', local: { uploadDir: './uploads', publicPath: '/uploads' } } as FileManagerConfig['storage'], undefined]
  ])('%s', async (_label, config, variable) => {
    const provider = await createStorageProvider(config)

    expect(provider.missingPublicUrlVariable).toBe(variable)
  })

  it('builds file URLs from the trimmed public URL', async () => {
    const provider = await createStorageProvider(r2('  https://files.example.test  '))

    expect(provider.getUrl('avatar.png')).toBe('https://files.example.test/avatar.png')
  })

  it('does not build file URLs from a public URL it refuses', async () => {
    const provider = await createStorageProvider(s3Storage({ ...completeS3, publicUrl: '   ' }))

    expect(provider.getUrl('avatar.png')).toBe('https://uploads.s3.amazonaws.com/avatar.png')
  })
})
