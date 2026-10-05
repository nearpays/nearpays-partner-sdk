import { createHmac } from 'node:crypto';
import { Nearpays } from '../src/client.ts';
import { NearpaysError } from '../src/errors.ts';
import { MemoryStore } from '../src/store.ts';
import type { ApiResponse, AuthorizationChecks, TokenSet, Transport } from '../src/transport.ts';

export const SECRET = 'whsec_test';

/** An access token shaped like Nearpays': a JWT whose payload carries `gid`. */
export function accessToken(gid: string, n: number): string {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'ES256' })}.${part({ gid, n })}.sig`;
}

export interface Call {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
  accessToken: string;
}

/** A scripted Nearpays. `respond` decides each API answer. */
export class FakeTransport implements Transport {
  pushed: Record<string, string>[] = [];
  refreshes: string[] = [];
  revoked: string[] = [];
  calls: Call[] = [];
  grantId = 'grant-1';
  issued = 0;
  refreshError: NearpaysError | undefined;
  refreshDelayMs = 0;
  respond: (call: Call) => Partial<ApiResponse> = () => ({ status: 200, body: { data: {} } });

  #tokens(): TokenSet {
    this.issued += 1;
    return {
      accessToken: accessToken(this.grantId, this.issued),
      expiresIn: 300,
      refreshToken: `rt-${this.issued}`,
      scope: 'accounts:read payments:charge bills:pay',
      idTokenClaims: { sub: 'pairwise-sub', name: 'Ada Obi', email: 'ada@example.com' },
    };
  }

  async randomChecks() {
    return { codeVerifier: 'verifier', codeChallenge: 'challenge', state: `state-${this.pushed.length + 1}`, nonce: 'nonce' };
  }
  async pushAuthorization(params: Record<string, string>) {
    this.pushed.push(params);
    return new URL('https://api.nearpays.test/api/v2/oauth/auth?request_uri=urn:x');
  }
  async exchangeCode(_callback: URL, _checks: AuthorizationChecks) {
    return this.#tokens();
  }
  async refresh(refreshToken: string) {
    this.refreshes.push(refreshToken);
    if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.refreshError) throw this.refreshError;
    return this.#tokens();
  }
  async revoke(token: string) {
    this.revoked.push(token);
  }
  async request(accessToken: string, _dpop: CryptoKeyPair, method: string, url: URL, body?: string, headers?: Headers) {
    const call: Call = {
      method,
      url: url.href,
      body: body ? JSON.parse(body) : undefined,
      headers: Object.fromEntries(headers?.entries() ?? []),
      accessToken,
    };
    this.calls.push(call);
    const answer = this.respond(call);
    return {
      status: answer.status ?? 200,
      headers: answer.headers ?? new Headers(),
      body: answer.body ?? null,
      challenge: answer.challenge,
    };
  }
}

export function build(options: { now?: () => number } = {}) {
  const transport = new FakeTransport();
  const store = new MemoryStore();
  const nearpays = new Nearpays({
    baseUrl: 'https://api.nearpays.test/api/v2',
    clientId: 'npc_test',
    privateKey: 'unused-with-a-fake-transport',
    redirectUri: 'https://partner.test/nearpays/callback',
    store,
    webhookSecret: SECRET,
    transport,
    now: options.now,
  });
  return { nearpays, transport, store };
}

/** Connects `customer` through the fake, as a partner would. */
export async function connected(customer = 'user_42', options: { now?: () => number } = {}) {
  const ctx = build(options);
  const { state } = await ctx.nearpays.connect({ customer, charge: true, bills: true, balance: true });
  await ctx.nearpays.finish(`/nearpays/callback?code=abc&state=${state}`);
  return ctx;
}

export function signed(event: object, at = Math.floor(Date.now() / 1000), secret = SECRET) {
  const body = JSON.stringify(event);
  const signature = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return {
    body: Buffer.from(body),
    headers: { 'x-nearpays-timestamp': String(at), 'x-nearpays-signature': `v1=${signature}` },
  };
}
