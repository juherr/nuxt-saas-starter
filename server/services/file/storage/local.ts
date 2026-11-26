// SPDX-License-Identifier: MIT
import type { Buffer } from 'node:buffer'
import type { StorageProvider } from '../types'
import { constants, promises as fs } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

const outsideError = () => new Error('Storage path is outside the upload directory')

/** Open flags for a new file; fails on an existing name or a link there. */
const CREATE_NEW_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

/**
 * Absolute path of `path` inside `directory`.
 *
 * @throws {Error} when `path` resolves to the directory itself or outside it.
 */
const resolveInside = (directory: string, path: string): string => {
  const root = resolve(directory)
  const filePath = resolve(root, path)
  if (!filePath.startsWith(root + sep)) {
    throw outsideError()
  }
  return filePath
}

/**
 * Real path of `path` with every link resolved. A missing tail is appended
 * to the real path of its closest existing parent; a link whose target is
 * missing has no real path and is refused.
 */
const realPathOf = async (path: string): Promise<string> => {
  try {
    return await fs.realpath(path)
  } catch (error) {
    const parent = dirname(path)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) {
      throw error
    }
    if (await fs.lstat(path).then(() => true, () => false)) {
      throw outsideError()
    }
    return join(await realPathOf(parent), basename(path))
  }
}

/**
 * Like {@link resolveInside}, and also refuses a path that symbolic links
 * lead outside the real upload directory.
 *
 * @throws {Error} when `path` or the file it leads to is outside the directory.
 */
export const resolveRealInside = async (directory: string, path: string): Promise<string> => {
  const filePath = resolveInside(directory, path)
  const [root, real] = await Promise.all([realPathOf(resolve(directory)), realPathOf(filePath)])
  if (!real.startsWith(root + sep)) {
    throw outsideError()
  }
  return filePath
}

export class LocalStorageProvider implements StorageProvider {
  name = 'local'
  // Served by the app itself under its public path.
  readonly missingPublicUrlVariable = undefined
  private uploadDir: string
  private publicPath: string

  constructor(uploadDir: string, publicPath: string) {
    this.uploadDir = uploadDir
    this.publicPath = publicPath
  }

  async upload(file: Buffer, fileName: string): Promise<{ path: string, url?: string }> {
    const filePath = await resolveRealInside(this.uploadDir, fileName)

    await fs.mkdir(dirname(filePath), { recursive: true })
    // The directory may have been swapped for a link since the first check.
    await resolveRealInside(this.uploadDir, fileName)

    // Storage names are unique per upload (FileService: date + UUIDv7), so
    // the final name must not exist yet, and a link planted there is never
    // followed.
    const handle = await fs.open(filePath, CREATE_NEW_NO_FOLLOW)
    try {
      await handle.writeFile(file)
    } finally {
      await handle.close()
    }

    return {
      path: fileName,
      url: `${this.publicPath}/${fileName}`
    }
  }

  async delete(path: string): Promise<void> {
    const filePath = await resolveRealInside(this.uploadDir, path)
    try {
      await fs.unlink(filePath)
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        throw error
      }
    }
  }

  getUrl(path: string): string {
    return `${this.publicPath}/${path}`
  }

  /** @throws {Error} when `path` is outside the upload directory. */
  async exists(path: string): Promise<boolean> {
    const filePath = await resolveRealInside(this.uploadDir, path)
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }
}
