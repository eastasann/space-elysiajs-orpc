import { KeyValueList, Panel, StatusBadge, statusTone } from '@newsdeck/ui'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { LoadBalancingProbe } from '~/components/LoadBalancingProbe.tsx'
import { orpc } from '~/lib/api.ts'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(orpc.system.status.queryOptions()),
  component: Dashboard,
})

function Dashboard() {
  const { data: status } = useSuspenseQuery(orpc.system.status.queryOptions())

  return (
    <>
      <Panel title="Platform status" description="Reported by the API instance that answered.">
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
          ]}
        />
      </Panel>

      <Panel
        title="Background worker"
        description="Queue depth and the most recent worker heartbeat."
      >
        <KeyValueList
          entries={[
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
            { label: 'Queue', value: status.queue.name },
            { label: 'Waiting', value: String(status.queue.waiting) },
            { label: 'Active', value: String(status.queue.active) },
            { label: 'Delayed', value: String(status.queue.delayed) },
            { label: 'Completed', value: String(status.queue.completed) },
            {
              label: 'Failed',
              value: (
                <StatusBadge tone={status.queue.failed === 0 ? 'ok' : 'warn'}>
                  {status.queue.failed}
                </StatusBadge>
              ),
            },
          ]}
        />
      </Panel>

      <LoadBalancingProbe />

      <Panel title="Not implemented yet" description="Tracked as GitHub Issues.">
        <p className="nd-note">
          Source management, article management, category management, user management, comment
          moderation and failed-job inspection are part of the roadmap, not of this bootstrap.
        </p>
      </Panel>
    </>
  )
}
