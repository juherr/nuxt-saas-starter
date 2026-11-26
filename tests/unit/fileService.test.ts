// SPDX-License-Identifier: MIT
import type { StorageProvider } from '~~/server/services/file/types'
import type { FileRecord } from '~~/shared/utils/types'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_DISPLAY_NAME_LENGTH } from '~~/server/services/file/fileNames'
import { FileService } from '~~/server/services/file/fileService'
import { logAuditEvent } from '~~/server/utils/auditLogger'
import { stubNitroGlobals } from './support/nitroGlobals'

vi.mock('~~/server/utils/auditLogger', () => ({ logAuditEvent: vi.fn() }))

const insertedValues = vi.fn()
const deletedRows = vi.fn()
const useDB = vi.fn(async () => ({
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      insertedValues(values)
      return { returning: async () => [values] }
    }
  }),
  delete: () => ({ where: async (condition: unknown) => deletedRows(condition) })
}))

beforeAll(() => {
  stubNitroGlobals()
  vi.stubGlobal('formatFileSize', (bytes: number) => `${bytes} B`)
  vi.stubGlobal('useDB', useDB)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const PNG = { mimeType: 'image/png', extension: 'png' }
const STORAGE_NAME = /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

function storage(missingPublicUrlVariable?: string) {
  const upload = vi.fn<StorageProvider['upload']>(async (_file, name) => ({ path: name, url: `/uploads/${name}` }))
  const provider: StorageProvider = {
    name: 'test',
    missingPublicUrlVariable,
    upload: async (file, name, type) => upload(file, name, type),
    delete: vi.fn(),
    getUrl: name => `/uploads/${name}`,
    exists: vi.fn()
  }
  return { provider, upload }
}

describe('fileService.uploadFile', () => {
  beforeEach(() => {
    insertedValues.mockReset()
    useDB.mockClear()
    vi.mocked(logAuditEvent).mockReset()
  })

  it('refuses with 503 naming the variable before storing when the storage has no public URL', async () => {
    const { provider, upload } = storage('NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL')

    const error = await new FileService(provider).uploadFile(Buffer.from('data'), 'a.png', PNG, 'u1').catch((e: unknown) => e)

    expect(error).toMatchObject({ statusCode: 503 })
    expect((error as Error).message).toContain('NUXT_FILE_MANAGER_STORAGE_S3_PUBLIC_URL')
    expect(upload).not.toHaveBeenCalled()
    expect(useDB).not.toHaveBeenCalled()
    expect(insertedValues).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('stores the file and keeps its URL when the storage has a public URL', async () => {
    const { provider, upload } = storage()

    await new FileService(provider).uploadFile(Buffer.from('data'), 'a.png', PNG, 'u1')

    const storedName = upload.mock.calls[0]![1]
    expect(insertedValues).toHaveBeenCalledWith(expect.objectContaining({ url: `/uploads/${storedName}` }))
  })

  it.each([
    ['a parent directory path', '../../outside/avatar.png'],
    ['a NUL byte', 'avatar.png\u0000.html'],
    ['a very long name', `${'x'.repeat(5000)}.png`],
    ['another extension', 'avatar.html']
  ])('keeps a filename with %s out of the storage path', async (_label, filename) => {
    const { provider, upload } = storage()

    await new FileService(provider).uploadFile(Buffer.from('data'), filename, PNG, 'u1')

    const storedName = upload.mock.calls[0]![1]
    expect(storedName).toMatch(STORAGE_NAME)
    expect(insertedValues).toHaveBeenCalledWith(expect.objectContaining({ fileName: storedName, path: storedName }))
  })

  it('keeps the original name as display metadata only, sanitized and bounded', async () => {
    const { provider } = storage()

    await new FileService(provider).uploadFile(Buffer.from('data'), `../a\u0000${'b'.repeat(400)}.png`, PNG, 'u1')

    const { originalName } = insertedValues.mock.calls[0]![0]
    expect(originalName).toHaveLength(MAX_DISPLAY_NAME_LENGTH)
    expect(originalName).toMatch(/^ab+$/)
  })

  it('stores the detected type', async () => {
    const { provider, upload } = storage()

    await new FileService(provider).uploadFile(Buffer.from('data'), 'avatar.gif', PNG, 'u1')

    expect(upload.mock.calls[0]![2]).toBe('image/png')
    expect(insertedValues).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/png' }))
  })

  it('dates the storage folder in UTC whatever the server time zone', async () => {
    vi.stubEnv('TZ', 'America/New_York')
    const { provider, upload } = storage()
    // 22:00 on March 1st in New York.
    const now = () => new Date('2026-03-02T03:00:00Z')

    await new FileService(provider, now).uploadFile(Buffer.from('data'), 'a.png', PNG, 'u1')

    expect(upload.mock.calls[0]![1]).toMatch(/^2026-03-02\//)
    vi.unstubAllEnvs()
  })
})

describe('fileService.deleteFile', () => {
  const FILE = { id: 'f1', path: '2026-03-02/abc.png', originalName: 'a.png', fileName: '2026-03-02/abc.png', mimeType: 'image/png', size: 4 }

  beforeEach(() => {
    deletedRows.mockReset()
    vi.mocked(logAuditEvent).mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function serviceWith(deleteImpl: StorageProvider['delete']) {
    const { provider } = storage()
    provider.delete = vi.fn(deleteImpl)
    const service = new FileService(provider)
    vi.spyOn(service, 'getFile').mockResolvedValue(FILE as FileRecord)
    return { service, provider }
  }

  it('removes the row and records a success once the stored file is gone', async () => {
    const { service, provider } = serviceWith(async () => {})

    await expect(service.deleteFile('f1', 'u1')).resolves.toBe(true)

    expect(provider.delete).toHaveBeenCalledWith(FILE.path)
    expect(deletedRows).toHaveBeenCalledTimes(1)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', targetId: 'f1', status: 'success' }))
  })

  it('keeps the row, records a failure and rethrows when the storage cannot delete', async () => {
    const failure = new Error('EACCES: permission denied')
    const { service } = serviceWith(async () => {
      throw failure
    })

    await expect(service.deleteFile('f1', 'u1')).rejects.toBe(failure)

    expect(deletedRows).not.toHaveBeenCalled()
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', targetId: 'f1', status: 'failure' }))
  })
})
