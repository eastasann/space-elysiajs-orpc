/**
 * Redaction for anything that reaches a log file, a prompt, or a GitHub comment.
 *
 * The runner handles a GitHub token, a Claude session and a `.env` file. None of
 * those may leak into `.loop/logs/`, into a model prompt, or into an issue
 * comment. Redaction is applied at the boundary rather than trusted to callers,
 * because the one place someone forgets is the one that ends up public.
 */

const PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '[redacted:github-token]', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: '[redacted:github-token]', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: '[redacted:anthropic-key]', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { label: '[redacted:openai-key]', pattern: /\bsk-[A-Za-z0-9]{32,}/g },
  { label: '[redacted:aws-key]', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: '[redacted:private-key]',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { label: '[redacted:bearer]', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  {
    // The leading `[A-Z0-9_]*` matters: `AUTH_LOCAL_SIGNING_KEY=` does not start
    // at a word boundary before `SIGNING`, and this repository's own variables
    // are named that way. The name is kept so a log still says what leaked.
    label: '$1=[redacted]',
    pattern:
      /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|SIGNING_KEY|PRIVATE_KEY))=\S+/gi,
  },
  // Credentials embedded in a connection string: postgres://user:pw@host
  { label: '$1//$2:[redacted]@', pattern: /\b(\w+:)\/\/([^:/@\s]+):[^@\s]+@/g },
]

/** Replace every credential-shaped substring with a marker. */
export function redact(text: string): string {
  let output = text
  for (const { label, pattern } of PATTERNS) output = output.replace(pattern, label)
  return output
}

/** Redact a value of any shape, preserving JSON structure. */
export function redactJson<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T
}
