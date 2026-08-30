import { KeyValueList, Panel, StatusBadge, statusTone } from '@newsdeck/ui'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { orpc } from '~/lib/api.ts'

export const Route = createFileRoute('/')({
  /**
   * Fetched during SSR through the same oRPC client the browser uses, so the
   * first paint already carries data and the browser does not refetch it.
   */
  loader: ({ context }) => context.queryClient.ensureQueryData(orpc.system.status.queryOptions()),
  component: Home,
})

function Home() {
  const { data: status } = useSuspenseQuery(orpc.system.status.queryOptions())

  return (
    <>
      <Panel
        title="Platform status"
        description="Served by the API through the reverse proxy, over oRPC."
      >
        <KeyValueList
          entries={[
            { label: 'API instance', value: status.instanceId },
            { label: 'Request id', value: status.requestId },
            { label: 'API uptime', value: `${status.uptimeSeconds}s` },
            {
              label: 'PostgreSQL',
              value: (
                <StatusBadge tone={statusTone(status.checks.database.ok)}>
                  {status.checks.database.ok
                    ? `ok · ${status.checks.database.latencyMs}ms`
                    : (status.checks.database.detail ?? 'unavailable')}
                </StatusBadge>
              ),
            },
            {
              label: 'Redis',
              value: (
                <StatusBadge tone={statusTone(status.checks.redis.ok)}>
                  {status.checks.redis.ok
                    ? `ok · ${status.checks.redis.latencyMs}ms`
                    : (status.checks.redis.detail ?? 'unavailable')}
                </StatusBadge>
              ),
            },
            {
              label: 'Worker',
              value: (
                <StatusBadge tone={statusTone(status.worker !== null)}>
                  {status.worker === null
                    ? 'no heartbeat'
                    : `${status.worker.instanceId} · ${status.worker.ageSeconds}s ago`}
                </StatusBadge>
              ),
            },
          ]}
        />
      </Panel>

      <Panel
        title="What exists so far"
        description="This is a bootstrap. Feature work is tracked as GitHub Issues."
      >
        <p className="nd-note">
          The platform foundation is in place: monorepo, Docker development environment, database
          migrations, the Elysia + oRPC API, this TanStack Start application, the admin application,
          the background worker, and the reverse proxy that load balances across API instances.
        </p>
        <p className="nd-note">
          Article discovery, feeds, bookmarks, votes and comments are not implemented yet. See
          <code> docs/issue-driven-development.md</code> for how each is picked up.
        </p>
      </Panel>
    </>
  )
}
