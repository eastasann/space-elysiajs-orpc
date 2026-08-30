import { redact } from './redact.ts'

export interface RunOptions {
  cwd?: string
  /** Written to the child's stdin. Used for prompts, so they never touch argv. */
  stdin?: string
  timeoutMs?: number
  /** Extra variables added to the filtered environment. */
  env?: Record<string, string>
  /** Which credentials this child is allowed to see. Defaults to none. */
  envProfile?: EnvProfile
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** The command as it would be typed, redacted, for logs. */
  display: string
}

/**
 * Environment variables a child process is allowed to see.
 *
 * An allowlist, not a denylist. The developer's shell holds `DATABASE_URL`,
 * `AUTH_LOCAL_SIGNING_KEY` and whatever else `.env` exports; none of that is any
 * business of a coding agent, and a denylist would leak whatever nobody thought
 * to name.
 *
 * Split by purpose rather than pooled, so `bun run test` does not inherit a
 * Claude token and `claude` does not inherit a GitHub one. Each credential
 * reaches exactly the process that needs it.
 */
const BASE = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  // Proxy configuration, so the runner works behind one.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const

const CLAUDE_VARIABLES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
] as const

const GITHUB_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'] as const

/** `git` needs the ssh agent to push; nothing else does. */
const GIT_VARIABLES = ['SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'] as const

export const ENV_PROFILES = {
  /** Verification commands, and anything else with no credential to hold. */
  base: BASE,
  claude: [...BASE, ...CLAUDE_VARIABLES],
  github: [...BASE, ...GITHUB_VARIABLES, ...GIT_VARIABLES],
  git: [...BASE, ...GIT_VARIABLES],
} as const

export type EnvProfile = keyof typeof ENV_PROFILES

export function filteredEnvironment(
  source: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {},
  profile: EnvProfile = 'base',
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of ENV_PROFILES[profile]) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  return { ...environment, ...extra }
}

/**
 * Run a command.
 *
 * Arguments are always passed as an array and never through a shell. That is
 * the single property that makes it safe to put issue titles, branch names and
 * review findings anywhere near a subprocess: there is no shell to interpret
 * `$(...)`, backticks or `;`.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const display = redact([command, ...args].join(' '))

  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: filteredEnvironment(process.env, options.env, options.envProfile ?? 'base'),
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timedOut = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          child.kill()
          // A child that ignores SIGTERM must not hold the runner open. Give it
          // ten seconds to exit cleanly, then take it away.
          hardKill = setTimeout(() => child.kill('SIGKILL'), 10_000)
        }, options.timeoutMs)

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (timeout !== undefined) clearTimeout(timeout)
  if (hardKill !== undefined) clearTimeout(hardKill)

  return { code, stdout, stderr, timedOut, display }
}

/**
 * Absolute path of `command` on PATH, or null.
 *
 * Resolved without a shell on purpose: `sh -c "command -v ..."` would reintroduce
 * the one thing this module exists to avoid.
 */
export function resolveOnPath(command: string): string | null {
  return Bun.which(command)
}
