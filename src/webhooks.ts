import { createHmac, timingSafeEqual } from 'node:crypto';
import { NearpaysError, WebhookVerificationError } from './errors.ts';
import { type Store, storeKeys } from './store.ts';
import type { WebhookEvent, WebhookHandlers } from './types.ts';

type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>;

/** Nearpays retries a delivery for about a day and a half; remember ids a little longer. */
const SEEN_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * Verifies and dispatches Nearpays webhooks. Nearpays signs
 * `"<timestamp>.<raw body>"` with HMAC-SHA256 and your webhook secret, and
 * sends it as `X-Nearpays-Signature: v1=<hex>` with `X-Nearpays-Timestamp`.
 */
export class Webhooks {
  readonly #secret: string | undefined;
  readonly #store: Store;
  readonly #now: () => number;
  readonly #forget: (sub: string, grantId: string | undefined) => Promise<string | undefined>;

  constructor(options: {
    secret: string | undefined;
    store: Store;
    now: () => number;
    forget: (sub: string, grantId: string | undefined) => Promise<string | undefined>;
  }) {
    this.#secret = options.secret;
    this.#store = options.store;
    this.#now = options.now;
    this.#forget = options.forget;
  }

  /**
   * Checks a delivery and returns its event. Pass the body exactly as it
   * arrived (a Buffer or string), never re-serialised JSON. Throws
   * WebhookVerificationError if anything is off.
   */
  verify(
    rawBody: string | Uint8Array,
    headers: HeaderBag,
    options: { toleranceSeconds?: number } = {},
  ): WebhookEvent {
    if (!this.#secret) {
      throw new NearpaysError('invalid_options', 'webhookSecret is not configured');
    }
    if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
      throw new WebhookVerificationError(
        'The webhook body must be the raw request body (a Buffer or string), e.g. from express.raw()',
      );
    }
    const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
    const timestamp = header(headers, 'x-nearpays-timestamp');
    const signatures = (header(headers, 'x-nearpays-signature') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('v1='))
      .map((s) => s.slice(3));
    if (!timestamp || !signatures.length) {
      throw new WebhookVerificationError('Missing Nearpays signature headers');
    }
    const age = Math.abs(this.#now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > (options.toleranceSeconds ?? 300)) {
      throw new WebhookVerificationError('The webhook timestamp is too old or invalid');
    }
    const expected = Buffer.from(
      createHmac('sha256', this.#secret).update(`${timestamp}.${body}`).digest('hex'),
    );
    const matches = signatures.some((given) => {
      const g = Buffer.from(given);
      return g.length === expected.length && timingSafeEqual(g, expected);
    });
    if (!matches) {
      throw new WebhookVerificationError('The webhook signature does not match');
    }
    try {
      return JSON.parse(body) as WebhookEvent;
    } catch {
      throw new WebhookVerificationError('The webhook body is not JSON');
    }
  }

  /**
   * Verifies a delivery, then runs your handler for its type (or `'*'`).
   *
   * - `event.customer` is your id for the customer, when known.
   * - On `grant.revoked`, the stored connection is forgotten first, unless a
   *   newer connection replaced it.
   * - A delivery already handled is skipped (`duplicate: true`). A handler that
   *   throws is not marked handled, so Nearpays' retry runs it again.
   */
  async handle(
    rawBody: string | Uint8Array,
    headers: HeaderBag,
    handlers: WebhookHandlers,
  ): Promise<{ event: WebhookEvent; duplicate: boolean }> {
    const event = this.verify(rawBody, headers);
    if (event.id && (await this.#store.get(storeKeys.webhook(event.id)))) {
      return { event, duplicate: true };
    }
    const sub = typeof event.data?.sub === 'string' ? event.data.sub : undefined;
    if (sub) {
      event.customer =
        event.type === 'grant.revoked'
          ? await this.#forget(sub, event.data.grantId as string | undefined)
          : ((await this.#store.get(storeKeys.subject(sub))) ?? undefined);
    }
    const handler = handlers[event.type as keyof WebhookHandlers] ?? handlers['*'];
    if (handler) await handler(event);
    if (event.id) await this.#store.set(storeKeys.webhook(event.id), '1', SEEN_TTL_SECONDS);
    return { event, duplicate: false };
  }

  /**
   * An Express (or Connect-style) route handler. Mount it with a raw body:
   *
   * ```ts
   * app.post('/nearpays/webhooks', express.raw({ type: 'application/json' }),
   *   nearpays.webhooks.express({ 'charge.completed': (e) => markPaid(e) }));
   * ```
   *
   * Answers 204 when handled, 401 when the delivery can't be trusted, and 500
   * when your handler throws (Nearpays will retry).
   */
  express(handlers: WebhookHandlers) {
    return async (
      req: { body: unknown; headers: Record<string, string | string[] | undefined> },
      res: { status(code: number): { end(body?: string): unknown } },
    ) => {
      try {
        await this.handle(req.body as Uint8Array, req.headers, handlers);
        res.status(204).end();
      } catch (error) {
        res.status(error instanceof WebhookVerificationError ? 401 : 500).end();
      }
    };
  }
}

function header(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
