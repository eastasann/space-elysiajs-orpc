import { z } from 'zod'
import { resolveOnPath, run } from './exec.ts'

/**
 * Claude Code, as an external capability.
 *
 * The runner detects whether Claude Code is installed and authenticated and
 * reports what to do about it. It never reads credential files, keychains or
 * session state, and never tries to authenticate on the developer's behalf.
 */

/** Shape of `claude auth status --json`, as emitted by 2.1.251. */
export const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  /** `oauth_token` for a subscription login, `api_key` for a console key. */
  authMethod: z.string().nullish(),
  apiProvider: z.string().nullish(),
})
export type AuthStatus = z.infer<typeof authStatusSchema>

export type ClaudeAvailability =
  | { available: false; reason: 'not-installed'; remedy: string }
  | { available: false; reason: 'not-authenticated'; remedy: string }
  | { available: false; reason: 'unreadable'; remedy: string; detail: string }
  | {
      available: true
      version: string
      authMethod: string
      /** True when the credential came from a subscription login or setup-token. */
      subscription: boolean
      /** Present when ANTHROPIC_API_KEY will silently take precedence. */
      warning?: string
    }

const SUBSCRIPTION_METHODS = new Set(['oauth_token', 'oauth', 'subscription', 'claudeai'])

export interface ClaudeProbeOptions {
  /** Overridden in tests. Defaults to the real CLI. */
  runner?: typeof run
  which?: (command: string) => string | null
  env?: Record<string, string | undefined>
}

/**
 * Establish whether Claude Code can be used right now.
 *
 * Deliberately cheap and side-effect free: it runs `--version` and
 * `auth status --json`, both of which are read-only and print no secrets.
 */
export async function probeClaude(options: ClaudeProbeOptions = {}): Promise<ClaudeAvailability> {
  const exec = options.runner ?? run
  const which = options.which ?? resolveOnPath
  const env = options.env ?? process.env

  if (which('claude') === null) {
    return {
      available: false,
      reason: 'not-installed',
      remedy: 'Install Claude Code and make sure `claude` is on PATH: https://code.claude.com/docs',
    }
  }

  const version = await exec('claude', ['--version'], { timeoutMs: 30_000, envProfile: 'claude' })
  if (version.code !== 0) {
    return {
      available: false,
      reason: 'unreadable',
      remedy: 'Run `claude --version` by hand and resolve whatever it reports.',
      detail: version.stderr.trim() || version.stdout.trim(),
    }
  }

  const status = await exec('claude', ['auth', 'status', '--json'], {
    timeoutMs: 30_000,
    envProfile: 'claude',
  })
  if (status.code !== 0) {
    return {
      available: false,
      reason: 'unreadable',
      remedy: 'Run `claude auth status` by hand and resolve whatever it reports.',
      detail: status.stderr.trim() || status.stdout.trim(),
    }
  }

  const parsed = authStatusSchema.safeParse(safeJson(status.stdout))
  if (!parsed.success) {
    return {
      available: false,
      reason: 'unreadable',
      remedy: 'Run `claude auth status --json` by hand; the runner could not read its output.',
      detail: parsed.error.issues.map((issue) => issue.message).join('; '),
    }
  }

  if (!parsed.data.loggedIn) {
    return {
      available: false,
      reason: 'not-authenticated',
      // The runner stops here rather than claiming an issue. Authentication is
      // an interactive act; it is not the runner's to perform.
      remedy:
        'Run `claude auth login` (interactive, opens a browser). For unattended runs, run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN.',
    }
  }

  const authMethod = parsed.data.authMethod ?? 'unknown'
  const availability: ClaudeAvailability = {
    available: true,
    version: version.stdout.trim(),
    authMethod,
    subscription: SUBSCRIPTION_METHODS.has(authMethod),
  }

  // Documented behaviour: in `-p` mode an API key present in the environment is
  // always used. A developer who expects their subscription to be billed
  // deserves to be told.
  if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== '') {
    return {
      ...availability,
      warning:
        'ANTHROPIC_API_KEY is set. In non-interactive mode Claude Code always uses it, so this run will bill the API rather than your subscription. Unset it to use the subscription.',
    }
  }

  return availability
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Shape of `claude -p --output-format json`, as emitted by 2.1.251. */
export const claudeResultSchema = z.object({
  type: z.string(),
  subtype: z.string().nullish(),
  is_error: z.boolean(),
  result: z.string().nullish(),
  session_id: z.string().nullish(),
  num_turns: z.number().nullish(),
  stop_reason: z.string().nullish(),
  total_cost_usd: z.number().nullish(),
  duration_ms: z.number().nullish(),
  permission_denials: z.array(z.unknown()).nullish(),
  /** Present when the invocation passed `--json-schema`. */
  structured_output: z.unknown().nullish(),
})
export type ClaudeResult = z.infer<typeof claudeResultSchema>

export type ClaudeInvocation =
  | { ok: true; result: ClaudeResult }
  | { ok: false; reason: string; stdout: string; stderr: string; exitCode: number }

/**
 * Interpret a finished `claude -p` invocation.
 *
 * Exit codes are documented as 0 for success, 1 for failure, 2 when a cost
 * ceiling is hit or authentication is rejected, 130/143 for signals. A run is
 * only treated as successful when the exit code says so *and* the payload says
 * so, because a model that reports failure inside a zero exit is still a
 * failure.
 */
export function interpretInvocation(
  exitCode: number,
  stdout: string,
  stderr: string,
  timedOut: boolean,
): ClaudeInvocation {
  if (timedOut) {
    return { ok: false, reason: 'Claude Code timed out', stdout, stderr, exitCode }
  }
  if (exitCode === 130 || exitCode === 143) {
    return { ok: false, reason: 'Claude Code was interrupted', stdout, stderr, exitCode }
  }
  if (exitCode === 2) {
    return {
      ok: false,
      reason: 'Claude Code stopped before running: cost ceiling reached or authentication rejected',
      stdout,
      stderr,
      exitCode,
    }
  }

  const parsed = claudeResultSchema.safeParse(safeJson(stdout))
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        exitCode === 0
          ? 'Claude Code returned output the runner could not parse as JSON'
          : `Claude Code exited ${exitCode}`,
      stdout,
      stderr,
      exitCode,
    }
  }

  if (exitCode !== 0 || parsed.data.is_error) {
    return {
      ok: false,
      reason: parsed.data.result ?? `Claude Code exited ${exitCode}`,
      stdout,
      stderr,
      exitCode,
    }
  }

  return { ok: true, result: parsed.data }
}
