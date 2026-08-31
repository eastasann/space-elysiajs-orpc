import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { KeyValueList } from '../src/KeyValueList.tsx'

afterEach(cleanup)

describe('KeyValueList', () => {
  it('renders one row per entry, in order', () => {
    render(
      <KeyValueList
        entries={[
          { label: 'API instance', value: 'api-1' },
          { label: 'Uptime', value: '12s' },
        ]}
      />,
    )

    const labels = screen.getAllByRole('term').map((node) => node.textContent)
    const values = screen.getAllByRole('definition').map((node) => node.textContent)

    expect(labels).toEqual(['API instance', 'Uptime'])
    expect(values).toEqual(['api-1', '12s'])
  })

  it('renders nothing when there are no entries', () => {
    render(<KeyValueList entries={[]} />)

    expect(screen.queryAllByRole('term')).toHaveLength(0)
  })

  it('accepts a node as a value', () => {
    render(<KeyValueList entries={[{ label: 'Status', value: <span>ok</span> }]} />)

    expect(screen.getByText('ok').tagName).toBe('SPAN')
  })
})
