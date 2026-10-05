/**
 * A complete Nearpays partner integration in one file: connect a customer,
 * charge them, buy airtime for them, receive webhooks, disconnect.
 *
 *   node examples/starter/server.mjs     (settings: see ../nearpays.mjs)
 *
 * Then open http://127.0.0.1:4000. Register http://127.0.0.1:4000/nearpays/callback
 * as your redirect URI and http://127.0.0.1:4000/nearpays/webhooks as your
 * webhook URL (loopback addresses work on staging only).
 *
 * Signing in is faked: everyone is "demo-user". In your app, use your own
 * user's id as `customer`.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
// In your app: import { NearpaysError } from '@nearpays/partner';
import { NearpaysError } from '../../src/index.ts';
import { nearpays, ORIGIN, REDIRECT_PATH, WEBHOOK_PATH } from '../nearpays.mjs';

const PORT = Number(new URL(ORIGIN).port || 80);

const CUSTOMER = 'demo-user';
const log = [];
const note = (step, detail, ok = true) => {
  log.unshift({ at: new Date().toISOString().slice(11, 19), step, detail, ok });
  log.splice(20);
};
const failure = (error) =>
  error instanceof NearpaysError
    ? { code: error.code, message: error.message, headroom: error.headroom }
    : { message: String(error?.message ?? error) };

const app = express();

// Webhooks need the raw body for the signature check, so mount this first.
app.post(
  WEBHOOK_PATH,
  express.raw({ type: 'application/json' }),
  nearpays.webhooks.express({
    'charge.completed': (e) => note(`Webhook charge.completed for ${e.customer}`, e.data),
    'charge.failed': (e) => note(`Webhook charge.failed for ${e.customer}`, e.data, false),
    'bill.completed': (e) => note(`Webhook bill.completed for ${e.customer}`, e.data),
    'bill.refunded': (e) => note(`Webhook bill.refunded for ${e.customer}`, e.data),
    'grant.revoked': (e) => note(`Webhook grant.revoked for ${e.customer}`, e.data),
    '*': (e) => note(`Webhook ${e.type} for ${e.customer}`, e.data),
  }),
);
app.use(express.urlencoded({ extended: false }));

app.post('/connect', async (_req, res) => {
  try {
    const { url } = await nearpays.connect({
      customer: CUSTOMER,
      balance: true,
      charge: { maxPerPayment: 5000, maxPerDay: 20000, maxPerMonth: 100000, maxPaymentsPerDay: 5 },
      bills: { maxPerPayment: 2000, maxPerDay: 5000, maxPerMonth: 20000, maxPaymentsPerDay: 3, channels: ['AIRTIME', 'DATA'] },
    });
    res.redirect(url);
  } catch (error) {
    note('Connect', failure(error), false);
    res.redirect('/');
  }
});

app.get(REDIRECT_PATH, async (req, res) => {
  try {
    const connection = await nearpays.finish(req.originalUrl);
    note('Connected', connection);
  } catch (error) {
    note('Connect', failure(error), false);
  }
  res.redirect('/');
});

const action = (path, run) =>
  app.post(path, async (req, res) => {
    try {
      note(path, await run(req.body));
    } catch (error) {
      note(path, failure(error), false);
    }
    res.redirect('/');
  });

action('/balance', () => nearpays.balance(CUSTOMER));
action('/charge', (body) =>
  nearpays.charges.create(CUSTOMER, {
    amount: body.amount,
    description: body.description,
    // Your own id for this charge. Retrying with it never charges twice.
    reference: body.reference || `inv_${randomUUID().slice(0, 8)}`,
  }),
);
action('/airtime', (body) =>
  nearpays.bills.buy(CUSTOMER, {
    channel: 'AIRTIME',
    category: body.network,
    customerId: body.phone,
    amount: Number(body.amount),
    reference: `topup_${randomUUID().slice(0, 8)}`,
  }),
);
action('/disconnect', async () => {
  await nearpays.disconnect(CUSTOMER);
  return 'Disconnected';
});

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
app.get('/', async (_req, res) => {
  const isConnected = await nearpays.isConnected(CUSTOMER);
  res.send(`<!doctype html><meta charset="utf-8"><title>Nearpays starter</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px}
form{margin:8px 0}pre{background:#f3f4f2;padding:8px;overflow:auto;font-size:12px}.err{color:#a33}</style>
<h1>Nearpays starter</h1>
${
  isConnected
    ? `<p>Connected as <b>${CUSTOMER}</b>.</p>
<form method="post" action="/balance"><button>Check balance</button></form>
<form method="post" action="/charge">Charge ₦<input name="amount" value="500" size="6">
 for <input name="description" value="Pro plan, October"> ref <input name="reference" placeholder="auto" size="10"> <button>Charge</button></form>
<form method="post" action="/airtime">Buy ₦<input name="amount" value="100" size="5"> airtime for
 <input name="phone" value="+2348030000000" size="14"> on <input name="network" value="MTN" size="6"> <button>Buy</button></form>
<form method="post" action="/disconnect"><button>Disconnect</button></form>`
    : `<form method="post" action="/connect"><button>Connect with Nearpays</button></form>`
}
<h2>What happened</h2>
${log.map((e) => `<div class="${e.ok ? '' : 'err'}"><b>${e.at} ${esc(e.step)}</b><pre>${esc(JSON.stringify(e.detail, null, 2))}</pre></div>`).join('') || '<p>Nothing yet.</p>'}`);
});

app.listen(PORT, '127.0.0.1', () => console.log(`Nearpays starter on ${ORIGIN}`));
