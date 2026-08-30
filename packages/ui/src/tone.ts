export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral'

/** Map a boolean health signal onto a display tone. */
export function statusTone(ok: boolean | null | undefined): StatusTone {
  if (ok === true) return 'ok'
  if (ok === false) return 'error'
  return 'neutral'
}
