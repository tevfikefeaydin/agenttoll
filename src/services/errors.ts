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

export function errorResponse(error: unknown, requestId: string) {
  const err = error as { status?: number; statusCode?: number; name?: string; type?: string; message?: string } | null;
  const bad = error instanceof BadRequestError || err?.status === 400 || err?.type === 'entity.parse.failed';
  const tooLarge = err?.status === 413;
  const timeout = err?.name === 'TimeoutError' || err?.name === 'FacilitatorTimeoutError';
  const status = bad ? 400 : tooLarge ? 413 : timeout ? 504 : 502;
  return { status, body: {
    error: error instanceof BadRequestError ? error.message : bad ? 'Malformed request body' : tooLarge ? 'Request body is too large' : timeout ? 'Request timed out — please retry' : 'Upstream data is unavailable — please retry',
    code: bad ? 'BAD_REQUEST' : tooLarge ? 'PAYLOAD_TOO_LARGE' : timeout ? 'REQUEST_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
    retryable: status >= 500,
    retryAfter: status >= 500 ? 5 : null,
    requestId,
  } };
}
