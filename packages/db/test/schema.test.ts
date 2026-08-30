import { describe, expect, it } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { userIdentities, users } from '../src/schema/index.ts'

describe('users table', () => {
  it('generates its own primary key rather than borrowing a provider id', () => {
    const { columns } = getTableConfig(users)
    const id = columns.find((column) => column.name === 'id')

    expect(id?.primary).toBe(true)
    expect(id?.hasDefault).toBe(true)
  })

  it('enforces a unique email', () => {
    const { indexes } = getTableConfig(users)
    const emailIndex = indexes.find((index) => index.config.name === 'users_email_unique')

    expect(emailIndex?.config.unique).toBe(true)
  })
})

describe('user_identities table', () => {
  it('cascades when the owning user is deleted', () => {
    const { foreignKeys } = getTableConfig(userIdentities)

    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]?.onDelete).toBe('cascade')
  })

  it('allows one identity per provider subject only', () => {
    const { indexes } = getTableConfig(userIdentities)
    const unique = indexes.find(
      (index) => index.config.name === 'user_identities_provider_subject_unique',
    )

    expect(unique?.config.unique).toBe(true)
    expect(unique?.config.columns.map((column) => 'name' in column && column.name)).toEqual([
      'provider',
      'provider_user_id',
    ])
  })

  it('does not expose the provider subject as the application user id', () => {
    const { columns } = getTableConfig(userIdentities)
    const names = columns.map((column) => column.name)

    expect(names).toContain('user_id')
    expect(names).toContain('provider_user_id')
    expect(getTableConfig(users).columns.map((column) => column.name)).not.toContain(
      'provider_user_id',
    )
  })
})
