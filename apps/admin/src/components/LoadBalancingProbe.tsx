import { KeyValueList, Panel, StatusBadge, statusTone } from '@newsdeck/ui'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiClient } from '~/lib/api.ts'

const SAMPLE_SIZE = 20

interface Sample {
  /** How many of the sampled calls each API replica answered. */
  countsByInstance: Record<string, number>
  failures: number
}

/**
 * Samples the API from the browser and reports which replica answered each
 * call.
 *
 * Every call travels browser -> reverse proxy -> one API instance, so a spread
 * across more than one `instanceId` is direct evidence that the proxy is
 * balancing rather than pinning. Calls are issued sequentially: concurrent
 * requests can share a connection and would understate the spread.
 */
export function LoadBalancingProbe() {
  const [sample, setSample] = useState<Sample | null>(null)

  const probe = useMutation({
    mutationFn: async (): Promise<Sample> => {
      const countsByInstance: Record<string, number> = {}
      let failures = 0

      for (let index = 0; index < SAMPLE_SIZE; index += 1) {
        try {
          const status = await apiClient.system.status()
          countsByInstance[status.instanceId] = (countsByInstance[status.instanceId] ?? 0) + 1
        } catch {
          failures += 1
        }
      }

      return { countsByInstance, failures }
    },
    onSuccess: setSample,
  })

  const instances = Object.entries(sample?.countsByInstance ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )

  return (
    <Panel
      title="Load balancing"
      description={`Issues ${SAMPLE_SIZE} status calls and groups the answers by API instance.`}
      actions={
        <button
          type="button"
          className="nd-button"
          onClick={() => probe.mutate()}
          disabled={probe.isPending}
        >
          {probe.isPending ? 'Sampling…' : `Sample ${SAMPLE_SIZE} requests`}
        </button>
      }
    >
      {sample === null ? (
        <p className="nd-note">
          Run a sample to see how requests are distributed across API instances.
        </p>
      ) : (
        <>
          <KeyValueList
            entries={[
              {
                label: 'Distinct instances',
                value: (
                  <StatusBadge tone={statusTone(instances.length > 1)}>
                    {instances.length}
                  </StatusBadge>
                ),
              },
              { label: 'Failed calls', value: String(sample.failures) },
            ]}
          />
          <table className="nd-table">
            <thead>
              <tr>
                <th>API instance</th>
                <th>Requests answered</th>
              </tr>
            </thead>
            <tbody>
              {instances.map(([instanceId, count]) => (
                <tr key={instanceId}>
                  <td>{instanceId}</td>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {instances.length === 1 ? (
            <p className="nd-note">
              Only one instance answered. That is expected when a single API replica is running.
            </p>
          ) : null}
        </>
      )}
      {probe.isError ? <p className="nd-note">Sampling failed. Is the API reachable?</p> : null}
    </Panel>
  )
}
