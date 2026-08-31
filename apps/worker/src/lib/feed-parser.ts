import { createHash } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

/**
 * Turns a fetched feed document into normalised article candidates.
 *
 * Pure: no network, no filesystem, no database. That is what keeps the
 * fixture tests cheap and lets deduplication and persistence be written
 * against this module's output alone. Logging is the caller's job — this
 * module only counts what it skipped and says why.
 */

const TITLE_MAX_LENGTH = 500
const SUMMARY_MAX_LENGTH = 2_000

/** `utm_*` covers the whole GA/Ads family; these two are the other common trackers. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid'])

export interface ArticleCandidate {
  url: string
  canonicalUrl: string
  title: string
  summary: string | null
  author: string | null
  imageUrl: string | null
  /** See `computeContentHash` for the exact rule. */
  contentHash: string
  publishedAt: Date | null
}

export type SkippedEntryReason = 'missing-url' | 'missing-title'

export interface SkippedEntry {
  /** Position of the entry within the feed, for correlating with a log line. */
  index: number
  reason: SkippedEntryReason
}

export interface ParseFeedResult {
  candidates: ArticleCandidate[]
  skipped: SkippedEntry[]
}

export type FeedParseErrorReason = 'invalid-xml' | 'invalid-json' | 'unrecognized-format'

export class FeedParseError extends Error {
  readonly reason: FeedParseErrorReason

  constructor(reason: FeedParseErrorReason, message: string) {
    super(message)
    this.name = 'FeedParseError'
    this.reason = reason
  }
}

// `parseTagValue`/`parseAttributeValue` are left at `false` so a numeric-looking
// title or id (e.g. `<id>12345</id>`) is never silently turned into a number.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (tagName) => tagName === 'item' || tagName === 'entry',
})

export function parseFeed(body: string): ParseFeedResult {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    return parseJsonFeedBody(trimmed)
  }
  return parseXmlFeedBody(body)
}

// ---------------------------------------------------------------------------
// RSS 2.0 / Atom
// ---------------------------------------------------------------------------

function parseXmlFeedBody(body: string): ParseFeedResult {
  const validation = XMLValidator.validate(body)
  if (validation !== true) {
    throw new FeedParseError('invalid-xml', `feed body is not valid XML: ${validation.err.msg}`)
  }

  const doc = xmlParser.parse(body) as Record<string, unknown>

  if (doc.rss) return parseRssItems(doc.rss as Record<string, unknown>)
  if (doc.feed) return parseAtomEntries(doc.feed as Record<string, unknown>)

  throw new FeedParseError('unrecognized-format', 'XML document root is neither <rss> nor <feed>')
}

function parseRssItems(rss: Record<string, unknown>): ParseFeedResult {
  const channel = (rss.channel as Record<string, unknown> | undefined) ?? {}
  const items = toArray(channel.item)

  return buildCandidates(items, (item) => {
    const record = item as Record<string, unknown>
    return {
      url: textOf(record.link),
      title: textOf(record.title),
      summary: textOf(record.description),
      author: textOf(record.author) ?? textOf(record['dc:creator']),
      imageUrl: extractRssImage(record),
      publishedAt: textOf(record.pubDate),
    }
  })
}

function extractRssImage(item: Record<string, unknown>): string | undefined {
  for (const enclosure of toArray(item.enclosure)) {
    const url = attrOf(enclosure, '@_url')
    const type = attrOf(enclosure, '@_type')
    if (url && (type === undefined || type.startsWith('image/'))) return url
  }
  return extractMediaThumbnail(item)
}

function parseAtomEntries(feed: Record<string, unknown>): ParseFeedResult {
  const entries = toArray(feed.entry)

  return buildCandidates(entries, (entry) => {
    const record = entry as Record<string, unknown>
    return {
      url: extractAtomUrl(record),
      title: textOf(record.title),
      summary: textOf(record.summary) ?? textOf(record.content),
      author: extractAtomAuthor(record),
      imageUrl: extractMediaThumbnail(record),
      publishedAt: textOf(record.published) ?? textOf(record.updated),
    }
  })
}

function extractAtomUrl(entry: Record<string, unknown>): string | undefined {
  const links = toArray(entry.link)
  const relOf = (link: unknown) => attrOf(link, '@_rel')
  const alternate = links.find((link) => relOf(link) === undefined || relOf(link) === 'alternate')
  return hrefOf(alternate) ?? hrefOf(links[0])
}

function extractAtomAuthor(entry: Record<string, unknown>): string | undefined {
  const first = toArray(entry.author)[0] as Record<string, unknown> | undefined
  return first ? textOf(first.name) : undefined
}

/** Media RSS thumbnails, used by both RSS and Atom feeds in the wild. */
function extractMediaThumbnail(node: Record<string, unknown>): string | undefined {
  const thumbnail = toArray(node['media:thumbnail'])[0]
  return attrOf(thumbnail, '@_url')
}

function hrefOf(link: unknown): string | undefined {
  if (typeof link === 'string') return link
  return attrOf(link, '@_href')
}

function attrOf(node: unknown, attrName: string): string | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const value = (node as Record<string, unknown>)[attrName]
  return typeof value === 'string' ? value : undefined
}

