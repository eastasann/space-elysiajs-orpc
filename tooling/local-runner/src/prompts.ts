import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prompt templates.
 *
 * Kept as files under `prompts/` rather than as string literals so they can be
 * reviewed, diffed and improved like any other part of the repository. A prompt
 * that decides what an autonomous agent does deserves the same scrutiny as the
 * code that runs it.
 */

const PROMPT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export type PromptName = 'implement' | 'fix' | 'review'

export async function loadTemplate(name: PromptName): Promise<string> {
  return readFile(join(PROMPT_DIRECTORY, `${name}.md`), 'utf8')
}

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g

/**
 * Substitute `{{PLACEHOLDER}}` values.
 *
 * One pass, and substituted values are never rescanned: issue bodies are
 * untrusted, and a body containing `{{DIFF}}` must end up as those literal
 * characters rather than pulling another value into itself.
 */
export function render(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, key: string) => values[key] ?? match)
}

/**
 * Cap untrusted text before it goes into a prompt.
 *
 * A 400 000-character issue body is a denial of service against the context
 * window, and truncation is visible rather than silent.
 */
export function cap(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n[... truncated: ${text.length - limit} more characters ...]`
}

/**
 * Strip the delimiters the prompt uses to fence untrusted content.
 *
 * The prompts wrap issue bodies and diffs in `<issue>` and `<diff>` elements. A
 * body that closes the element early could append text that reads as though it
 * came from the runner. Neutralising the closing tags removes that.
 */
export function fence(text: string): string {
  return text
    .replaceAll('</issue>', '<\\/issue>')
    .replaceAll('</diff>', '<\\/diff>')
    .replaceAll('<issue', '<\\issue')
    .replaceAll('<diff', '<\\diff')
}
