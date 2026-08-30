import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redact, redactJson } from './redact.ts'

/**
 * Per-execution logs, on disk and ignored by git.
 *
 * Everything written here goes through redaction first. The runner holds a
 * GitHub session and a Claude session; a log file is exactly the artefact
 * someone pastes into an issue when asking for help, so it must be safe to
 * paste. Claude authentication state is never recorded at all.
 */

export interface ExecutionLog {
  readonly directory: string
  line(text: string): Promise<void>
  artifact(name: string, value: unknown): Promise<void>
}

export async function createExecutionLog(root: string, issue: number): Promise<ExecutionLog> {
  const directory = join(root, '.loop', 'logs', `issue-${issue}`)
  await mkdir(directory, { recursive: true })

  const logPath = join(directory, 'runner.log')

  return {
    directory,
    async line(text) {
      await appendFile(logPath, `${new Date().toISOString()} ${redact(text)}\n`, 'utf8')
    },
    async artifact(name, value) {
      await writeFile(
        join(directory, name),
        `${JSON.stringify(redactJson(value), null, 2)}\n`,
        'utf8',
      )
    },
  }
}

/** A log that discards everything. Used by `--dry-run` and by tests. */
export function nullLog(): ExecutionLog {
  return {
    directory: '',
    line: async () => {},
    artifact: async () => {},
  }
}
