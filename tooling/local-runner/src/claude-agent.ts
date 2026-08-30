import { parseReviewResult, parseReviewText, type ReviewResult } from '@newsdeck/loop'
import type {
  CodingAgent,
  CodingOutcome,
  CodingTask,
  ReviewAgent,
  ReviewOutcome,
  ReviewTask,
} from './agent.ts'
import { interpretInvocation } from './claude.ts'
import { run } from './exec.ts'
import { cap, fence, loadTemplate, render } from './prompts.ts'
import { redact } from './redact.ts'
import { formatVerification } from './verify.ts'

/**
 * Claude Code as the coding and review agent.
 *
 * Two things are deliberate here. The prompt always arrives on stdin, never in
 * argv, so untrusted issue text never appears in a process listing and never
 * meets a shell. And the two roles get different tool sets: the implementer can
 * edit and run commands inside its worktree, the reviewer can only read.
 */

const ISSUE_BODY_LIMIT = 20_000
const DIFF_LIMIT = 120_000
const FEEDBACK_LIMIT = 20_000

export interface ClaudeAgentOptions {
  timeoutMs: number
  /** Model alias. Empty string means the CLI's configured default. */
  model?: string
  /** Hard cost ceiling per invocation, in USD. Undefined means no flag. */
  maxBudgetUsd?: number
  runner?: typeof run
  /** Echoes Claude's own progress to the console. */
  onLog?: (line: string) => void
}

function baseArgs(options: ClaudeAgentOptions): string[] {
  const args = ['-p', '--output-format', 'json']
  if (options.model !== undefined && options.model !== '') args.push('--model', options.model)
  if (options.maxBudgetUsd !== undefined)
    args.push('--max-budget-usd', String(options.maxBudgetUsd))
  return args
}

/**
 * Tools the implementer may use.
 *
 * Narrow on purpose. It needs to read, edit and run the repository's own
 * checks; it does not need to reach the network or drive git, because the
 * runner does the committing and pushing itself. `--permission-mode dontAsk`
 * suppresses prompts for what is already allowed — it does not widen the set,
 * which is why the blanket bypass mode is not used.
 */
const IMPLEMENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite'] as const

const IMPLEMENT_ALLOWED = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TodoWrite',
  'Bash(bun *)',
  'Bash(bunx *)',
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(ls *)',
  'Bash(cat *)',
  'Bash(rg *)',
] as const

const IMPLEMENT_DISALLOWED = [
  'WebFetch',
  'WebSearch',
  'Bash(git push*)',
  'Bash(git commit*)',
  'Bash(gh *)',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(ssh *)',
  'Bash(sudo *)',
  'Bash(docker *)',
] as const

export class ClaudeCodeCodingAgent implements CodingAgent {
  readonly name = 'claude-code'

  constructor(private readonly options: ClaudeAgentOptions) {}

  async implement(task: CodingTask): Promise<CodingOutcome> {
    const exec = this.options.runner ?? run

    const prompt = task.round === 0 ? await this.implementPrompt(task) : await this.fixPrompt(task)

    const args = [
      ...baseArgs(this.options),
      '--permission-mode',
      'dontAsk',
      '--add-dir',
      task.worktree,
      '--tools',
      ...IMPLEMENT_TOOLS,
      '--allowedTools',
      ...IMPLEMENT_ALLOWED,
      '--disallowedTools',
      ...IMPLEMENT_DISALLOWED,
    ]

    this.options.onLog?.(`claude: implementing #${task.issue} (round ${task.round})`)

    const result = await exec('claude', args, {
      cwd: task.worktree,
      stdin: prompt,
      timeoutMs: this.options.timeoutMs,
      // Claude's own credentials, and nothing else. No GitHub token reaches it.
      envProfile: 'claude',
    })

    const invocation = interpretInvocation(
      result.code,
      result.stdout,
      result.stderr,
      result.timedOut,
    )

    if (!invocation.ok) {
      return {
        ok: false,
        reason: invocation.reason,
        detail: redact(invocation.stderr.trim() || invocation.stdout.trim()).slice(-2000),
      }
    }

    return {
      ok: true,
      summary: redact(invocation.result.result ?? '').slice(0, 8000),
      sessionId: invocation.result.session_id ?? null,
      costUsd: invocation.result.total_cost_usd ?? null,
    }
  }

  private async implementPrompt(task: CodingTask): Promise<string> {
    return render(await loadTemplate('implement'), {
      BRANCH: task.branch,
      ISSUE_NUMBER: String(task.issue),
      ISSUE_TITLE: fence(cap(task.title, 500)),
      ISSUE_BODY: fence(cap(task.body, ISSUE_BODY_LIMIT)),
    })
  }

