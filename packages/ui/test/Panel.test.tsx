import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { Panel } from '../src/Panel.tsx'

afterEach(cleanup)

describe('Panel', () => {
  it('renders the title and children', () => {
    render(
      <Panel title="Platform status">
        <p>Body content</p>
      </Panel>,
    )

    expect(screen.getByRole('heading', { name: 'Platform status' })).toBeDefined()
    expect(screen.getByText('Body content')).toBeDefined()
  })

  it('omits the description when none is given', () => {
    render(
      <Panel title="No description">
        <p>Body content</p>
      </Panel>,
    )

    expect(screen.queryByText('Body content')).toBeDefined()
    expect(document.querySelector('.nd-panel__description')).toBeNull()
  })

  it('renders a description and actions when given', () => {
    render(
      <Panel
        title="With extras"
        description="Explains the panel"
        actions={<button type="button">Act</button>}
      >
        <p>Body content</p>
      </Panel>,
    )

    expect(screen.getByText('Explains the panel')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Act' })).toBeDefined()
  })
})
