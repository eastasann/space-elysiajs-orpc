import { systemRouter } from '../modules/system/router.ts'
import { base } from './base.ts'

export const appRouter = base.router({
  system: systemRouter,
})

export type AppRouter = typeof appRouter
