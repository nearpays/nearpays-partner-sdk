import { createHash } from 'node:crypto';
import { NearpaysError, NotConnectedError, errorFromResponse } from './errors.ts';
import {
  type ClientKeyInput,
  type StoredKeyPair,
  importClientKey,
  importDPoPKeyPair,
  newDPoPKeyPair,
} from './keys.ts';
import { MemoryStore, type Store, storeKeys } from './store.ts';
import { OpenIdTransport, type TokenSet, type Transport } from './transport.ts';
import type {
  Balance,
  BillCategory,
  BillChannelInfo,
  BillPayment,
  BillValidation,
  BuyBillRequest,
  Charge,
  ChargeRequest,
  ConnectOptions,
  Connection,
  ConnectionInfo,
  MandateRequest,
  BillsMandateRequest,
  PayBillRequest,
  TestWebhook,
  ValidateBillRequest,
  WebhookEventType,
} from './types.ts';
import { Webhooks } from './webhooks.ts';
import { type AgentTool, type AgentToolsOptions, createAgentTools } from './tools.ts';

export interface NearpaysOptions {
  /** The API base, ending in `/api/v2`, e.g. `https://api.nearpays.com/api/v2`. */
  baseUrl: string;
  /** Your `client_id` (`npc_…`). */
  clientId: string;
  /** The private key matching the public keys you registered. */
  privateKey: ClientKeyInput;
  /** Where Nearpays sends customers back after they approve. Must be registered. */
  redirectUri: string;
  /** Where connections are kept. Defaults to memory, which is for development only. */
  store?: Store;
  /** The webhook signing secret Nearpays gave you. Needed for `webhooks`. */
  webhookSecret?: string;
  /** Allow plain http, for a local Nearpays. Never in production. */
  allowInsecureHttp?: boolean;
  /** For tests. */
  transport?: Transport;
  /** For tests. */
  now?: () => number;
}

/** A customer's stored connection. */
interface StoredConnection {
  customer: string;
  sub: string;
  grantId: string;
  scopes: string[];
  accessToken: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt: number;
  refreshToken?: string;
  dpop: StoredKeyPair;
  connectedAt: string;
}

interface PendingConnection {
  customer: string;
  codeVerifier: string;
  state: string;
  nonce: string;
  dpop: StoredKeyPair;
}

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 30_000;
const PENDING_TTL_SECONDS = 15 * 60;

/**
 * Nearpays for a partner's server. One instance per app; it is safe to share
 * across requests.
 *
 * ```ts
 * const nearpays = new Nearpays({ baseUrl, clientId, privateKey, redirectUri, store });
 * const { url } = await nearpays.connect({ customer: 'user_42', charge: true });
 * // send the customer's browser to url; on your redirect URI:
 * await nearpays.finish(req.originalUrl);
 * await nearpays.charges.create('user_42', { amount: '500', reference: 'inv_1043' });
 * ```
 */
export class Nearpays {
  readonly charges: {
    create: (customer: string, request: ChargeRequest) => Promise<Charge>;
    get: (customer: string, id: string) => Promise<Charge>;
  };
  readonly bills: {
    channels: (customer: string) => Promise<BillChannelInfo[]>;
    categories: (customer: string, channelId: string) => Promise<BillCategory[]>;
    products: (customer: string, categoryId: string) => Promise<BillCategory[]>;
    validate: (customer: string, request: ValidateBillRequest) => Promise<BillValidation>;
    pay: (customer: string, request: PayBillRequest) => Promise<BillPayment>;
    buy: (
      customer: string,
      request: BuyBillRequest,
    ) => Promise<{ validation: BillValidation; payment: BillPayment }>;
    get: (customer: string, id: string) => Promise<BillPayment>;
  };
  readonly webhooks: Webhooks;
  readonly store: Store;

  readonly #clientId: string;
  readonly #redirectUri: URL;
  readonly #resource: URL;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #refreshing = new Map<string, Promise<StoredConnection>>();

