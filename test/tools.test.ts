import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateClientKeys, importClientKey } from '../src/keys.ts';
import { runTool, toAnthropicTools, toOpenAITools } from '../src/tools.ts';
import { connected } from './helpers.ts';

describe('agent tools', () => {
  it('acts only for the customer they were made for', async () => {
    const { nearpays, transport } = await connected();
    transport.respond = () => ({ status: 200, body: { data: [{ currency: 'NGN', balance: '100.00', locked: '0' }] } });
    const tools = nearpays.agentTools({ customer: 'user_42' });
    await runTool(tools, 'get_balance', {});
    assert.ok(transport.calls.every((c) => c.url.endsWith('/balance')));
    for (const tool of tools) {
      assert.ok(!JSON.stringify(tool.inputSchema).includes('"customer"'), `${tool.name} must not take a customer`);
    }
  });

  it('asks before moving money, and stops when told no', async () => {
    const { nearpays, transport } = await connected();
    const asked: string[] = [];
    const tools = nearpays.agentTools({
      customer: 'user_42',
      confirm: ({ summary }) => (asked.push(summary), false),
    });
    const result = await runTool(tools, 'charge_customer', { amount: '1500', reference: 'r1' });
    assert.deepEqual(result, { error: 'not_confirmed', message: 'Not done: charging ₦1500 was not confirmed.' });
    assert.deepEqual(asked, ['charging ₦1500']);
    assert.equal(transport.calls.length, 0);
  });

  it('hands a refusal back as data the agent can explain', async () => {
    const { nearpays, transport } = await connected();
    transport.respond = () => ({
      status: 422,
      body: {
        message: 'Above the daily limit',
        error: 'mandate_limit_exceeded',
        headroom: { perTransaction: '5000.00', today: '200.00', thisMonth: '4000.00', transactionsToday: 4 },
      },
    });
    const result = (await runTool(nearpays.agentTools({ customer: 'user_42' }), 'charge_customer', {
      amount: '900',
      reference: 'r2',
    })) as { error: string; message: string };
    assert.equal(result.error, 'mandate_limit_exceeded');
    assert.match(result.message, /Left today: ₦200\.00/);
  });

  it('offers only the tools asked for, in both providers\' formats', async () => {
    const { nearpays } = await connected();
    const tools = nearpays.agentTools({ customer: 'user_42', only: ['get_balance', 'pay_bill'] });
    assert.deepEqual(tools.map((t) => t.name), ['get_balance', 'pay_bill']);
    assert.deepEqual(Object.keys(toAnthropicTools(tools)[0]), ['name', 'description', 'input_schema']);
    assert.equal(toOpenAITools(tools)[1].function.name, 'pay_bill');
    assert.deepEqual(tools.filter((t) => t.movesMoney).map((t) => t.name), ['pay_bill']);
  });
});

describe('keys', () => {
  it('generates a pair whose private half loads, and whose public half holds no private parts', async () => {
    const { privateJwk, publicJwks } = await generateClientKeys('kid-1');
    const loaded = await importClientKey(privateJwk);
    assert.equal(loaded.kid, 'kid-1');
    assert.equal('d' in publicJwks.keys[0], false);
  });

  it('refuses a public key, or a key with no kid', async () => {
    const { privateJwk, publicJwks } = await generateClientKeys('kid-1');
    await assert.rejects(importClientKey(publicJwks.keys[0] as JsonWebKey & { kid: string }), { code: 'invalid_key' });
    const { kid: _kid, ...noKid } = privateJwk;
    await assert.rejects(importClientKey(noKid), /needs a kid/);
  });
});
