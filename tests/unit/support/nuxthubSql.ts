// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { splitSqlQueries } from '@nuxthub/core/db'

/** The upgrade query NuxtHub runs after the migrations (nuxt.config.ts). */
export const apiKeyOwnerQueryPath = fileURLToPath(
  new URL('../../../server/db/queries/api-key-organization-owner.postgresql.sql', import.meta.url)
)

export const readSqlFile = (path: string) => readFileSync(path, 'utf-8')

/** Splits a SQL file into statements the way NuxtHub does before running them. */
export const splitLikeNuxtHub = (sql: string): string[] => splitSqlQueries(sql)
