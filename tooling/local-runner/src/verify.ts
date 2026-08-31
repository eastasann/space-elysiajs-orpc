import type { LoopPolicy, RiskLevel, TierStep } from '@newsdeck/loop'
import { matchesAnyGlob, stepsForRisk } from '@newsdeck/loop'
import { VERIFICATION_STEPS } from './config.ts'
import { resolveOnPath, run } from './exec.ts'
import { redact } from './redact.ts'

/**
 * Local verification, scaled to the risk of the change.
 *
 * This is where "high risk" now costs something. A documentation fix runs lint,
 * types, tests and a build; a change to the authentication package additionally
 * runs end-to-end tests, a Docker smoke test and migration validation. All of
 * them can merge without a person — the difference is what has to be true first.
 *
 * Three outcomes per step, and the third is the one that matters:
 *
 * - **passed / failed** — the check ran and gave an answer.
 * - **not-applicable** — the diff touches nothing this step could break.
 * - **unavailable** — the step could not run at all, because a tool it needs is
 *   missing. This is never treated as a pass. An unattended loop that counted
 *   "Docker isn't installed" as "the Docker smoke test succeeded" would merge
 *   infrastructure changes on the strength of a check that never happened.
 */

export type StepOutcome = 'passed' | 'failed' | 'not-applicable' | 'unavailable'

export interface StepResult {
  name: string
  outcome: StepOutcome
  ok: boolean
  durationMs: number
  /** Redacted tail of the command's output, for the report. */
  output: string
}

export interface VerificationOutcome {
  ok: boolean
  risk: RiskLevel
  steps: StepResult[]
  /** The first failure, which is the one worth showing the agent. */
  firstFailure: StepResult | null
  /** Steps that could not run. Non-empty means the issue blocks. */
  unavailable: string[]
  failed: string[]
}

/** Output kept per step. Enough to diagnose, small enough for a prompt. */
const OUTPUT_TAIL_CHARACTERS = 6000

export interface VerifyOptions {
  cwd: string
  /** Risk level whose tier of steps to run. */
  risk?: RiskLevel
  /** Policy holding the tier definitions. Falls back to a flat list. */
  policy?: LoopPolicy
  /** Paths this change touches, for `whenChanged`. Absent means "run everything". */
  changedFiles?: readonly string[]
  runner?: typeof run
  which?: (command: string) => string | null
  /** Restrict to a subset, by step name. Used by tests. */
  only?: readonly string[]
}

function tierSteps(options: VerifyOptions): TierStep[] {
  const risk = options.risk ?? 'low'
  if (options.policy === undefined) {
    return VERIFICATION_STEPS.map((step) => ({
      name: step.name,
      command: step.command,
      args: [...step.args],
      timeoutMinutes: step.timeoutMinutes,
    }))
  }
  return stepsForRisk(options.policy, risk)
}

export async function verify(options: VerifyOptions): Promise<VerificationOutcome> {
  const exec = options.runner ?? run
  const which = options.which ?? resolveOnPath
  const risk = options.risk ?? 'low'

  const steps: StepResult[] = []
  const record = (name: string, outcome: StepOutcome, durationMs = 0, output = ''): StepResult => {
    const result: StepResult = { name, outcome, ok: outcome !== 'failed', durationMs, output }
    steps.push(result)
    return result
  }

  for (const step of tierSteps(options)) {
    if (options.only !== undefined && !options.only.includes(step.name)) continue

    // A step scoped to paths this change never touches has nothing to say.
    if (
      step.whenChanged !== undefined &&
      options.changedFiles !== undefined &&
      !options.changedFiles.some((file) => matchesAnyGlob(step.whenChanged as string[], file))
    ) {
      record(step.name, 'not-applicable')
      continue
    }

    if (step.requires !== undefined && which(step.requires) === null) {
      record(
        step.name,
        'unavailable',
        0,
        `\`${step.requires}\` is not on PATH, so this step could not run.`,
      )
      continue
    }

    const startedAt = Date.now()
    const result = await exec(step.command, step.args, {
      cwd: options.cwd,
      timeoutMs: step.timeoutMinutes * 60_000,
    })
    const combined = `${result.stdout}\n${result.stderr}`.trim()

    record(
      step.name,
      result.code === 0 && !result.timedOut ? 'passed' : 'failed',
      Date.now() - startedAt,
      redact(combined).slice(-OUTPUT_TAIL_CHARACTERS),
    )

    // Stop at the first failure. Running `build` after `typecheck` failed only
    // produces a second copy of the same error, and each step costs minutes.
    if (result.code !== 0 || result.timedOut) break
  }

  const failed = steps.filter((step) => step.outcome === 'failed')
  const unavailable = steps.filter((step) => step.outcome === 'unavailable')

  return {
    ok: failed.length === 0 && unavailable.length === 0,
    risk,
    steps,
    firstFailure: failed[0] ?? null,
    unavailable: unavailable.map((step) => step.name),
    failed: failed.map((step) => step.name),
  }
}

const MARK: Record<StepOutcome, string> = {
  passed: 'pass',
  failed: 'FAIL',
  'not-applicable': 'n/a ',
  unavailable: 'SKIP',
}

export function formatVerification(outcome: VerificationOutcome): string {
  const lines = [`Verification for \`${outcome.risk}\` risk:`, '']

  for (const step of outcome.steps) {
    const duration =
      step.outcome === 'passed' || step.outcome === 'failed'
        ? ` (${Math.round(step.durationMs / 1000)}s)`
        : ''
    lines.push(`- ${MARK[step.outcome]} \`${step.name}\`${duration}`)
  }

  if (outcome.unavailable.length > 0) {
    lines.push(
      '',
      `**Could not run:** ${outcome.unavailable.join(', ')}. An unrunnable check is not a passing one, so this change cannot merge until the tooling is available.`,
    )
  }

  if (outcome.firstFailure !== null) {
    lines.push('', `<details><summary>${outcome.firstFailure.name} output</summary>`, '')
    lines.push('```', outcome.firstFailure.output.slice(-4000), '```', '</details>')
  }

  return lines.join('\n')
}
