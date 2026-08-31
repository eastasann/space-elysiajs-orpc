/**
 * Thrown by a job handler to mark a failure as permanent.
 *
 * BullMQ skips the remaining `attempts` for this specific error, regardless of
 * how many are left — the right response to a 404, an invalid URL, or anything
 * else that will not change on retry.
 */
export { UnrecoverableError } from 'bullmq'
