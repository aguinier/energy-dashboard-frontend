/**
 * Retry predicate for TanStack Query's `defaultOptions.queries.retry`.
 *
 * The API is single-threaded and synchronous (better-sqlite3); one slow
 * query blocks every other request the server is handling. Retrying a
 * failure multiplies exactly the load that caused it, so this caps retries
 * at one and never retries a 4xx — a client error won't succeed just
 * because it's asked again.
 *
 * A request timeout (axios `ECONNABORTED`) has no `error.response` at all,
 * so `status` is `undefined` here and the timeout falls through to the same
 * "one retry" branch as a 5xx or bare network error. That's intentional: on
 * this backend a timeout usually means the single request-handling thread
 * was busy with someone else's slow query, not that this request is
 * inherently unservable, so one bounded retry after a short backoff can
 * still succeed. It is exactly one retry, never a repeat of the amplifying
 * `retry: 2` this replaces.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
  if (status && status >= 400 && status < 500) return false;
  return failureCount < 1;
}
