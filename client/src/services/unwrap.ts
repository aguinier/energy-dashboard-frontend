import type { ApiResponse } from '@/types';

/**
 * Pull the payload out of the `{ success, data }` envelope.
 *
 * Returning `data.data` unchecked meant a proxy error page (HTML, HTTP 200)
 * became `undefined`, which React Query rejects with an opaque message while
 * the feature silently breaks.
 */
export function unwrap<T>(body: unknown, endpoint: string): T {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error(
      `Malformed response from ${endpoint}: expected a { success, data } envelope, got ${typeof body}`,
    );
  }
  return (body as ApiResponse<T>).data;
}
