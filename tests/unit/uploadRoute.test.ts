// SPDX-License-Identifier: MIT
import type { RateLimitStore } from '~~/server/services/file/rateLimiter'
import type { FileManagerConfig } from '~~/server/services/file/types'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRoute, stubNitroGlobals, stubRequestContext } from './support/nitroGlobals'

const readMultipartFormData = vi.hoisted(() => vi.fn())
const uploadFile = vi.hoisted(() => vi.fn())
const requireAuth = vi.hoisted(() => vi.fn())
const fileConfig = vi.hoisted(() => ({ value: {} as Partial<FileManagerConfig> }))
const runtimeConfig = vi.hoisted(() => ({ public: { demoMode: false } }))
const store = vi.hoisted(() => ({
  reserve: vi.fn<RateLimitStore['reserve']>(),
  read: vi.fn<RateLimitStore['read']>()
}))

vi.mock('h3', () => ({ readMultipartFormData }))
vi.mock('~~/server/services/file/fileService', () => ({
  createFileService: async () => ({ uploadFile }),
  useFileManagerConfig: () => fileConfig.value
}))
vi.mock('~~/server/services/file/rateLimitStores', () => ({
  defaultRateLimitStore: () => store
}))

beforeAll(() => {
  stubNitroGlobals()
  vi.stubGlobal('requireAuth', requireAuth)
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  stubRequestContext()
  vi.stubGlobal('formatFileSize', (bytes: number) => `${bytes} B`)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D])
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10])
const HTML = Buffer.from('<!DOCTYPE html><script>1</script>')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const MAX_FILE_SIZE = 1024
const MULTIPART = { 'content-type': 'multipart/form-data; boundary=x' }

function part(data: Buffer, type: string, filename = 'avatar.png') {
  return { name: 'file', filename, type, data }
}

async function upload(headers: Record<string, string> = { ...MULTIPART, 'content-length': '2000' }) {
  return callRoute<{ success: boolean }>(() => import('~~/server/api/file/upload.post'), undefined, undefined, undefined, headers)
}

