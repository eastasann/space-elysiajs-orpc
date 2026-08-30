export interface KeyValueEntry {
  label: string
  value: React.ReactNode
}

export interface KeyValueListProps {
  entries: readonly KeyValueEntry[]
}

export function KeyValueList({ entries }: KeyValueListProps) {
  return (
    <dl className="nd-kv">
      {entries.map((entry) => (
        <div className="nd-kv__row" key={entry.label}>
          <dt className="nd-kv__key">{entry.label}</dt>
          <dd className="nd-kv__value">{entry.value}</dd>
        </div>
      ))}
    </dl>
  )
}