/** An XML tag's value: either a plain string, or `{ '#text': ..., '@_...': ... }` when it carries attributes. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (
    value !== null &&
    typeof value === 'object' &&
    '#text' in (value as Record<string, unknown>)
  ) {
    const text = (value as Record<string, unknown>)['#text']
    return typeof text === 'string' ? text : undefined
  }
  return undefined
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

// ---------------------------------------------------------------------------
// JSON Feed
// ---------------------------------------------------------------------------

function parseJsonFeedBody(body: string): ParseFeedResult {
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new FeedParseError('invalid-json', `feed body is not valid JSON: ${message}`)
  }

  if (doc === null || typeof doc !== 'object') {
    throw new FeedParseError('unrecognized-format', 'JSON feed body is not an object')
  }

  const record = doc as Record<string, unknown>
  if (typeof record.version !== 'string' || !record.version.includes('jsonfeed.org')) {
    throw new FeedParseError(
      'unrecognized-format',
      'JSON body does not declare a JSON Feed version',
    )
  }

  const items = Array.isArray(record.items) ? record.items : []

  return buildCandidates(items, (item) => {
    const entry = item as Record<string, unknown>
    const author = entry.author as Record<string, unknown> | undefined
    const authors = Array.isArray(entry.authors) ? (entry.authors as Record<string, unknown>[]) : []

    return {
      url: stringField(entry.url),
      title: stringField(entry.title),
      summary:
        stringField(entry.summary) ??
        stringField(entry.content_text) ??
        stringField(entry.content_html),
      author: stringField(author?.name) ?? stringField(authors[0]?.name),
      imageUrl: stringField(entry.image),
      publishedAt: stringField(entry.date_published) ?? stringField(entry.date_modified),
    }
  })
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// ---------------------------------------------------------------------------
// Shared candidate assembly
// ---------------------------------------------------------------------------

interface RawEntryFields {
  url: string | undefined
  title: string | undefined
  summary: string | undefined
  author: string | undefined
  imageUrl: string | undefined
  publishedAt: string | undefined
}

function buildCandidates<T>(
  rawEntries: T[],
  extract: (entry: T) => RawEntryFields,
): ParseFeedResult {
  const candidates: ArticleCandidate[] = []
  const skipped: SkippedEntry[] = []

  rawEntries.forEach((entry, index) => {
    const raw = extract(entry)
    const canonicalUrl = raw.url ? canonicalizeUrl(raw.url) : null
    if (!raw.url || canonicalUrl === null) {
      skipped.push({ index, reason: 'missing-url' })
      return
    }

    const title = sanitizeText(raw.title, TITLE_MAX_LENGTH)
    if (title.length === 0) {
      skipped.push({ index, reason: 'missing-title' })
      return
    }

    const summaryText = sanitizeText(raw.summary, SUMMARY_MAX_LENGTH)
    const summary = summaryText.length > 0 ? summaryText : null
    const author = sanitizeText(raw.author, TITLE_MAX_LENGTH)

    candidates.push({
      url: raw.url,
      canonicalUrl,
      title,
      summary,
      author: author.length > 0 ? author : null,
      imageUrl: raw.imageUrl ?? null,
      contentHash: computeContentHash(title, summary ?? ''),
      publishedAt: parseDate(raw.publishedAt),
    })
  })

  return { candidates, skipped }
}

/**
 * `sha256("<title>\n<summary>")`, after both have gone through the same
 * decode/strip/collapse pipeline as the candidate itself.
 *
 * The url is deliberately excluded: `articles.content_hash` exists to catch
 * the same story republished under a different URL (syndication, a tracking
 * redirect, a site migration), which only works if the hash does not depend
 * on the url in the first place. `canonical_url` already carries the
 * per-url identity; this carries the per-content identity.
 */
function computeContentHash(title: string, summary: string): string {
  return createHash('sha256').update(`${title}\n${summary}`).digest('hex')
}

// ---------------------------------------------------------------------------
// Text and url normalisation
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** A second decode pass beyond what the XML parser already does, for entities re-encoded inside CDATA HTML. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return NAMED_ENTITIES[entity] ?? match
  })
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, ' ')
}

function sanitizeText(raw: string | undefined, maxLength: number): string {
  if (!raw) return ''
  const collapsed = stripHtmlTags(decodeEntities(raw)).replace(/\s+/g, ' ').trim()
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed
}

const TRACKING_PARAM_PREFIX = 'utm_'

function canonicalizeUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  url.hostname = url.hostname.toLowerCase()
  url.hash = ''

  const defaultPort = url.protocol === 'https:' ? '443' : '80'
  if (url.port === defaultPort) url.port = ''

  for (const key of [...url.searchParams.keys()]) {
    const lowered = key.toLowerCase()
    if (lowered.startsWith(TRACKING_PARAM_PREFIX) || TRACKING_PARAMS.has(lowered)) {
      url.searchParams.delete(key)
    }
  }

  return url.toString()
}

/** A bare `YYYY-MM-DDTHH:mm:ss` has no zone; `Date` would otherwise read it as local time. */
const BARE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const normalized = BARE_DATETIME_PATTERN.test(trimmed) ? `${trimmed}Z` : trimmed
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}
