/**
 * Thrown when the caller got the request wrong (bad address, missing query).
 * Routes map this to 400 so a client mistake is never reported as an upstream
 * failure — crawlers and agents read those codes very differently.
 */
export class BadRequestError extends Error {
  readonly status = 400;
}

export function badRequest(message: string): never {
  throw new BadRequestError(message);
}
