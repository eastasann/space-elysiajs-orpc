import { describe, expect, it } from 'bun:test'
import { statusTone } from '../src/tone.ts'

describe('statusTone', () => {
  it('maps a healthy signal to ok', () => {
    expect(statusTone(true)).toBe('ok')
  })

  it('maps a failing signal to error', () => {
    expect(statusTone(false)).toBe('error')
  })

  it.each([[null], [undefined]])('maps an unknown signal (%p) to neutral', (value) => {
    expect(statusTone(value)).toBe('neutral')
  })
})
