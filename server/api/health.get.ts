// SPDX-License-Identifier: MIT
import { sql } from 'drizzle-orm'
import { getDB } from '~~/server/utils/db'
import { isDatabaseConfigured } from '~~/server/utils/drivers'
import { isSchemaReady, SCHEMA_NOT_READY_MESSAGE, SCHEMA_READINESS_SQL } from '~~/server/utils/schemaReadiness'

// Bounds the probe: the shared pg pool sets no connection timeout, so an
// unreachable database would otherwise keep the request open indefinitely.
const DATABASE_CHECK_TIMEOUT_MS = 2000

const checkDatabase = async (): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database check timed out after ${DATABASE_CHECK_TIMEOUT_MS} ms`)),
      DATABASE_CHECK_TIMEOUT_MS
    )
  })
  try {
    const result = await Promise.race([getDB().execute(sql.raw(SCHEMA_READINESS_SQL)), timeout])
    return isSchemaReady(result.rows)
  } finally {
    clearTimeout(timer)
  }
}

// Public liveness and readiness probe. Every supported runtime needs a
// database, so the app is only ready once one is configured, answers in time
// and carries the API key foreign key (server/utils/schemaReadiness.ts). The
// failure body stays generic: the cause, which may contain connection
// details, is only logged on the server.
export default defineEventHandler(async (event) => {
  if (!isDatabaseConfigured()) {
    console.error('[health] no database configured')
    setResponseStatus(event, 503)
    return { status: 'error' }
  }
  let ready: boolean
  try {
    ready = await checkDatabase()
  } catch (error) {
    console.error('[health] database check failed:', error)
    setResponseStatus(event, 503)
    return { status: 'error' }
  }
  if (!ready) {
    console.error(`[health] database not ready: ${SCHEMA_NOT_READY_MESSAGE}`)
    setResponseStatus(event, 503)
    return { status: 'error' }
  }
  return { status: 'ok' }
})
