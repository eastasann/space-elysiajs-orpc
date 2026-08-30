/**
 * Verify that the reverse proxy really distributes requests.
 *
 *   bun run verify:lb
 *   bun run verify:lb -- --requests 40 --base-url http://localhost:8080
 *
 * Two independent signals are collected per request:
 *
 *   - `X-Upstream-Addr`, added by nginx, names the backend socket it chose.
 *   - `instanceId` in the API's own response body names the replica that ran
 *     the handler.
 *
 * They are gathered separately on purpose: agreement between a proxy-reported
 * and an application-reported identity is much stronger evidence than either
 * alone.
 *
 * Exits non-zero when a pool that should have several instances answered from
 * only one, so this is usable as a check in CI.
 */

interface Options {
  baseUrl: string
  adminUrl: string
  requests: number
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    baseUrl: 'http://localhost:8080',
    adminUrl: 'http://localhost:8081',
    requests: 20,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) continue

    if (flag === '--base-url') options.baseUrl = value
    else if (flag === '--admin-url') options.adminUrl = value
    else if (flag === '--requests') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--requests must be a positive integer')
      }
      options.requests = parsed
    }
  }

  return options
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function render(title: string, counts: Map<string, number>): void {
  process.stdout.write(`\n  ${title}\n`)
  if (counts.size === 0) {
    process.stdout.write('    (no responses)\n')
    return
  }
  for (const [name, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`    ${name.padEnd(28)} ${count}\n`)
  }
}

interface PoolResult {
  upstreams: Map<string, number>
  instances: Map<string, number>
  failures: number
}

/**
 * Requests are issued sequentially rather than concurrently: parallel requests
 * can be multiplexed over one connection, which would understate the spread.
 */
async function samplePool(
  url: string,
  requests: number,
  readInstance: (response: Response) => Promise<string | null>,
): Promise<PoolResult> {
  const upstreams: string[] = []
  const instances: string[] = []
  let failures = 0

  for (let index = 0; index < requests; index += 1) {
    try {
      const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
      if (!response.ok) {
        failures += 1
        await response.body?.cancel()
        continue
      }

      const upstream = response.headers.get('x-upstream-addr')
      if (upstream !== null) upstreams.push(upstream)

      const instance = await readInstance(response)
      if (instance !== null) instances.push(instance)
    } catch {
      failures += 1
    }
  }

  return { upstreams: tally(upstreams), instances: tally(instances), failures }
}

const options = parseOptions(Bun.argv.slice(2))

process.stdout.write(`Sampling ${options.requests} requests per pool…\n`)

const api = await samplePool(
  `${options.baseUrl}/api/health`,
  options.requests,
  async (response) => {
    const body = (await response.json()) as { instanceId?: unknown }
    return typeof body.instanceId === 'string' ? body.instanceId : null
  },
)

const web = await samplePool(`${options.baseUrl}/`, options.requests, async (response) => {
  await response.body?.cancel()
  return null
})

process.stdout.write('\nAPI pool (browser -> proxy -> API)')
render('by nginx upstream', api.upstreams)
render('by API-reported instanceId', api.instances)
if (api.failures > 0) process.stdout.write(`    failures: ${api.failures}\n`)

process.stdout.write('\nWeb pool (browser -> proxy -> SSR server)')
render('by nginx upstream', web.upstreams)
if (web.failures > 0) process.stdout.write(`    failures: ${web.failures}\n`)

const problems: string[] = []
if (api.failures > 0) problems.push(`${api.failures} API request(s) failed`)
if (web.failures > 0) problems.push(`${web.failures} web request(s) failed`)
if (api.instances.size < 2) {
  problems.push(`API answered from ${api.instances.size} instance(s); expected at least 2`)
}
if (web.upstreams.size < 2) {
  problems.push(`web answered from ${web.upstreams.size} upstream(s); expected at least 2`)
}

if (problems.length > 0) {
  process.stdout.write(`\nFAILED:\n${problems.map((line) => `  - ${line}`).join('\n')}\n`)
  process.exit(1)
}

process.stdout.write('\nOK: both pools distributed requests across multiple instances.\n')
