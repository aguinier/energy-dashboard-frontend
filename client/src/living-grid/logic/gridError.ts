/**
 * What to tell the reader when the day cannot be loaded.
 *
 * One case is worth separating from the rest: on a workstation the shared
 * SQLite replica is locked to every reader twice a day while it is rebuilt
 * inside a single transaction. The server answers 503 for that, and it clears
 * by itself — so the view should say "come back in a minute" rather than
 * present scheduled maintenance as a failure.
 */
export function describeGridError(error: unknown): string {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;

  if (status === 503) {
    return 'The database is being refreshed. This happens on a schedule and clears on its own — try again in a minute.';
  }
  if (status === 400) {
    return 'That date could not be read. Try today.';
  }
  if (status !== undefined && status >= 500) {
    return 'The API could not build the grid for this day.';
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'The API did not answer.';
}
