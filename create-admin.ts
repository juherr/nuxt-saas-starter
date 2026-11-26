// SPDX-License-Identifier: MIT
import type { AdminStore, CreateAdminConfig } from './scripts/createAdmin.ts'
import process from 'node:process'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { config } from 'dotenv'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { v7 as uuidv7 } from 'uuid'
import { runCreateAdmin } from './scripts/createAdmin.ts'

const { Pool } = pg

// Schema definition (simplified from your project)
const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  role: text('role'),
  banned: boolean('banned').default(false)
})

const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
})

const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
})

const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
})

const schema = { user, account, verification, session }

// Wiring only: the logic lives in scripts/createAdmin.ts. Nothing runs, and no
// connection opens, unless this file is the entry point (`node create-admin.ts`).
function connect({ databaseUrl, connectTimeoutMs }: CreateAdminConfig): AdminStore {
  const pool = new Pool({
    connectionString: databaseUrl,
    // pg waits forever on an unreachable database without it.
    connectionTimeoutMillis: connectTimeoutMs
  })
  const db = drizzle(pool)
  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema
    }),
    emailAndPassword: {
      enabled: true
    },
    advanced: {
      database: {
        generateId: () => uuidv7()
      }
    }
  })

  return {
    signUp: async (body) => {
      const result = await auth.api.signUpEmail({ body, asResponse: false })
      return result?.user ? { id: result.user.id } : undefined
    },
    findUserIdByEmail: async (email) => {
      const [found] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
      return found?.id
    },
    promote: async (userId) => {
      await db.update(user)
        .set({ role: 'admin', emailVerified: true })
        .where(eq(user.id, userId))
    },
    close: () => pool.end()
  }
}

if (import.meta.main) {
  config({ quiet: true })
  void runCreateAdmin(process.env, { connect, logger: console }).then((code) => {
    process.exitCode = code
  })
}
