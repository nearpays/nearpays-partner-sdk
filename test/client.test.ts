import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NearpaysError, NotConnectedError } from '../src/errors.ts';
import { build, connected } from './helpers.ts';

describe('connect and finish', () => {
  it('pushes a request with PKCE, consent, the resource and the mandate terms', async () => {
    const { nearpays, transport } = build();
    await nearpays.connect({
      customer: 'user_42',
      balance: true,
      charge: { maxPerPayment: 5000, maxPerDay: 20000, maxPerMonth: 100000, maxPaymentsPerDay: 5 },
      bills: { maxPerPayment: 2000, maxPerDay: 5000, maxPerMonth: 20000, maxPaymentsPerDay: 3, channels: ['AIRTIME'] },
    });
    const [params] = transport.pushed;
    assert.equal(params.scope, 'openid profile offline_access accounts:read payments:charge bills:pay');
    assert.equal(params.prompt, 'consent');
    assert.equal(params.code_challenge_method, 'S256');
    assert.equal(params.resource, 'https://api.nearpays.test/api/v2/open');
    assert.equal(params.redirect_uri, 'https://partner.test/nearpays/callback');
    assert.deepEqual(JSON.parse(params.authorization_details), [
      { type: 'nearpays_mandate', mandate_type: 'CHARGE', currency: 'NGN', max_per_transaction: 5000, max_per_day: 20000, max_per_month: 100000, max_transactions_per_day: 5 },
      { type: 'nearpays_mandate', mandate_type: 'BILLS', currency: 'NGN', max_per_transaction: 2000, max_per_day: 5000, max_per_month: 20000, max_transactions_per_day: 3, bill_channels: ['AIRTIME'] },
    ]);
  });

  it('sends no terms when asked with true, so the customer sees the registered ceilings', async () => {
    const { nearpays, transport } = build();
    await nearpays.connect({ customer: 'user_42', charge: true });
    assert.equal(transport.pushed[0].authorization_details, undefined);
  });

  it('stores the connection under the partner\'s own customer id', async () => {
    const { nearpays, transport } = build();
    const { state } = await nearpays.connect({ customer: 'user_42', charge: true });
    const connection = await nearpays.finish(`https://partner.test/nearpays/callback?code=abc&state=${state}`);
    assert.deepEqual(connection, {
      customer: 'user_42',
      sub: 'pairwise-sub',
      grantId: transport.grantId,
      scopes: ['accounts:read', 'payments:charge', 'bills:pay'],
      profile: { name: 'Ada Obi', email: 'ada@example.com', phone: undefined },
    });
    assert.equal(await nearpays.isConnected('user_42'), true);
  });

  it('refuses an unknown or reused state', async () => {
    const { nearpays } = build();
    const { state } = await nearpays.connect({ customer: 'user_42' });
    await nearpays.finish(`/nearpays/callback?code=abc&state=${state}`);
    await assert.rejects(nearpays.finish(`/nearpays/callback?code=abc&state=${state}`), { code: 'unknown_state' });
  });

  it('reports a customer who declined', async () => {
    const { nearpays } = build();
    const { state } = await nearpays.connect({ customer: 'user_42' });
    await assert.rejects(nearpays.finish(`/nearpays/callback?error=access_denied&state=${state}`), {
      code: 'access_denied',
    });
    assert.equal(await nearpays.isConnected('user_42'), false);
  });
});

describe('tokens', () => {
  it('refreshes an expiring token once, however many calls need it at the same time', async () => {
    let now = Date.now();
    const { nearpays, transport } = await connected('user_42', { now: () => now });
    transport.respond = () => ({ status: 200, body: { data: [] } });
    now += 290_000; // inside the 30-second margin
    transport.refreshDelayMs = 20;
    await Promise.all([nearpays.balance('user_42'), nearpays.balance('user_42'), nearpays.balance('user_42')]);
    assert.deepEqual(transport.refreshes, ['rt-1']);
    assert.ok(transport.calls.every((c) => c.accessToken === transport.calls[0].accessToken));
  });

  it('refreshes and retries once when the API says the token is no good', async () => {
    const { nearpays, transport } = await connected();
    let first = true;
    transport.respond = () => {
      if (first) {
        first = false;
        return { status: 401, challenge: { error: 'invalid_token' } };
      }
      return { status: 200, body: { data: [{ currency: 'NGN', balance: '10.00', locked: '0' }] } };
    };
    const balances = await nearpays.balance('user_42');
    assert.equal(balances[0].balance, '10.00');
    assert.equal(transport.refreshes.length, 1);
    assert.notEqual(transport.calls[0].accessToken, transport.calls[1].accessToken);
  });

  it('forgets a customer who disconnected in the app', async () => {
    let now = Date.now();
    const { nearpays, transport } = await connected('user_42', { now: () => now });
    now += 400_000;
    transport.refreshError = new NearpaysError('invalid_grant', 'grant request is invalid');
    await assert.rejects(nearpays.balance('user_42'), NotConnectedError);
    assert.equal(await nearpays.isConnected('user_42'), false);
  });

  it('keeps the connection when a refresh fails for another reason', async () => {
    let now = Date.now();
    const { nearpays, transport } = await connected('user_42', { now: () => now });
    now += 400_000;
    transport.refreshError = new NearpaysError('request_failed', 'network down');
    await assert.rejects(nearpays.balance('user_42'), { code: 'request_failed' });
    assert.equal(await nearpays.isConnected('user_42'), true);
  });

  it('says a customer it never connected is not connected', async () => {
    const { nearpays } = build();
    await assert.rejects(nearpays.balance('nobody'), NotConnectedError);
  });

  it('revokes at Nearpays and forgets on disconnect', async () => {
    const { nearpays, transport } = await connected();
    await nearpays.disconnect('user_42');
    assert.deepEqual(transport.revoked, ['rt-1']);
    assert.equal(await nearpays.isConnected('user_42'), false);
  });
});