  constructor(options: NearpaysOptions) {
    for (const field of ['baseUrl', 'clientId', 'redirectUri'] as const) {
      if (!options[field]) {
        throw new NearpaysError('invalid_options', `${field} is required`);
      }
    }
    if (!options.privateKey && !options.transport) {
      throw new NearpaysError('invalid_options', 'privateKey is required');
    }
    const base = options.baseUrl.replace(/\/+$/, '');
    const insecure = options.allowInsecureHttp === true;
    if (!insecure && !base.startsWith('https://')) {
      throw new NearpaysError(
        'invalid_options',
        'baseUrl must be https (allowInsecureHttp is for a local Nearpays only)',
      );
    }
    this.#clientId = options.clientId;
    this.#redirectUri = new URL(options.redirectUri);
    this.#resource = new URL(`${base}/open`);
    this.#now = options.now ?? Date.now;
    this.store = options.store ?? new MemoryStore();
    this.#transport =
      options.transport ??
      new OpenIdTransport({
        issuer: new URL(`${base}/oauth`),
        clientId: options.clientId,
        clientKey: importClientKey(options.privateKey),
        allowInsecureHttp: insecure,
      });
    this.webhooks = new Webhooks({
      secret: options.webhookSecret,
      store: this.store,
      now: this.#now,
      forget: (sub, grantId) => this.#forgetBySubject(sub, grantId),
    });

    this.charges = {
      create: async (customer, request) => {
        const amount = String(request.amount);
        requireReference(request.reference);
        const { data, replayed } = await this.request<Charge>(customer, 'POST', '/charges', {
          body: {
            amount,
            reference: request.reference,
            ...(request.description ? { description: request.description } : {}),
          },
          idempotencyKey:
            request.idempotencyKey ?? this.#idempotencyKey(customer, 'charge', request.reference),
        });
        return { ...data, replayed };
      },
      get: async (customer, id) => {
        const { data } = await this.request<Charge>(customer, 'GET', `/charges/${encodeURIComponent(id)}`);
        return { ...data, replayed: false };
      },
    };

    this.bills = {
      channels: async (customer) =>
        (await this.request<BillChannelInfo[]>(customer, 'GET', '/bills/channels')).data,
      categories: async (customer, channelId) =>
        (
          await this.request<BillCategory[]>(
            customer,
            'GET',
            `/bills/channels/${encodeURIComponent(channelId)}/categories`,
          )
        ).data,
      products: async (customer, categoryId) =>
        (
          await this.request<BillCategory[]>(
            customer,
            'GET',
            `/bills/categories/${encodeURIComponent(categoryId)}/sub-categories`,
          )
        ).data,
      validate: async (customer, request) =>
        (
          await this.request<BillValidation>(customer, 'POST', '/bills/validate', {
            body: {
              channel: request.channel,
              categoryId: request.categoryId,
              customerId: request.customerId,
              ...(request.productId ? { subCategoryId: request.productId } : {}),
              ...(request.meterType ? { electricityMeterType: request.meterType } : {}),
            },
          })
        ).data,
      pay: async (customer, request) => {
        requireReference(request.reference);
        const { data, replayed } = await this.request<BillPayment>(
          customer,
          'POST',
          '/bills/purchase',
          {
            body: {
              validationReference: request.validationReference,
              reference: request.reference,
              ...(request.amount !== undefined ? { amount: request.amount } : {}),
            },
            idempotencyKey:
              request.idempotencyKey ?? this.#idempotencyKey(customer, 'bill', request.reference),
          },
        );
        return { ...data, replayed };
      },
      buy: async (customer, request) => {
        const channels = await this.bills.channels(customer);
        const channel = channels.find((c) => String(c.name).toUpperCase() === request.channel);
        if (!channel) {
          throw new NearpaysError('unknown_channel', `Nearpays has no ${request.channel} bills`);
        }
        const category = pick(await this.bills.categories(customer, channel.id), request.category);
        if (!category) {
          throw new NearpaysError('unknown_category', `No ${request.channel} category matches "${request.category}"`);
        }
        let productId: string | undefined;
        if (request.product) {
          const product = pick(await this.bills.products(customer, category.id), request.product);
          if (!product) {
            throw new NearpaysError('unknown_product', `No product of ${category.name} matches "${request.product}"`);
          }
          productId = product.id;
        }
        const validation = await this.bills.validate(customer, {
          channel: request.channel,
          categoryId: category.id,
          productId,
          customerId: request.customerId,
          meterType: request.meterType,
        });
        const payment = await this.bills.pay(customer, {
          validationReference: validation.reference,
          amount: request.amount,
          reference: request.reference,
        });
        return { validation, payment };
      },
      get: async (customer, id) => {
        const { data } = await this.request<BillPayment>(customer, 'GET', `/bills/${encodeURIComponent(id)}`);
        return { ...data, replayed: false };
      },
    };
  }

