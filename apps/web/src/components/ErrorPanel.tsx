import { Panel } from '@newsdeck/ui'
import type { ErrorComponentProps } from '@tanstack/react-router'

/**
 * Renders only the error message. Stacks and causes stay in the server log,
 * where they are already correlated by request id.
 */
export function ErrorPanel({ error }: ErrorComponentProps) {
  return (
    <Panel title="Something went wrong" description="The page could not be rendered.">
      <p className="nd-note">{error instanceof Error ? error.message : 'Unknown error'}</p>
    </Panel>
  )
}
