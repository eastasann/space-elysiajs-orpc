import type { ContractRouterClient } from '@orpc/contract'
import { sourcesContract } from './sources/index.ts'
import { systemContract } from './system/index.ts'

export const contract = {
  system: systemContract,
  sources: sourcesContract,
}

export type Contract = typeof contract

/**
 * The fully typed client shape derived from the contract. Clients build a
 * concrete instance with `createORPCClient<ApiClient>(link)`.
 */
export type ApiClient = ContractRouterClient<Contract>