  /**
   * Starts connecting a customer. Send their browser to `url`. They approve on
   * a Nearpays page and come back to your redirect URI; call `finish()` there.
   */
  async connect(options: ConnectOptions): Promise<{ url: string; state: string }> {
    if (!options.customer) {
      throw new NearpaysError('invalid_request', 'customer is required');
    }
    const scopes = ['openid', 'profile', 'offline_access', ...(options.identity ?? [])];
    if (options.balance) scopes.push('accounts:read');
    const details: Record<string, unknown>[] = [];
    if (options.charge) {
      scopes.push('payments:charge');
      if (typeof options.charge === 'object') details.push(mandateDetail('CHARGE', options.charge));
    }
    if (options.bills) {
      scopes.push('bills:pay');
      if (typeof options.bills === 'object') details.push(mandateDetail('BILLS', options.bills));
    }

    const checks = await this.#transport.randomChecks();
    const { pair, stored } = await newDPoPKeyPair();
    const url = await this.#transport.pushAuthorization(
      {
        redirect_uri: this.#redirectUri.href,
        scope: [...new Set(scopes)].join(' '),
        code_challenge: checks.codeChallenge,
        code_challenge_method: 'S256',
        state: checks.state,
        nonce: checks.nonce,
        resource: this.#resource.href,
        // OpenID releases a refresh token (offline_access) only with explicit consent.
        prompt: 'consent',
        ...(details.length ? { authorization_details: JSON.stringify(details) } : {}),
      },
      pair,
    );
    const pending: PendingConnection = {
      customer: options.customer,
      codeVerifier: checks.codeVerifier,
      state: checks.state,
      nonce: checks.nonce,
      dpop: stored,
    };
    await this.store.set(storeKeys.pending(checks.state), JSON.stringify(pending), PENDING_TTL_SECONDS);
    return { url: url.href, state: checks.state };
  }

  /**
   * Completes a connection on your redirect URI. Pass the full URL the
   * customer arrived at, or its path and query (e.g. Express `req.originalUrl`).
   */
  async finish(callbackUrl: string | URL): Promise<Connection> {
    const callback = new URL(String(callbackUrl), this.#redirectUri);
    const state = callback.searchParams.get('state');
    const raw = state ? await this.store.get(storeKeys.pending(state)) : undefined;
    if (!state || !raw) {
      throw new NearpaysError(
        'unknown_state',
        'This sign-in is unknown or expired. Start again with connect().',
      );
    }
    await this.store.delete(storeKeys.pending(state));
    const pending = JSON.parse(raw) as PendingConnection;

    const error = callback.searchParams.get('error');
    if (error) {
      throw new NearpaysError(
        error,
        callback.searchParams.get('error_description') ??
          (error === 'access_denied' ? 'The customer declined' : 'The connection failed'),
      );
    }

    const pair = await importDPoPKeyPair(pending.dpop);
    const tokens = await this.#transport.exchangeCode(callback, pending, pair);
    const claims = tokens.idTokenClaims ?? {};
    const sub = String(claims.sub ?? '');
    const connection: StoredConnection = {
      customer: pending.customer,
      sub,
      grantId: grantIdOf(tokens.accessToken),
      scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: this.#now() + tokens.expiresIn * 1000,
      refreshToken: tokens.refreshToken,
      dpop: pending.dpop,
      connectedAt: new Date(this.#now()).toISOString(),
    };
    await this.#save(connection);
    if (sub) await this.store.set(storeKeys.subject(sub), pending.customer);
    return {
      customer: pending.customer,
      sub,
      grantId: connection.grantId,
      scopes: connection.scopes,
      profile: {
        name: claims.name as string | undefined,
        email: claims.email as string | undefined,
        phone: claims.phone_number as string | undefined,
      },
    };
  }

  /** Whether the SDK holds a connection for this customer. */
  async isConnected(customer: string): Promise<boolean> {
    return !!(await this.store.get(storeKeys.connection(customer)));
  }

  /** What the customer's connection allows, as Nearpays sees it now. */
  async connection(customer: string): Promise<ConnectionInfo> {
    return (await this.request<ConnectionInfo>(customer, 'GET', '/grant')).data;
  }

  /** The customer's wallet balances. Needs `balance: true` at connect. */
  async balance(customer: string): Promise<Balance[]> {
    return (await this.request<Balance[]>(customer, 'GET', '/balance')).data;
  }

  /**
   * Asks Nearpays to send your webhook URL a sample event for this customer,
   * signed like a real one. The sample has `test: true` and ids starting
   * `test_`; a test `grant.revoked` never forgets a real connection.
   */
  async sendTestWebhook(customer: string, type: WebhookEventType): Promise<TestWebhook> {
    return (await this.request<TestWebhook>(customer, 'POST', '/webhooks/test', { body: { type } })).data;
  }

  /** Ends the connection at Nearpays and forgets it here. */
  async disconnect(customer: string): Promise<void> {
    const connection = await this.#load(customer).catch(() => undefined);
    if (!connection) return;
    try {
      await this.#transport.revoke(connection.refreshToken ?? connection.accessToken);
    } finally {
      await this.#forget(connection);
    }
  }

  /**
   * Tools an AI agent can call to act for one customer: balance, bills and
   * charges, with keys and tokens kept out of the agent. See `AgentToolsOptions`.
   */
  agentTools(options: AgentToolsOptions): AgentTool[] {
    return createAgentTools(this, options);
  }

  /**
   * A call to the partner API (`/api/v2/open`) for a customer, with a fresh
   * token and DPoP proof. The typed methods use this; use it for anything
   * they don't cover. Throws NearpaysError for any non-2xx answer.
   */
  async request<T>(
    customer: string,
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<{ data: T; replayed: boolean }> {
    const url = new URL(this.#resource.href.replace(/\/$/, '') + path);
    const headers = new Headers({ accept: 'application/json' });
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    let connection = await this.#fresh(customer);
    let response = await this.#transport.request(
      connection.accessToken,
      await importDPoPKeyPair(connection.dpop),
      method,
      url,
      body,
      headers,
    );
    if (response.status === 401 && response.challenge?.error === 'invalid_token') {
      // Expired early or rotated elsewhere: refresh once and try again. Money
      // requests carry an Idempotency-Key, so a repeat is never applied twice.
      connection = await this.#fresh(customer, connection.accessToken);
      response = await this.#transport.request(
        connection.accessToken,
        await importDPoPKeyPair(connection.dpop),
        method,
        url,
        body,
        headers,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw errorFromResponse(response.status, response.body, response.challenge);
    }
    const envelope = (response.body ?? {}) as { data?: T };
    return {
      data: envelope.data as T,
      replayed: response.headers.get('idempotent-replayed') === 'true',
    };
  }

  /** A connection with an access token good for at least REFRESH_MARGIN_MS. */
  async #fresh(customer: string, rejectedToken?: string): Promise<StoredConnection> {
    const connection = await this.#load(customer);
    const valid =
      connection.accessTokenExpiresAt - REFRESH_MARGIN_MS > this.#now() &&
      connection.accessToken !== rejectedToken;
    if (valid) return connection;
    // One refresh per customer at a time in this process; `store.lock` covers
    // other processes. A refresh token works once.
    let refreshing = this.#refreshing.get(customer);
    if (!refreshing) {
      refreshing = this.#refresh(customer, connection.accessToken).finally(() =>
        this.#refreshing.delete(customer),
      );
      this.#refreshing.set(customer, refreshing);
    }
    return refreshing;
  }

  async #refresh(customer: string, staleToken: string): Promise<StoredConnection> {
    const run = async () => {
      // Another process may have refreshed while we waited for the lock.
      const current = await this.#load(customer);
      if (
        current.accessToken !== staleToken &&
        current.accessTokenExpiresAt - REFRESH_MARGIN_MS > this.#now()
      ) {
        return current;
      }
      if (!current.refreshToken) {
        await this.#forget(current);
        throw new NotConnectedError(customer);
      }
      let tokens: TokenSet;
      try {
        tokens = await this.#transport.refresh(
          current.refreshToken,
          await importDPoPKeyPair(current.dpop),
        );
      } catch (error) {
        // Disconnected in the app, expired, or the account closed.
        if (error instanceof NearpaysError && error.code === 'invalid_grant') {
          await this.#forget(current);
          throw new NotConnectedError(customer, error);
        }
        throw error;
      }
      const next: StoredConnection = {
        ...current,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: this.#now() + tokens.expiresIn * 1000,
        refreshToken: tokens.refreshToken ?? current.refreshToken,
        scopes: tokens.scope ? tokens.scope.split(' ').filter(Boolean) : current.scopes,
      };
      await this.#save(next);
      return next;
    };
    return this.store.lock ? this.store.lock(storeKeys.lock(customer), run) : run();
  }

  async #load(customer: string): Promise<StoredConnection> {
    const raw = await this.store.get(storeKeys.connection(customer));
    if (!raw) throw new NotConnectedError(customer);
    return JSON.parse(raw) as StoredConnection;
  }

  async #save(connection: StoredConnection): Promise<void> {
    await this.store.set(storeKeys.connection(connection.customer), JSON.stringify(connection));
  }

  async #forget(connection: StoredConnection): Promise<void> {
    await this.store.delete(storeKeys.connection(connection.customer));
    if (connection.sub) await this.store.delete(storeKeys.subject(connection.sub));
  }

  /**
   * After `grant.revoked`: forgets the customer only if the revoked grant is
   * the one stored. A reconnect revokes the previous grant, and that webhook
   * must not wipe the new connection.
   */
  async #forgetBySubject(sub: string, grantId: string | undefined): Promise<string | undefined> {
    const customer = await this.store.get(storeKeys.subject(sub));
    if (!customer) return undefined;
    const raw = await this.store.get(storeKeys.connection(customer));
    if (raw) {
      const connection = JSON.parse(raw) as StoredConnection;
      if (!grantId || connection.grantId === grantId) await this.#forget(connection);
    }
    return customer;
  }

  /**
   * The same intent always gets the same key, so a retry, a crash-and-resume
   * or an agent repeating itself returns the first result.
   */
  #idempotencyKey(customer: string, kind: string, reference: string): string {
    const digest = createHash('sha256')
      .update([this.#clientId, customer, kind, reference].join('\u0000'))
      .digest('hex');
    return `sdk_${digest.slice(0, 48)}`;
  }
}

