import type { StatusTone } from './tone.ts'

export type { StatusTone }

export interface StatusBadgeProps {
  tone: StatusTone
  children: React.ReactNode
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span className={`nd-badge nd-badge--${tone}`} data-tone={tone}>
      {children}
    </span>
  )
}
