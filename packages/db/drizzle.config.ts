import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://newsdeck:newsdeck@localhost:5432/newsdeck',
  },
  strict: true,
  verbose: true,
})
