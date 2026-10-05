import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebhookVerificationError } from '../src/errors.ts';
import { build, connected, signed } from './helpers.ts';

const event = (overrides: object = {}) => ({
  id: 'evt-1',
  type: 'charge.completed',
  createdAt: new Date().toISOString(),
  data: { sub: 'pairwise-sub', chargeId: 'c1', amount: '500.00' },
  ...overrides,
});

describe('webhooks.verify', () => {
  it('accepts a correctly signed, fresh delivery', () => {
    const { nearpays } = build();
    const { body, headers } = signed(event());
    assert.equal(nearpays.webhooks.verify(body, headers).type, 'charge.completed');
  });

  it('refuses a changed body, a wrong secret, an old timestamp and parsed JSON', () => {
    const { nearpays } = build();
    const good = signed(event());
    const tampered = Buffer.from(good.body.toString().replace('500.00', '50000.00'));
    assert.throws(() => nearpays.webhooks.verify(tampered, good.headers), WebhookVerificationError);
    const wrong = signed(event(), undefined, 'not-the-secret');
    assert.throws(() => nearpays.webhooks.verify(wrong.body, wrong.headers), WebhookVerificationError);
    const old = signed(event(), Math.floor(Date.now() / 1000) - 600);
    assert.throws(() => nearpays.webhooks.verify(old.body, old.headers), /too old/);
    assert.throws(() => nearpays.webhooks.verify(JSON.parse(good.body.toString()), good.headers), /raw request body/);
  });
});

describe('webhooks.handle', () => {
  it('names the customer, runs the handler once, and skips a redelivery', async () => {
    const { nearpays } = await connected();
    const seen: Array<string | undefined> = [];
    const handlers = { 'charge.completed': (e: { customer?: string }) => void seen.push(e.customer) };
    const { body, headers } = signed(event());
    assert.equal((await nearpays.webhooks.handle(body, headers, handlers)).duplicate, false);
    assert.equal((await nearpays.webhooks.handle(body, headers, handlers)).duplicate, true);
    assert.deepEqual(seen, ['user_42']);
  });

  it('runs a failed handler again on the retry', async () => {
    const { nearpays } = await connected();
    let attempts = 0;
    const handlers = {
      'charge.completed': () => {
        attempts += 1;
        if (attempts === 1) throw new Error('database down');
      },
    };
    const { body, headers } = signed(event());
    await assert.rejects(nearpays.webhooks.handle(body, headers, handlers), /database down/);
    await nearpays.webhooks.handle(body, headers, handlers);
    assert.equal(attempts, 2);
  });

  it('forgets the connection when its grant is revoked', async () => {
    const { nearpays, transport } = await connected();
    const { body, headers } = signed(
      event({ id: 'evt-2', type: 'grant.revoked', data: { sub: 'pairwise-sub', grantId: transport.grantId, reason: 'USER_DISCONNECTED' } }),
    );
    const { event: handled } = await nearpays.webhooks.handle(body, headers, {});
    assert.equal(handled.customer, 'user_42');
    assert.equal(await nearpays.isConnected('user_42'), false);
  });

  it('keeps a newer connection when the revoked grant is the one it replaced', async () => {
    const { nearpays } = await connected();
    const { body, headers } = signed(
      event({ id: 'evt-3', type: 'grant.revoked', data: { sub: 'pairwise-sub', grantId: 'an-older-grant', reason: 'REPLACED' } }),
    );
    await nearpays.webhooks.handle(body, headers, {});
    assert.equal(await nearpays.isConnected('user_42'), true);
  });

  it('answers 204, 401 and 500 as an Express handler', async () => {
    const { nearpays } = await connected();
    const statuses: number[] = [];
    const res = { status: (code: number) => (statuses.push(code), { end: () => undefined }) };
    const route = nearpays.webhooks.express({
      'bill.failed': () => {
        throw new Error('boom');
      },
    });
    const ok = signed(event({ id: 'evt-4' }));
    await route({ body: ok.body, headers: ok.headers }, res);
    await route({ body: Buffer.from('{}'), headers: ok.headers }, res);
    const failing = signed(event({ id: 'evt-5', type: 'bill.failed' }));
    await route({ body: failing.body, headers: failing.headers }, res);
    assert.deepEqual(statuses, [204, 401, 500]);
  });
});