  private async fixPrompt(task: CodingTask): Promise<string> {
    return render(await loadTemplate('fix'), {
      BRANCH: task.branch,
      ISSUE_NUMBER: String(task.issue),
      ROUND: String(task.round),
      ISSUE_TITLE: fence(cap(task.title, 500)),
      ISSUE_BODY: fence(cap(task.body, ISSUE_BODY_LIMIT)),
      FEEDBACK: cap(formatFeedback(task), FEEDBACK_LIMIT),
    })
  }
}

/** Turn a review and a verification failure into something a fixer can act on. */
export function formatFeedback(task: CodingTask): string {
  const sections: string[] = []

  if (task.feedback !== undefined && task.feedback !== '') sections.push(task.feedback, '')

  if (task.verification !== undefined && !task.verification.ok) {
    sections.push('### Local verification failed', '', formatVerification(task.verification))
  }

  if (task.review !== undefined && task.review.findings.length > 0) {
    sections.push('### Review findings', '')
    for (const [index, finding] of task.review.findings.entries()) {
      const where =
        finding.file != null
          ? ` (\`${finding.file}${finding.line != null ? `:${finding.line}` : ''}\`)`
          : ''
      sections.push(
        `${index + 1}. **${finding.severity}**${where} — ${finding.description}`,
        `   Suggested: ${finding.suggested_action}`,
      )
    }
  }

  if (task.review !== undefined && task.review.summary !== '') {
    sections.push('', '### Reviewer summary', '', task.review.summary)
  }

  return sections.length === 0 ? 'No specific feedback was recorded.' : sections.join('\n')
}

/**
 * JSON Schema handed to `--json-schema`.
 *
 * It is a narrower statement of `ReviewResultSchema`: the model is asked only
 * for the fields it can know. `source` and `category` are stamped by the runner
 * so a model can never claim its finding came from a deterministic check.
 */
export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approve', 'request_changes', 'blocked'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          description: { type: 'string' },
          suggested_action: { type: 'string' },
        },
        required: ['severity', 'description', 'suggested_action'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['status', 'findings', 'summary'],
  additionalProperties: false,
} as const

export class ClaudeCodeReviewAgent implements ReviewAgent {
  readonly name = 'claude-code'

  constructor(private readonly options: ClaudeAgentOptions) {}

  async review(task: ReviewTask): Promise<ReviewOutcome> {
    const exec = this.options.runner ?? run

    const prompt = render(await loadTemplate('review'), {
      ISSUE_NUMBER: String(task.issue),
      ISSUE_TITLE: fence(cap(task.title, 500)),
      ISSUE_BODY: fence(cap(task.body, ISSUE_BODY_LIMIT)),
      BASE: task.base,
      BRANCH: task.branch,
      CHANGED_FILES: task.changedFiles.map((file) => `- ${file}`).join('\n') || '- (none)',
      DIFF: fence(cap(task.diff, DIFF_LIMIT)),
    })

    // `--restricted` removes the command-running tools outright and ignores the
    // developer's own settings files. A reviewer that could run commands could
    // also be talked into running them by the diff it is reviewing.
    const args = [
      ...baseArgs(this.options),
      '--restricted',
      '--strict-mcp-config',
      '--add-dir',
      task.worktree,
      '--tools',
      'Read',
      'Glob',
      'Grep',
      '--json-schema',
      JSON.stringify(REVIEW_JSON_SCHEMA),
    ]

    this.options.onLog?.(`claude: reviewing #${task.issue}`)

    const result = await exec('claude', args, {
      cwd: task.worktree,
      stdin: prompt,
      timeoutMs: this.options.timeoutMs,
      // Claude's own credentials, and nothing else. No GitHub token reaches it.
      envProfile: 'claude',
    })

    const invocation = interpretInvocation(
      result.code,
      result.stdout,
      result.stderr,
      result.timedOut,
    )

    if (!invocation.ok) {
      return {
        ok: false,
        reason: invocation.reason,
        detail: redact(invocation.stderr.trim() || invocation.stdout.trim()).slice(-2000),
      }
    }

    const review = extractReview(invocation.result.structured_output, invocation.result.result)
    if (review === null) {
      return {
        ok: false,
        reason: 'The review agent did not return a valid review result.',
        detail: redact(invocation.result.result ?? '').slice(0, 2000),
      }
    }

    return {
      ok: true,
      review,
      sessionId: invocation.result.session_id ?? null,
      costUsd: invocation.result.total_cost_usd ?? null,
    }
  }
}

/**
 * Validate the reviewer's output.
 *
 * `structured_output` is preferred because the CLI has already validated it
 * against the schema; the text result is a fallback for the case where it is
 * absent. Either way the payload goes through the loop's own validator before
 * anything reads it — a review the runner cannot parse is not an approval.
 */
export function extractReview(
  structured: unknown,
  text: string | null | undefined,
): ReviewResult | null {
  if (structured != null) {
    const parsed = parseReviewResult(structured)
    if (parsed.ok) return parsed.result
  }

  if (typeof text === 'string' && text.trim() !== '') {
    const parsed = parseReviewText(text)
    if (parsed.ok) return parsed.result
  }

  return null
}
