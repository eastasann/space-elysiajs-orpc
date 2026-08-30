export interface HealthServerOptions {
  port: number
  instanceId: string
  startedAt: number
}

/**
 * Minimal liveness endpoint.
 *
 * The worker serves no application traffic, but the container runtime still
 * needs a way to tell "running" from "wedged". Kept to process state only, for
 * the same reason as the API's `/health`.
 */
export function startHealthServer(options: HealthServerOptions) {
  return Bun.serve({
    port: options.port,
    hostname: '0.0.0.0',
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname !== '/health') return new Response('not found', { status: 404 })

      return Response.json({
        status: 'ok',
        service: 'worker',
        instanceId: options.instanceId,
        uptimeSeconds: Math.round((Date.now() - options.startedAt) / 1000),
      })
    },
  })
}

export type HealthServer = ReturnType<typeof startHealthServer>
