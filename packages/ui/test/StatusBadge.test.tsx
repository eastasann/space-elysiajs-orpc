import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { StatusBadge, type StatusTone } from '../src/StatusBadge.tsx'

afterEach(cleanup)

describe('StatusBadge', () => {
  it.each([['ok'], ['warn'], ['error'], ['neutral']] as [StatusTone][])(
    'sets data-tone from the %s tone prop',
    (tone) => {
      render(<StatusBadge tone={tone}>Label</StatusBadge>)

      expect(screen.getByText('Label').getAttribute('data-tone')).toBe(tone)
    },
  )

  it('renders its children', () => {
    render(<StatusBadge tone="ok">42ms</StatusBadge>)

    expect(screen.getByText('42ms')).toBeDefined()
  })
})
