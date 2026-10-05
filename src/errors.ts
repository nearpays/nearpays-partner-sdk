/** What is left on a mandate, sent with a `mandate_limit_exceeded` refusal. */
export interface Headroom {
  perTransaction: string;
  today: string;
  thisMonth: string;
  transactionsToday: number;
}

/**
 * Every failure the SDK reports. `code` is stable and safe to branch on:
 * the API's own error code (`mandate_limit_exceeded`, `mandate_unavailable`,
 * `insufficient_scope`…) when it sent one, otherwise one derived from the
 * HTTP status (`bad_request`, `not_found`, `conflict`…).
 */
export class NearpaysError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly headroom: Headroom | undefined;
  readonly body: unknown;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number;
      headroom?: Headroom;
      body?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'NearpaysError';
    this.code = code;
    this.status = options.status;
    this.headroom = options.headroom;
    this.body = options.body;
  }
}

/**
 * The customer has no live connection: never connected, disconnected in the
 * Nearpays app, or the connection expired. Send them through `connect()` again.
 */
export class NotConnectedError extends NearpaysError {
  constructor(customer: string, cause?: unknown) {
    super(
      'not_connected',
      `Customer ${customer} is not connected to Nearpays`,
      { cause },
    );
    this.name = 'NotConnectedError';
  }
}

/** A webhook whose signature, timestamp or body could not be trusted. */
export class WebhookVerificationError extends NearpaysError {
  constructor(message: string) {
    super('invalid_webhook', message, { status: 401 });
    this.name = 'WebhookVerificationError';
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'unprocessable',
  429: 'rate_limited',
};

/** The error an API response stands for. */
export function errorFromResponse(
  status: number,
  body: unknown,
  challenge?: { error?: string; description?: string },
): NearpaysError {
  const envelope = (body && typeof body === 'object' ? body : {}) as Record<
    string,
    unknown
  >;
  const apiCode =
    typeof envelope.error === 'string' && /^[a-z][a-z0-9_]*$/.test(envelope.error)
      ? envelope.error
      : undefined;
  const code =
    challenge?.error ??
    apiCode ??
    STATUS_CODES[status] ??
    (status >= 500 ? 'server_error' : 'request_failed');
  const message =
    (typeof envelope.message === 'string' && envelope.message) ||
    challenge?.description ||
    `Nearpays answered ${status}`;
  return new NearpaysError(code, message, {
    status,
    headroom: envelope.headroom as Headroom | undefined,
    body,
  });
}
