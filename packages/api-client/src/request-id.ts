/**
 * Correlation header, duplicated from `@newsdeck/logger` on purpose.
 *
 * `@newsdeck/logger` is a server package (it pulls in pino); importing it here
 * would drag Node-only code into browser and React Native bundles. The header
 * name is a two-word constant, and `test/request-id.test.ts` asserts the two
 * definitions stay identical.
 */
export const REQUEST_ID_HEADER = 'x-request-id'

export function newRequestId(): string {
  return crypto.randomUUID()
}
