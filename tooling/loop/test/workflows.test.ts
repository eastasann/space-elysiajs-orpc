import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const WORKFLOW_DIR = new URL('../../../.github/workflows/', import.meta.url).pathname

interface Job {
  permissions?: unknown
  steps?: Array<{
    id?: string
    uses?: string
    run?: string
    with?: Record<string, unknown>
    env?: Record<string, unknown>
    if?: string
    name?: string
  }>
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

describe('step output references', () => {
  /**
   * `steps.<id>.outputs.<name>` against the steps that actually declare an id.
   *
   * A reference to a step with no `id` is not an error in Actions — it silently
   * evaluates to the empty string. That is how the gate came to post a new
   * status comment on every run instead of updating one: the step that looked
   * up the existing comment had no `id`, and the step that consumed the result
   * read it from a different step's outputs. Both halves looked correct in
   * isolation and the workflow ran green.
   *
   * Cheap to check, and the failure mode it catches is invisible in logs.
   */
  const REFERENCE = /steps\.([A-Za-z_][\w-]*)\.outputs\.([\w-]+)/g

  it.each(workflows.map((workflow) => [workflow.file, workflow] as const))(
    '%s references only steps that declare an id',
    (_file, workflow) => {
      const declared = new Set<string>()
      for (const job of Object.values(workflow.doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.id !== undefined) declared.add(step.id)
        }
      }

      const dangling = [...workflow.text.matchAll(REFERENCE)]
        .map((match) => match[1] as string)
        .filter((id) => !declared.has(id))

      expect(
        [...new Set(dangling)],
        `${workflow.file} reads outputs from step id(s) that do not exist; a missing id evaluates to an empty string rather than failing`,
      ).toEqual([])
    },
  )

  it('finds the ids it is asserting about, so the test is not vacuous', () => {
    const gate = workflows.find((workflow) => workflow.file === 'loop-pr.yml')
    expect(gate).toBeDefined()

    const ids = Object.values(gate?.doc.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).map((step) => step.id).filter((id): id is string => id !== undefined),
    )
    expect(ids).toContain('resolve')
    expect(ids).toContain('context')
  })
})

