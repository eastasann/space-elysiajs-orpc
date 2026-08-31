/**
 * The application API contract.
 *
 * This package is the only API surface that clients — the user web app, the
 * admin app, and any future Expo/React Native app — are allowed to depend on.
 * It therefore MUST stay free of server-only code: no database drivers, no
 * secrets, no Node/Bun built-ins, no filesystem or process access. A test in
 * `test/boundary.test.ts` enforces the dependency allowlist.
 */
export { type ApiClient, type Contract, contract } from './contract.ts'
export * from './sources/index.ts'
export * from './system/index.ts'
