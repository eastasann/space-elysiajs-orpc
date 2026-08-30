import { Panel } from '@newsdeck/ui'
import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <Panel title="Page not found" description="That route does not exist.">
      <p className="nd-note">
        <Link to="/">Return to the front page</Link>
      </p>
    </Panel>
  )
}
