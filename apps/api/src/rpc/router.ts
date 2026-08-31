import { sourcesRouter } from '../modules/sources/router.ts'
import { systemRouter } from '../modules/system/router.ts'
import { base } from './base.ts'

export const appRouter = base.router({
  system: systemRouter,
  sources: sourcesRouter,
})

export type AppRouter = typeof appRouter
