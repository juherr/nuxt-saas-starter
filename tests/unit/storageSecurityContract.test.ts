// SPDX-License-Identifier: MIT
import type { StorageProvider } from '~~/server/services/file/types'
import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileService } from '~~/server/services/file/fileService'
import { locateLocalUpload } from '~~/server/services/file/localServing'
import { LocalStorageProvider } from '~~/server/services/file/storage/local'
import { S3CompatibleStorageProvider } from '~~/server/services/file/storage/s3-compatible'
import { stubNitroGlobals } from './support/nitroGlobals'

vi.mock('~~/server/utils/auditLogger', () => ({ logAuditEvent: vi.fn() }))

const PNG = { mimeType: 'image/png', extension: 'png' }
const PDF = { mimeType: 'application/pdf', extension: 'pdf' }
const STORAGE_NAME = /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|pdf)$/

interface ServedHeaders {
  'Content-Type'?: string | null
  'Content-Disposition'?: string | null
}

interface Subject {
  provider: StorageProvider
  /** Headers a client receives for the stored `path`. */
  served: (path: string) => Promise<ServedHeaders | undefined>
  /** Paths written so far, relative to the storage root. */
  written: () => Promise<string[]>
  cleanup: () => Promise<void>
}

async function local(): Promise<Subject> {
  const root = await mkdtemp(join(tmpdir(), 'nss-storage-contract-'))
  const uploadDir = join(root, 'uploads')
  return {
    provider: new LocalStorageProvider(uploadDir, '/uploads'),
    served: async (path) => {
      const headers = (await locateLocalUpload(uploadDir, path))?.headers
      return headers && { 'Content-Type': headers['Content-Type'], 'Content-Disposition': headers['Content-Disposition'] }
    },
    written: async () => (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => join(entry.parentPath, entry.name).slice(uploadDir.length + 1)),
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

async function s3Compatible(): Promise<Subject> {
  const requests: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
    requests.push(request)
    return new Response(null, { status: 200 })
  }))
  const prefix = 'https://storage.test/bucket/'
  const puts = () => requests.filter(request => request.method === 'PUT')
  return {
    provider: new S3CompatibleStorageProvider({
      provider: 's3',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      bucketName: 'bucket',
      endpoint: 'https://storage.test',
      // Without one, FileService refuses every upload (#120).
      publicUrl: 'https://cdn.test'
    }),
    served: async (path) => {
      const put = puts().find(request => request.url === prefix + path)
      return put && {
        'Content-Type': put.headers.get('content-type'),
        'Content-Disposition': put.headers.get('content-disposition')
      }
    },
    written: async () => requests.map(request => request.url.startsWith(prefix) ? request.url.slice(prefix.length) : request.url),
    cleanup: async () => {}
  }
}

const outside = [
  ['a parent directory', '../escape.png'],
  ['a nested parent directory', '2026-03-02/../../escape.png'],
  ['an absolute path', '/etc/hosts'],
  ['the root itself', '.']
]

// The title is the acceptance criterion of the issue, word for word.
// eslint-disable-next-line test/prefer-lowercase-title
describe('Local and S3-compatible storage pass the same security contract', () => {
  beforeAll(() => {
    stubNitroGlobals()
    vi.stubGlobal('formatFileSize', (bytes: number) => `${bytes} B`)
    vi.stubGlobal('useDB', async () => ({
      insert: () => ({ values: (values: Record<string, unknown>) => ({ returning: async () => [values] }) })
    }))
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  describe.each([
    ['local', local],
    ['S3-compatible', s3Compatible]
  ])('%s storage', (_name, create) => {
    let subject: Subject

    beforeEach(async () => {
      subject = await create()
    })
    afterEach(async () => {
      await subject.cleanup()
    })

    const store = (clientName: string, type = PNG) =>
      new FileService(subject.provider).uploadFile(Buffer.from('data'), clientName, type, 'u1')

    it('never derives the storage key from the client filename', async () => {
      const record = await store('../../outside/avatar.html')

      expect(record.path).toMatch(STORAGE_NAME)
      expect(await subject.written()).toEqual([record.path])
    })

    it.each(outside)('refuses to write %s', async (_label, path) => {
      await expect(subject.provider.upload(Buffer.from('data'), path!, 'image/png')).rejects.toThrow()
      expect(await subject.written()).toEqual([])
    })

    it.each(outside)('refuses to delete %s', async (_label, path) => {
      await expect(subject.provider.delete(path!)).rejects.toThrow()
      expect(await subject.written()).toEqual([])
    })

    it.each(outside)('refuses to check %s', async (_label, path) => {
      await expect(subject.provider.exists(path!)).rejects.toThrow()
      expect(await subject.written()).toEqual([])
    })

    it('serves an image with its detected type, inline', async () => {
      const record = await store('photo.gif', PNG)

      expect(await subject.served(record.path)).toEqual({ 'Content-Type': 'image/png', 'Content-Disposition': 'inline' })
    })

    it('serves any other type with its detected type, as an attachment', async () => {
      const record = await store('report.html', PDF)

      expect(await subject.served(record.path)).toEqual({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment'
      })
    })
  })
})
