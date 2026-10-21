/**
 * The errors of the AI assist layer. They live apart from the provider clients
 * and the retry layer, which both throw them, so neither imports the other.
 */

export class ProviderError extends Error {
  constructor(
    message,
    {
      code = 'providerError',
      status = undefined,
      hint = '',
      retryAfterMs = null,
      shouldRetry = undefined,
    } = {}
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.hint = hint
    // From the provider's Retry-After and x-should-retry headers, when it sent them
    this.retryAfterMs = retryAfterMs
    this.shouldRetry = shouldRetry
  }
}

/** The error a cancelled request ends with, the same one the clients throw. */
export function cancelledError() {
  return new ProviderError('Request was cancelled', { code: 'aborted' })
}