describe('the upload endpoint', () => {
  beforeEach(() => {
    fileConfig.value = {
      maxFileSize: MAX_FILE_SIZE,
      uploadRateLimit: { maxUploadsPerWindow: 5, windowSizeMinutes: 1 }
    }
    requireAuth.mockReset().mockResolvedValue({ id: 'u1' })
    readMultipartFormData.mockReset().mockResolvedValue([part(PNG, 'image/png')])
    uploadFile.mockReset().mockResolvedValue({ id: 'f1' })
    store.reserve.mockReset().mockResolvedValue({ allowed: true, currentCount: 1 })
    runtimeConfig.public.demoMode = false
  })

  it('refuses an anonymous request before reading the body', async () => {
    requireAuth.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))

    await expect(upload()).rejects.toMatchObject({ statusCode: 401 })
    expect(readMultipartFormData).not.toHaveBeenCalled()
  })

  it('refuses every upload with 403 in the public demo, before counting or reading it', async () => {
    runtimeConfig.public.demoMode = true

    await expect(upload()).rejects.toMatchObject({ statusCode: 403, data: { code: 'DEMO_MODE_RESTRICTED' } })
    expect(store.reserve).not.toHaveBeenCalled()
    expect(readMultipartFormData).not.toHaveBeenCalled()
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('still refuses an anonymous request with 401 in the public demo', async () => {
    runtimeConfig.public.demoMode = true
    requireAuth.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))

    await expect(upload()).rejects.toMatchObject({ statusCode: 401 })
  })

  it('stores a valid image', async () => {
    await expect(upload()).resolves.toMatchObject({ success: true })
    expect(uploadFile).toHaveBeenCalledTimes(1)
  })

  describe('before buffering the body', () => {
    it('refuses a declared length above one file plus the multipart overhead with 413', async () => {
      await expect(upload({ ...MULTIPART, 'content-length': String(10 * 1024 * 1024) })).rejects.toMatchObject({ statusCode: 413 })
      expect(readMultipartFormData).not.toHaveBeenCalled()
      expect(store.reserve).not.toHaveBeenCalled()
    })

    it.each([
      ['requires a declared length (411)', { ...MULTIPART }, 411, {}],
      ['requires a declared length for a chunked body (411)', { ...MULTIPART, 'transfer-encoding': 'chunked' }, 411, {}],
      ['applies the default 5 MB limit when none is configured', { ...MULTIPART, 'content-length': String(6 * 1024 * 1024) }, 413, { maxFileSize: undefined }]
    ] as const)('%s', async (_title, headers, statusCode, config: Partial<FileManagerConfig>) => {
      fileConfig.value = { ...fileConfig.value, ...config }

      await expect(upload(headers)).rejects.toMatchObject({ statusCode })
      expect(readMultipartFormData).not.toHaveBeenCalled()
    })
  })

  describe('rate limiting', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('refuses with 429 when the limit is reached, before reading the body', async () => {
      store.reserve.mockResolvedValue({ allowed: false, currentCount: 5 })

      await expect(upload()).rejects.toMatchObject({ statusCode: 429 })
      expect(readMultipartFormData).not.toHaveBeenCalled()
    })

    it('answers 503 with a generic message when the limiter store is down', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      store.reserve.mockRejectedValue(new Error('store down'))

      const error = await upload().catch((e: unknown) => e)

      expect(error).toMatchObject({ statusCode: 503 })
      expect((error as Error).message).not.toMatch(/count|store down/i)
      expect(readMultipartFormData).not.toHaveBeenCalled()
    })

    it('counts the attempt even when the body turns out to be invalid', async () => {
      readMultipartFormData.mockResolvedValue(undefined)

      await expect(upload()).rejects.toMatchObject({ statusCode: 400 })
      expect(store.reserve).toHaveBeenCalledTimes(1)
    })
  })

  describe('when storing fails', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('answers a generic 500 without echoing an internal error', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const internal = new Error('ENOSPC: no space left on device, open \'/srv/uploads/x.png\'')
      uploadFile.mockRejectedValue(internal)

      const error = await upload().catch((e: unknown) => e)

      expect(error).toMatchObject({ statusCode: 500, statusMessage: 'Upload failed' })
      expect((error as Error).message).not.toMatch(/ENOSPC|srv/)
      expect(consoleError).toHaveBeenCalledWith('[file/upload]', internal)
    })

    it('passes an error that already carries a status through unchanged', async () => {
      const httpError = Object.assign(new Error('Service Unavailable'), { statusCode: 503, statusMessage: 'Service Unavailable' })
      uploadFile.mockRejectedValue(httpError)

      await expect(upload()).rejects.toBe(httpError)
    })

    it('answers the service\'s 503 naming the missing public URL variable, not a masked 500', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const message = 'File uploads are disabled: the file storage has no valid public URL. Set NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL on the server.'
      uploadFile.mockRejectedValue(createError({ statusCode: 503, statusMessage: message }))

      const error = await upload().catch((e: unknown) => e)

      expect(error).toMatchObject({ statusCode: 503, statusMessage: message })
      expect((error as Error).message).toBe(message)
      expect(consoleError).not.toHaveBeenCalled()
    })
  })

  describe('after parsing', () => {
    it('refuses a file above the maximum size with 413', async () => {
      readMultipartFormData.mockResolvedValue([part(Buffer.alloc(MAX_FILE_SIZE + 1), 'image/png')])

      await expect(upload()).rejects.toMatchObject({ statusCode: 413 })
      expect(uploadFile).not.toHaveBeenCalled()
    })

    it('stores the type detected from the bytes', async () => {
      await upload()

      expect(uploadFile.mock.calls[0]![2]).toEqual({ mimeType: 'image/png', extension: 'png' })
    })

    it.each([
      ['jpeg bytes', JPEG],
      ['html bytes', HTML],
      ['svg bytes', SVG]
    ])('refuses %s declared as a png with 415', async (_label, data) => {
      readMultipartFormData.mockResolvedValue([part(data, 'image/png')])

      await expect(upload()).rejects.toMatchObject({ statusCode: 415 })
      expect(uploadFile).not.toHaveBeenCalled()
    })

    it('refuses svg with 415 even when it is configured as allowed', async () => {
      fileConfig.value = { ...fileConfig.value, allowedMimeTypes: ['image/svg+xml', 'image/png'] }
      readMultipartFormData.mockResolvedValue([part(SVG, 'image/svg+xml', 'logo.svg')])

      await expect(upload()).rejects.toMatchObject({ statusCode: 415 })
      expect(uploadFile).not.toHaveBeenCalled()
    })

    it('refuses a type outside the default allowed types with 415', async () => {
      readMultipartFormData.mockResolvedValue([part(Buffer.from('%PDF-1.7'), 'application/pdf', 'doc.pdf')])

      await expect(upload()).rejects.toMatchObject({ statusCode: 415 })
      expect(uploadFile).not.toHaveBeenCalled()
    })
  })
})
