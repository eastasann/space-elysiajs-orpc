import pino from 'pino'

export type Logger = pino.Logger

export interface LoggerOptions {
  /** Logical service name, e.g. `api`, `worker`. Present on every record. */
  service: string
  /** Identifies which replica emitted a record. Essential behind a load balancer. */
  instanceId: string
  level?: string
  /**
   * Where records are written. Defaults to stdout; tests and embedding hosts
   * can supply their own sink instead of reaching into pino's internals.
   */
  destination?: pino.DestinationStream
}

/**
 * Create the root logger for a process.
 *
 * Output is newline-delimited JSON on stdout. Container runtimes and log
 * shippers already handle collection, so this package deliberately does not
 * own transports, files or rotation.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: {
        service: options.service,
        instanceId: options.instanceId,
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'headers.cookie',
          '*.password',
          '*.token',
          '*.accessToken',
          '*.refreshToken',
        ],
        censor: '[redacted]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination ?? pino.destination({ dest: 1, sync: false }),
  )
}
