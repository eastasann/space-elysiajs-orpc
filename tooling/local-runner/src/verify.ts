import { VERIFICATION_STEPS } from './config.ts'
import { run } from './exec.ts'
import { redact } from './redact.ts'

/**
 * Local verification.
 *
 * The same commands CI runs, run before the branch is pushed. This is not
 * redundant with CI: it is what stops the loop from spending a round trip —
 * push, wait, red, fix, push — on a mistake the developer's own machine could
 * have caught in two minutes.
 */

export interface StepResult {
  name: string
  ok: boolean
  durationMs: number
  /** Redacted tail of the command's output, for the report. */
  output: string
}

export interface VerificationOutcome {
  ok: boolean
  steps: StepResult[]
  /** The first failure, which is the one worth showing the agent. */
  firstFailure: StepResult | null
}

/** Output kept per step. Enough to diagnose, small enough for a prompt. */
const OUTPUT_TAIL_CHARACTERS = 6000

export interface VerifyOptions {
  cwd: string
  runner?: typeof run
  timeoutMs?: number
  /** Restrict to a subset, by step name. Used by `--dry-run` and by tests. */
  only?: readonly string[]
}

export async function verify(options: VerifyOptions): Promise<VerificationOutcome> {
  const exec = options.runner ?? run
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000

  const steps: StepResult[] = []

  for (const step of VERIFICATION_STEPS) {
    if (options.only !== undefined && !options.only.includes(step.name)) continue

    const startedAt = Date.now()
    const result = await exec(step.command, step.args, { cwd: options.cwd, timeoutMs })
    const combined = `${result.stdout}\n${result.stderr}`.trim()

    steps.push({
      name: step.name,
      ok: result.code === 0 && !result.timedOut,
      durationMs: Date.now() - startedAt,
      output: redact(combined).slice(-OUTPUT_TAIL_CHARACTERS),
    })

    // Stop at the first failure. Running `build` after `typecheck` failed only
    // produces a second copy of the same error.
    if (result.code !== 0 || result.timedOut) break
  }

  const firstFailure = steps.find((step) => !step.ok) ?? null
  return { ok: firstFailure === null, steps, firstFailure }
}

export function formatVerification(outcome: VerificationOutcome): string {
  const lines = outcome.steps.map((step) => {
    const mark = step.ok ? 'pass' : 'FAIL'
    return `- ${mark} \`${step.name}\` (${Math.round(step.durationMs / 1000)}s)`
  })

  if (outcome.firstFailure !== null) {
    lines.push('', `<details><summary>${outcome.firstFailure.name} output</summary>`, '')
    lines.push('```', outcome.firstFailure.output.slice(-4000), '```', '</details>')
  }

  return lines.join('\n')
}
