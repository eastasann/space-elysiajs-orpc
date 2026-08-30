import type { PullRequestDiff } from '../diff.ts'
import type { Finding } from '../review.ts'

/**
 * High-confidence credential shapes only.
 *
 * A scanner that cries wolf gets ignored, and this one gates merges. Generic
 * `password=` style matches are deliberately excluded unless the value is long
 * and quoted, so the repository's own documented local development values in
 * `.env.example` do not trip it.
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  { name: 'GitHub personal access token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'GitHub App token', pattern: /\bgh[sour]_[A-Za-z0-9]{36}\b/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'long quoted credential literal',
    pattern:
      /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{32,}["']/i,
  },
]

/** Credential-shaped strings among the lines a pull request adds. */
export function checkSecrets(diff: PullRequestDiff): Finding[] {
  const findings: Finding[] = []

  for (const file of diff.files) {
    for (const line of file.addedLines) {
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (!pattern.test(line)) continue

        findings.push({
          severity: 'critical',
          file: file.path,
          line: null,
          // The matched value is never echoed: reporting a leaked credential
          // must not copy it into a public comment and a job log.
          description: `Possible ${name} added in ${file.path}.`,
          suggested_action:
            'Remove the value, rotate the credential if it is real, and move it to a secret store.',
          source: 'check:secrets',
          category: 'security',
        })
        break
      }
    }
  }

  return findings
}
