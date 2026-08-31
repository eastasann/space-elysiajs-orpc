import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { LoadBalancingProbe } from '../src/components/LoadBalancingProbe.tsx'
import { fakeApiClient } from './support/fakeApiClient.ts'

afterEach(cleanup)

function renderProbe(script: readonly (string | null)[]) {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  return render(<LoadBalancingProbe apiClient={fakeApiClient(script)} />, { wrapper })
}

async function sample(script: readonly (string | null)[]) {
  renderProbe(script)
  fireEvent.click(screen.getByRole('button', { name: /Sample \d+ requests/ }))
  await screen.findByRole('table')
}

describe('LoadBalancingProbe', () => {
  it('shows the empty state before a sample is run', () => {
    renderProbe(['api-1'])

    expect(
      screen.getByText('Run a sample to see how requests are distributed across API instances.'),
    ).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('groups a successful sample by instance', async () => {
    await sample(['api-1', 'api-2'])

    expect(screen.getByRole('row', { name: /api-1/ })).toBeDefined()
    expect(screen.getByRole('row', { name: /api-2/ })).toBeDefined()
    expect(screen.getByText('Failed calls').nextElementSibling?.textContent).toBe('0')

    const distinctInstances = screen.getByText('Distinct instances').nextElementSibling
    expect(distinctInstances?.textContent).toBe('2')
    expect(distinctInstances?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('ok')
  })

  it('reports failed calls without hiding the instances that did answer', async () => {
    await sample(['api-1', null])

    expect(screen.getByRole('row', { name: /api-1/ })).toBeDefined()

    const failedCalls = screen.getByText('Failed calls').nextElementSibling
    expect(failedCalls?.textContent).not.toBe('0')
  })
})
