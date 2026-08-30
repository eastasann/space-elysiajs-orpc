/**
 * Prefix for every Redis key this package owns — BullMQ's queue keys and the
 * worker heartbeat alike.
 *
 * It exists so that several independent deployments, or several concurrent
 * test suites, can share one Redis instance without consuming each other's
 * jobs. Callers that do not care pass nothing.
 */
export const DEFAULT_JOBS_NAMESPACE = 'newsdeck'