describe('the cloud agent integration', () => {
  /**
   * The loop's agents run as Claude Code cloud executions in GitHub Actions,
   * authenticated with a Claude subscription token. These assertions pin the
   * three things that are easy to get wrong and silent when wrong: the wrong
   * credential (which bills an API key), an input the action does not have
   * (which is ignored rather than rejected), and a bot allowlist wide enough
   * for any installed App to drive the agent.
   */
  const agentSteps = workflows.flatMap((workflow) =>
    Object.values(workflow.doc.jobs ?? {}).flatMap((job) =>
      (job.steps ?? [])
        .filter((step) => step.uses?.startsWith('anthropics/claude-code-action') === true)
        .map((step) => ({ file: workflow.file, step })),
    ),
  )

  it('invokes the action somewhere', () => {
    expect(agentSteps.length).toBeGreaterThan(0)
  })

  it('authenticates with a subscription token, never an API key', () => {
    for (const { file, step } of agentSteps) {
      const inputs = step.with ?? {}
      expect(inputs.claude_code_oauth_token, `${file}: ${step.name}`).toBeDefined()
      expect(inputs.anthropic_api_key, `${file}: ${step.name}`).toBeUndefined()
    }
  })

  it('passes only inputs the action actually defines', () => {
    // `prompt_file` and `output_file` do not exist. An unknown input is not an
    // error in Actions — it is dropped — so a workflow using one looks correct
    // and silently does nothing with it.
    const known = new Set([
      'anthropic_api_key',
      'claude_code_oauth_token',
      'prompt',
      'claude_args',
      'settings',
      'track_progress',
      'base_branch',
      'branch_prefix',
      'use_sticky_comment',
      'github_token',
      'additional_permissions',
      'allowed_bots',
      'allowed_non_write_users',
      'trigger_phrase',
      'label_trigger',
      'assignee_trigger',
      'plugin_marketplaces',
      'plugins',
      'use_bedrock',
      'use_vertex',
      'use_commit_signing',
    ])

    for (const { file, step } of agentSteps) {
      const unknown = Object.keys(step.with ?? {}).filter((input) => !known.has(input))
      expect(unknown, `${file}: ${step.name} passes an input the action does not define`).toEqual(
        [],
      )
    }
  })

  it('names the bots it allows rather than allowing all of them', () => {
    for (const { file, step } of agentSteps) {
      const allowed = String(step.with?.allowed_bots ?? '')
      expect(allowed, `${file}: ${step.name} must set allowed_bots`).not.toBe('')
      // `*` would let any installed GitHub App trigger the agent with a prompt
      // it controls. The action's own documentation warns about it.
      expect(allowed, `${file}: ${step.name} must not allow every bot`).not.toContain('*')
    }
  })

  it('drives the agents through skills committed to the repository', () => {
    const root = new URL('../../../', import.meta.url).pathname

    for (const skill of ['loop-review', 'loop-implement', 'loop-fix']) {
      expect(existsSync(join(root, '.claude', 'skills', skill, 'SKILL.md')), skill).toBe(true)
    }

    // Every prompt invokes a skill, so the instructions are reviewable code
    // rather than a string buried in YAML.
    for (const { file, step } of agentSteps) {
      const prompt = String(step.with?.prompt ?? '')
      expect(
        prompt.trim().startsWith('/') || prompt.includes('/loop-'),
        `${file}: ${step.name}`,
      ).toBe(true)
    }
  })

  it('lets a failed review withhold the merge rather than fail the job', () => {
    // A reviewer that crashes must produce no verdict file, so the aggregate
    // sees fewer reviews than the tier requires and blocks. Failing the job
    // instead would lose the distinction between "reviewed and objected" and
    // "never ran".
    const gate = workflows.find((workflow) => workflow.file === 'loop-pr.yml')
    const reviewers = Object.values(gate?.doc.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).filter(
        (step) =>
          step.uses?.startsWith('anthropics/claude-code-action') === true &&
          String(step.id ?? '').includes('review'),
      ),
    )

    expect(reviewers.length).toBeGreaterThanOrEqual(2)
    for (const step of reviewers) {
      expect((step as { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
    }
  })
})

describe('the issue lifecycle survives a missing runner', () => {
  const dispatch = workflows.find((w) => w.file === 'loop-agent-dispatch.yml')
  const steps = dispatch?.doc.jobs?.dispatch?.steps ?? []
  const indexOf = (name: string) => steps.findIndex((step) => step.name === name)

  const unavailable = indexOf('Report that no agent runner is configured')
  const claim = indexOf('Claim the issue')

  it('has both of the steps this depends on', () => {
    expect(unavailable, 'the unavailable-runner step').toBeGreaterThanOrEqual(0)
    expect(claim, 'the claim step').toBeGreaterThanOrEqual(0)
  })

  // The first real dispatch claimed issue #4, then discovered the secret was
  // missing and blocked it. The issue ended up carrying `agent:in-progress` and
  // `agent:blocked` at once: excluded from selection, assigned to nobody, and
  // still that way after the secret would have been set.
  it('decides whether it can run before claiming anything', () => {
    expect(unavailable).toBeLessThan(claim)
  })

  it('does not block an issue for a repository-wide precondition', () => {
    const script = String(steps[unavailable]?.with?.script ?? '')
    // Assert on the call, not the string: the step explains in a comment and in
    // its notice why it does not block, so both mention the label.
    const code = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')

    expect(code).not.toContain('addLabels')
    expect(code).toContain('createComment')
  })

  // The general failure path is the one that legitimately blocks, and it has to
  // clear the claim it made or the issue is stranded as neither available nor
  // in progress.
  it('clears the claim on the path that does block', () => {
    const script = String(steps[indexOf('Report that the coding agent failed')]?.with?.script ?? '')

    expect(script).toContain('agent:blocked')
    expect(script).toContain('agent:in-progress')
    expect(script).toContain('removeLabel')
  })
})

describe('the agent action can actually authenticate', () => {
  const CLAUDE_ACTION = 'anthropics/claude-code-action'

  // The action exchanges an OIDC token for a Claude GitHub App token. Without
  // `id-token: write` it fails before the agent starts — "Unable to get
  // ACTIONS_ID_TOKEN_REQUEST_URL" — and in loop-pr.yml the review steps carry
  // `continue-on-error`, so the failure shows up only as a blocked review with
  // no stated cause.
  const jobsRunningTheAgent = workflows.flatMap(({ file, doc }) =>
    Object.entries(doc.jobs ?? {})
      .filter(([, job]) => (job.steps ?? []).some((s) => s.uses?.startsWith(CLAUDE_ACTION)))
      .map(([name, job]) => ({ file, name, job })),
  )

  it('finds the jobs that run the agent', () => {
    expect(jobsRunningTheAgent.length).toBeGreaterThan(0)
  })

  it('grants id-token: write wherever the action runs', () => {
    for (const { file, name, job } of jobsRunningTheAgent) {
      const permissions = job.permissions as Record<string, string> | undefined
      expect(permissions?.['id-token'], `${file}: job ${name}`).toBe('write')
    }
  })
})

describe('cleanup steps run when the thing they clean up after fails', () => {
  // A condition with no status function is implicitly ANDed with `success()`,
  // so a step that reacts to another step's failure is skipped by the very
  // failure it exists for. This is invisible in review and only shows up as
  // state left behind on a bad run.
  const STATUS_FUNCTION = /\b(?:always|failure|cancelled)\s*\(\s*\)/

  const reactsToFailure = loopWorkflows.flatMap(({ file, doc }) =>
    Object.entries(doc.jobs ?? {}).flatMap(([job, spec]) =>
      (spec.steps ?? [])
        .filter((step) => /steps\.[\w-]+\.outputs\.\w+\s*!=\s*'success'/.test(step.if ?? ''))
        .map((step) => ({ file, job, step })),
    ),
  )

  it('finds at least one such step', () => {
    expect(reactsToFailure.length).toBeGreaterThan(0)
  })

  it('gates them on a status function', () => {
    for (const { file, job, step } of reactsToFailure) {
      expect(STATUS_FUNCTION.test(step.if ?? ''), `${file}: ${job} / ${step.name}`).toBe(true)
    }
  })
})