function mandateDetail(type: 'CHARGE' | 'BILLS', terms: MandateRequest | BillsMandateRequest) {
  return {
    type: 'nearpays_mandate',
    mandate_type: type,
    currency: 'NGN',
    max_per_transaction: terms.maxPerPayment,
    max_per_day: terms.maxPerDay,
    max_per_month: terms.maxPerMonth,
    max_transactions_per_day: terms.maxPaymentsPerDay,
    ...('channels' in terms && terms.channels?.length ? { bill_channels: terms.channels } : {}),
    ...(terms.expiresAt ? { expires_at: terms.expiresAt.toISOString() } : {}),
  };
}

function requireReference(reference: string) {
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 100) {
    throw new NearpaysError(
      'invalid_request',
      'reference is required: your own unique id for this payment, up to 100 characters',
    );
  }
}

/** The grant id (`gid`) an access token carries. */
function grantIdOf(accessToken: string): string {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    return String(payload.gid ?? '');
  } catch {
    return '';
  }
}

/** A category or product by id, exact name, or a name that contains the text. */
function pick<T extends { id: string; name: string }>(items: T[], wanted: string): T | undefined {
  const w = wanted.trim().toUpperCase();
  return (
    items.find((i) => i.id === wanted) ??
    items.find((i) => String(i.name).toUpperCase() === w) ??
    items.find((i) => String(i.name).toUpperCase().includes(w))
  );
}
