/**
 * Presentational components shared by the user web app and the admin app.
 *
 * Client-safe by construction: React only. No data fetching, no API client, no
 * server imports — those belong to the applications. A future Expo app will
 * NOT consume this package (its primitives are DOM-based); it shares
 * `@newsdeck/api-contract` instead.
 */

export { type KeyValueEntry, KeyValueList, type KeyValueListProps } from './KeyValueList.tsx'
export { Panel, type PanelProps } from './Panel.tsx'
export { StatusBadge, type StatusBadgeProps, type StatusTone } from './StatusBadge.tsx'
export { statusTone } from './tone.ts'
