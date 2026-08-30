export interface PanelProps {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
}

export function Panel({ title, description, actions, children }: PanelProps) {
  return (
    <section className="nd-panel">
      <header className="nd-panel__header">
        <div>
          <h2 className="nd-panel__title">{title}</h2>
          {description === undefined ? null : (
            <p className="nd-panel__description">{description}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="nd-panel__actions">{actions}</div>}
      </header>
      <div className="nd-panel__body">{children}</div>
    </section>
  )
}
