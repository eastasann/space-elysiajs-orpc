import { Panel } from '@newsdeck/ui'
import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <Panel title="Page not found" description="That admin route does not exist.">
      <p className="nd-note">
        <Link to="/">Return to the dashboard</Link>
      </p>
    </Panel>
  )
}
