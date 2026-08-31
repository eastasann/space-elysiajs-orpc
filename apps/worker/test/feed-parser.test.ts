import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FeedParseError, parseFeed } from '../src/lib/feed-parser.ts'

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/feeds/${name}`, import.meta.url).pathname, 'utf8')
}

describe('parseFeed: RSS 2.0', () => {
  it('normalises items into article candidates', () => {
    const result = parseFeed(fixture('rss.xml'))

    expect(result.skipped).toEqual([])
    expect(result.candidates).toHaveLength(2)

    const [first, second] = result.candidates

    expect(first).toMatchObject({
      url: 'https://Example.test:443/news/budget?utm_source=newsletter&utm_campaign=weekly&ref=front-page#top',
      canonicalUrl: 'https://example.test/news/budget?ref=front-page',
      title: 'Council approves new budget',
      summary: 'The council voted 5-2 to approve the budget. Extra whitespace here.',
      author: 'editor@example.test (Jane Doe)',
      imageUrl: 'https://example.test/images/budget.jpg',
    })
    expect(first?.publishedAt).toEqual(new Date('2024-01-01T12:00:00.000Z'))
    expect(first?.contentHash).toMatch(/^[0-9a-f]{64}$/)

    expect(second).toMatchObject({
      canonicalUrl: 'https://example.test/news/second',
      title: 'Second story, syndicated',
      author: 'Wire Service',
      imageUrl: 'https://example.test/images/second.jpg',
      publishedAt: null,
    })
  })

  it('skips entries missing a usable url or title, and counts each one', () => {
    const result = parseFeed(fixture('rss-skips.xml'))

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.title).toBe('Good entry')
    expect(result.skipped).toEqual([
      { index: 0, reason: 'missing-url' },
      { index: 1, reason: 'missing-title' },
      { index: 2, reason: 'missing-title' },
    ])
  })
})

describe('parseFeed: Atom', () => {
  it('normalises entries into article candidates', () => {
    const result = parseFeed(fixture('atom.xml'))

    expect(result.skipped).toEqual([])
    expect(result.candidates).toHaveLength(2)

    const [first, second] = result.candidates

    expect(first).toMatchObject({
      canonicalUrl: 'https://example.test/weather/storm',
      title: 'Storm & flooding warning issued',
      summary: 'Residents near the river should prepare to evacuate.',
      author: 'Alex Rivera',
    })
    // Bare (zone-less) datetime is treated as UTC, not host-local time.
    expect(first?.publishedAt).toEqual(new Date('2024-02-01T08:30:00.000Z'))

    expect(second).toMatchObject({
      canonicalUrl: 'https://example.test/weather/second',
      title: 'Second entry, content only',
      summary: 'Full content used as summary, since there is no summary element.',
      author: null,
    })
    expect(second?.publishedAt).toEqual(new Date('2024-02-02T07:00:00.000Z'))
  })
})

describe('parseFeed: JSON Feed', () => {
  it('normalises items into article candidates', () => {
    const result = parseFeed(fixture('jsonfeed.json'))

    expect(result.skipped).toEqual([])
    expect(result.candidates).toHaveLength(2)

    const [first, second] = result.candidates

    expect(first).toMatchObject({
      canonicalUrl: 'https://example.test/articles/one',
      title: 'Launch day recap',
      summary: 'It went well.',
      author: 'Priya Nair',
      imageUrl: 'https://example.test/images/one.jpg',
    })
    expect(first?.publishedAt).toEqual(new Date('2024-03-05T10:15:00.000Z'))

    expect(second).toMatchObject({
      title: 'Second article',
      summary: 'A short summary takes priority over content_text.',
      author: 'Legacy Author Field',
    })
    expect(second?.publishedAt).toEqual(new Date('2024-03-06T00:00:00.000Z'))
  })
})

describe('parseFeed: content hash', () => {
  it('is stable across different urls carrying the same title and summary', () => {
    const a = parseFeed(fixture('rss.xml')).candidates[0]
    expect(a).toBeDefined()

    const republished = fixture('rss.xml').replace(
      'https://Example.test:443/news/budget?utm_source=newsletter&amp;utm_campaign=weekly&amp;ref=front-page#top',
      'https://mirror.test/copy-of-budget-story',
    )
    const b = parseFeed(republished).candidates[0]
    expect(b).toBeDefined()

    expect(b?.contentHash).toBe(a?.contentHash)
    expect(b?.canonicalUrl).not.toBe(a?.canonicalUrl)
  })
})

describe('parseFeed: text and url normalisation', () => {
  function jsonFeedWith(item: Record<string, unknown>): string {
    return JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      items: [item],
    })
  }

  it('bounds title and summary length', () => {
    const result = parseFeed(
      jsonFeedWith({
        url: 'https://example.test/long',
        title: 'T'.repeat(600),
        summary: 'S'.repeat(3_000),
      }),
    )

    expect(result.candidates[0]?.title).toHaveLength(500)
    expect(result.candidates[0]?.summary).toHaveLength(2_000)
  })

  it('skips an entry whose url is present but unusable', () => {
    const result = parseFeed(
      jsonFeedWith({ url: 'not a valid url', title: 'Has a title, no usable url' }),
    )

    expect(result.candidates).toEqual([])
    expect(result.skipped).toEqual([{ index: 0, reason: 'missing-url' }])
  })

  it('drops a default port for http as well as https', () => {
    const result = parseFeed(
      jsonFeedWith({ url: 'http://example.test:80/path', title: 'Default http port' }),
    )

    expect(result.candidates[0]?.canonicalUrl).toBe('http://example.test/path')
  })
})

describe('parseFeed: malformed input', () => {
  it.each([
    ['malformed.xml', 'invalid-xml'],
    ['unsupported.xml', 'unrecognized-format'],
    ['malformed.json', 'invalid-json'],
    ['unsupported.json', 'unrecognized-format'],
  ] as const)('raises a FeedParseError for %s with reason %s', (name, reason) => {
    expect(() => parseFeed(fixture(name))).toThrow(FeedParseError)
    try {
      parseFeed(fixture(name))
      throw new Error('expected parseFeed to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(FeedParseError)
      expect((error as InstanceType<typeof FeedParseError>).reason).toBe(reason)
    }
  })

  it('never fails the whole batch for one bad entry', () => {
    const result = parseFeed(fixture('rss-skips.xml'))
    expect(result.candidates.length + result.skipped.length).toBe(4)
  })
})
