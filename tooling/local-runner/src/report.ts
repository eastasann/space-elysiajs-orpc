import { sanitiseForMarkdown } from '@newsdeck/loop'
import { redact } from './redact.ts'

/**
 * Text the runner publishes to GitHub.
 *
 * Two passes, in this order and never fewer: redaction removes anything
 * credential-shaped, then Markdown sanitisation stops untrusted text from
 * breaking out of a code fence and forging the rest of a comment. The loop
 * reads its own comments back as state, so a comment that can be forged is a
 * state store that can be forged.
 */
export function publishable(text: string): string {
  return sanitiseForMarkdown(redact(text))
}

export const RUNNER_MARKER = '<!-- newsdeck-local-runner -->'

export interface RunnerCommentInput {
  issue: number
  branch: string
  agent: string
  phase: string
  body: string
}

export function renderRunnerComment(input: RunnerCommentInput): string {
  return [
    RUNNER_MARKER,
    `### Local runner — ${publishable(input.phase)}`,
    '',
    `- Issue: #${input.issue}`,
    `- Branch: \`${publishable(input.branch)}\``,
    `- Agent: \`${publishable(input.agent)}\``,
    '',
    publishable(input.body),
    '',
    '_Posted by the local Claude Code runner (`bun run loop:once`). It does not merge; the GitHub merge gate does._',
  ].join('\n')
}
