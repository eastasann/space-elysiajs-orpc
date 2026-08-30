import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const WORKFLOW_DIR = new URL('../../../.github/workflows/', import.meta.url).pathname

interface Job {
  permissions?: unknown
  steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown>; name?: string }>
}
interface Workflow {
  on?: unknown
  permissions?: unknown
  jobs?: Record<string, Job>
}

const files = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith('.yml'))
const workflows = files.map((file) => ({
  file,
  text: readFileSync(join(WORKFLOW_DIR, file), 'utf8'),
  doc: parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as Workflow,
}))

const loopWorkflows = workflows.filter((workflow) => workflow.file.startsWith('loop-'))

describe('workflow inventory', () => {
  it('parses every workflow', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const { doc } of workflows) expect(doc.jobs).toBeDefined()
  })

  it('ships the loop workflows', () => {
    expect(loopWorkflows.map((w) => w.file).sort()).toEqual([
      'loop-agent-dispatch.yml',
      'loop-bootstrap.yml',
      'loop-next-issue.yml',
      'loop-pr.yml',
    ])
  })
})

describe('trigger safety', () => {
  it('never uses pull_request_target', () => {
    // `pull_request_target` runs with a write token in the base repository's
    // context while the head is attacker-controlled. The loop deliberately
    // avoids it and uses `workflow_run` instead. Asserted against the parsed
    // triggers rather than the file text, so a comment explaining the choice
    // does not read as the choice itself.
    const offenders = workflows
      .filter((workflow) => {
        const on = workflow.doc.on
        const triggers = typeof on === 'object' && on !== null ? Object.keys(on) : [String(on)]
        return triggers.includes('pull_request_target')
      })
      .map((workflow) => workflow.file)

    expect(offenders).toEqual([])
  })

  it('pins every loop checkout to the default branch', () => {
    // Not merely "does not check out a head": some pull-request-scoped events
    // set GITHUB_REF to the merge ref, so an unpinned checkout would silently
    // pull untrusted code into a job that holds write permissions.
    const offenders: string[] = []

    for (const { file, doc } of loopWorkflows) {
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith('actions/checkout') !== true) continue
          const ref = String(step.with?.ref ?? '')
          if (!ref.includes('default_branch')) offenders.push(`${file}#${name}: ref="${ref}"`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('permissions', () => {
  it('declares an explicit top-level default of none for every loop workflow', () => {
    for (const { file, doc } of loopWorkflows) {
      expect(`${file}`).toBeTruthy()
      expect(doc.permissions).toEqual({})
    }
  })

  it('declares permissions on every job in every workflow', () => {
    for (const { file, doc } of workflows) {
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        // CI needs nothing beyond the default read scope, so it may omit them;
        // anything that can write must say so explicitly.
        if (file === 'ci.yml') continue
        expect(`${file}#${name}`).toBeTruthy()
        expect(job.permissions).toBeDefined()
      }
    }
  })

  it('never grants write access to the whole token', () => {
    for (const { file, doc } of workflows) {
      expect(`${file}`).toBeTruthy()
      expect(doc.permissions).not.toBe('write-all')
      for (const job of Object.values(doc.jobs ?? {})) {
        expect(job.permissions).not.toBe('write-all')
      }
    }
  })

  it('does not grant contents: write, so the loop cannot push to a branch itself', () => {
    for (const { file, doc } of loopWorkflows) {
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        const permissions = job.permissions as Record<string, string> | undefined
        expect(`${file}#${name}`).toBeTruthy()
        expect(permissions?.contents ?? 'read').toBe('read')
      }
    }
  })
})

describe('command injection', () => {
  it('never interpolates an expression into a run script', () => {
    // Expressions are substituted before the shell sees them, so a pull request
    // title containing `$(...)` would execute. Values reach scripts through
    // `env:` instead, where the shell treats them as data.
    for (const { file, doc } of workflows) {
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.run === undefined) continue
          expect(`${file}#${name} step "${step.name ?? '(unnamed)'}": ${step.run}`).not.toContain(
            '${{',
          )
        }
      }
    }
  })

  it('never interpolates an expression into an inline github-script body', () => {
    for (const { file, doc } of workflows) {
      for (const job of Object.values(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith('actions/github-script') !== true) continue
          const script = String(step.with?.script ?? '')
          expect(`${file}: ${script.slice(0, 200)}`).not.toContain('${{')
        }
      }
    }
  })
})

describe('action pinning', () => {
  it('pins every action to a version', () => {
    for (const { file, doc } of workflows) {
      for (const job of Object.values(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses === undefined) continue
          expect(`${file}: ${step.uses}`).toContain('@')
        }
      }
    }
  })
})

describe('required checks stay in step with CI', () => {
  it('names job names that CI actually publishes', () => {
    const ci = workflows.find((workflow) => workflow.file === 'ci.yml')
    const ciJobNames = Object.values(ci?.doc.jobs ?? {}).map(
      (job) => (job as { name?: string }).name ?? '',
    )

    const loopPr = workflows.find((workflow) => workflow.file === 'loop-pr.yml')
    const declared = /LOOP_REQUIRED_CHECKS:.*?'([^']+)'/.exec(loopPr?.text ?? '')?.[1] ?? ''

    for (const name of declared.split(',').map((entry) => entry.trim())) {
      expect(ciJobNames).toContain(name)
    }
  })
})