describe('charges', () => {
  it('sends the same Idempotency-Key for the same reference, and a new one for a new reference', async () => {
    const { nearpays, transport } = await connected();
    transport.respond = () => ({ status: 201, body: { data: { id: 'c1', status: 'COMPLETED' } } });
    await nearpays.charges.create('user_42', { amount: 500, reference: 'inv_1' });
    await nearpays.charges.create('user_42', { amount: 500, reference: 'inv_1' });
    await nearpays.charges.create('user_42', { amount: 500, reference: 'inv_2' });
    const keys = transport.calls.map((c) => c.headers['idempotency-key']);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.match(keys[0], /^sdk_[0-9a-f]{48}$/);
    assert.deepEqual(transport.calls[0].body, { amount: '500', reference: 'inv_1' });
    assert.equal(transport.calls[0].url, 'https://api.nearpays.test/api/v2/open/charges');
  });

  it('requires a reference, so every charge can be retried safely', async () => {
    const { nearpays } = await connected();
    await assert.rejects(nearpays.charges.create('user_42', { amount: 500, reference: '' }), {
      code: 'invalid_request',
    });
  });

  it('says when a result is a replay of an earlier identical request', async () => {
    const { nearpays, transport } = await connected();
    transport.respond = () => ({
      status: 200,
      headers: new Headers({ 'idempotent-replayed': 'true' }),
      body: { data: { id: 'c1', status: 'COMPLETED' } },
    });
    const charge = await nearpays.charges.create('user_42', { amount: 500, reference: 'inv_1' });
    assert.equal(charge.replayed, true);
  });

  it('turns a mandate refusal into an error with what is left', async () => {
    const { nearpays, transport } = await connected();
    const headroom = { perTransaction: '5000.00', today: '1000.00', thisMonth: '9000.00', transactionsToday: 2 };
    transport.respond = () => ({
      status: 422,
      body: { status: 'error', statusCode: 422, message: 'Above today\'s limit', error: 'mandate_limit_exceeded', headroom },
    });
    await assert.rejects(nearpays.charges.create('user_42', { amount: 6000, reference: 'inv_9' }), (error: unknown) => {
      assert.ok(error instanceof NearpaysError);
      assert.equal(error.code, 'mandate_limit_exceeded');
      assert.equal(error.status, 422);
      assert.deepEqual(error.headroom, headroom);
      return true;
    });
  });

  it('uses the status when the API sent no error code', async () => {
    const { nearpays, transport } = await connected();
    transport.respond = () => ({ status: 404, body: { status: 'error', statusCode: 404, message: 'Charge not found', error: 'Not Found' } });
    await assert.rejects(nearpays.charges.get('user_42', 'missing'), { code: 'not_found', message: 'Charge not found' });
  });
});

describe('bills', () => {
  it('buys by name: finds the channel and category, validates, then pays', async () => {
    const { nearpays, transport } = await connected();
    transport.respond = (call) => {
      if (call.url.endsWith('/bills/channels')) return { body: { data: [{ id: 'ch1', name: 'AIRTIME' }] } };
      if (call.url.endsWith('/channels/ch1/categories')) return { body: { data: [{ id: 'cat-glo', name: 'GLO' }, { id: 'cat-mtn', name: 'MTN Airtime' }] } };
      if (call.url.endsWith('/bills/validate')) return { body: { data: { reference: 'VAL-1', response: [] } } };
      return { status: 201, body: { data: { id: 'b1', status: 'PENDING' } } };
    };
    const { payment } = await nearpays.bills.buy('user_42', {
      channel: 'AIRTIME',
      category: 'mtn',
      customerId: '+2348030000000',
      amount: 100,
      reference: 'topup_1',
    });
    assert.equal(payment.status, 'PENDING');
    const validate = transport.calls.find((c) => c.url.endsWith('/bills/validate'));
    assert.deepEqual(validate?.body, { channel: 'AIRTIME', categoryId: 'cat-mtn', customerId: '+2348030000000', amount: 100 });
    const purchase = transport.calls.at(-1);
    assert.deepEqual(purchase?.body, { validationReference: 'VAL-1', reference: 'topup_1', amount: 100 });
    assert.match(purchase?.headers['idempotency-key'] ?? '', /^sdk_/);
  });
});
