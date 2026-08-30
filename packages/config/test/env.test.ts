import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { EnvironmentError, integerFromEnv, parseEnv, stringList } from '../src/index.ts'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: integerFromEnv({ default: 3001, min: 1, max: 65535 }),
  ORIGINS: stringList(['http://localhost:8080']),
})

describe('parseEnv', () => {
  it('applies defaults for absent optional variables', () => {
    const env = parseEnv(schema, { DATABASE_URL: 'postgres://localhost/db' })

    expect(env.PORT).toBe(3001)
    expect(env.ORIGINS).toEqual(['http://localhost:8080'])
  })

  it('parses provided values', () => {
    const env = parseEnv(schema, {
      DATABASE_URL: 'postgres://localhost/db',
      PORT: '4000',
      ORIGINS: 'https://a.test, https://b.test ,',
    })

    expect(env.PORT).toBe(4000)
    expect(env.ORIGINS).toEqual(['https://a.test', 'https://b.test'])
  })

  it('throws EnvironmentError naming every failing variable', () => {
    let error: unknown
    try {
      parseEnv(schema, { PORT: 'not-a-number' })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(EnvironmentError)
    const issues = (error as EnvironmentError).issues
    expect(issues.some((issue) => issue.startsWith('DATABASE_URL:'))).toBe(true)
    expect(issues.some((issue) => issue.startsWith('PORT:'))).toBe(true)
  })

  it('never includes environment values in the error message', () => {
    let message = ''
    try {
      parseEnv(z.object({ SECRET: z.string().min(64) }), { SECRET: 'super-secret-value' })
    } catch (caught) {
      message = (caught as Error).message
    }

    expect(message).toContain('SECRET')
    expect(message).not.toContain('super-secret-value')
  })

  it('rejects out-of-range integers', () => {
    expect(() => parseEnv(schema, { DATABASE_URL: 'x', PORT: '99999' })).toThrow(EnvironmentError)
  })
})
