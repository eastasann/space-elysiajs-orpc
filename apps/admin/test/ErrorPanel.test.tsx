import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { ErrorPanel } from '../src/components/ErrorPanel.tsx'

afterEach(cleanup)

describe('ErrorPanel', () => {
  it("renders an Error's message", () => {
    render(
      <ErrorPanel error={new Error('the API is unreachable')} info={undefined} reset={() => {}} />,
    )

    expect(screen.getByText('the API is unreachable')).toBeDefined()
  })

  it('falls back for a non-Error value', () => {
    // The router types `error` as `Error`, but anything can be thrown at runtime.
    const notAnError = 'not an Error instance' as unknown as Error
    render(<ErrorPanel error={notAnError} info={undefined} reset={() => {}} />)

    expect(screen.getByText('Unknown error')).toBeDefined()
  })
})
