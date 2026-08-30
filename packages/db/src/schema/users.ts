import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Application users.
 *
 * `id` is the ONLY user identifier the application is allowed to use. It is
 * generated here, never by an authentication provider, so that providers can
 * be swapped or run side by side without rewriting the domain.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)

/**
 * Link table between an application user and a credential held by an external
 * authentication provider.
 *
 * One user may hold several identities (e.g. a local development identity and
 * a hosted OIDC identity), which is what makes provider migration possible.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Provider key, e.g. `local`. Matches `AuthProvider.name`. */
    provider: text('provider').notNull(),
    /** The provider's own subject id. Opaque to the application. */
    providerUserId: text('provider_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_identities_provider_subject_unique').on(table.provider, table.providerUserId),
    index('user_identities_user_id_idx').on(table.userId),
  ],
)

export const usersRelations = relations(users, ({ many }) => ({
  identities: many(userIdentities),
}))

export const userIdentitiesRelations = relations(userIdentities, ({ one }) => ({
  user: one(users, { fields: [userIdentities.userId], references: [users.id] }),
}))

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type UserIdentity = typeof userIdentities.$inferSelect
export type NewUserIdentity = typeof userIdentities.$inferInsert
