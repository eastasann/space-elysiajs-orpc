/**
 * Header used to propagate a correlation id across every process boundary
 * (browser -> proxy -> web SSR -> proxy -> API -> queue -> worker).
 */
export const REQUEST_ID_HEADER = 'x-request-id'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/

export function newRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Return the caller-supplied correlation id, or a fresh one.
 *
 * Inbound ids are validated before being trusted: they end up in log records
 * and in downstream headers, so an unbounded or control-character-bearing
 * value from the public internet must never be echoed back verbatim.
 */
export function readRequestId(headers: { get(name: string): string | null }): string {
  const candidate = headers.get(REQUEST_ID_HEADER)
  if (candidate !== null && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate
  }
  return newRequestId()
}
