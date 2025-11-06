import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
    console.warn('[db] DATABASE_URL is not set. Database-dependent features will fail until it is configured.')
}

const client = databaseUrl
    ? postgres(databaseUrl, {
          ssl: databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
      })
    : undefined

export const db = client ? drizzle(client) : undefined

export type DatabaseClient = typeof db
