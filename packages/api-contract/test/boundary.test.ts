import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contract } from '../src/index.ts'

const packageRoot = new URL('..', import.meta.url).pathname
const sourceRoot = join(packageRoot, 'src')

/**
 * Packages this contract may depend on. Anything else risks dragging server
 * infrastructure — or secrets — into a browser or React Native bundle.
 */
const ALLOWED_DEPENDENCIES = new Set(['@orpc/contract', 'zod'])

/** Import specifiers that indicate a server-only dependency has leaked in. */
const FORBIDDEN_IMPORT_PATTERNS = [
  /^node:/,
  /^bun:/,
  /^bun$/,
  /^drizzle-orm/,
  /^postgres$/,
  /^ioredis$/,
  /^bullmq$/,
  /^pino/,
  /^elysia/,
  /^@orpc\/server/,
  /^@newsdeck\/(db|auth|logger|jobs)$/,
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
  let match = pattern.exec(source)
  while (match !== null) {
    if (match[1] !== undefined) specifiers.push(match[1])
    match = pattern.exec(source)
  }
  return specifiers
}

describe('client-safety boundary', () => {
  it('declares only client-safe dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }

    const declared = Object.keys(manifest.dependencies ?? {})
    const disallowed = declared.filter((name) => !ALLOWED_DEPENDENCIES.has(name))

    expect(disallowed).toEqual([])
  })

  it('imports nothing server-only from any source file', () => {
    const violations: string[] = []

    for (const file of sourceFiles(sourceRoot)) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN_IMPORT_PATTERNS.some((pattern) => pattern.test(specifier))) {
          violations.push(`${file.replace(packageRoot, '')} imports ${specifier}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

describe('contract shape', () => {
  it('exposes the system namespace', () => {
    expect(Object.keys(contract)).toEqual(['system', 'sources'])
    expect(Object.keys(contract.system)).toEqual(['status'])
  })

  it('exposes the sources namespace', () => {
    expect(Object.keys(contract.sources)).toEqual(['list', 'get', 'create', 'update', 'deactivate'])
  })
})
