# @nearpays/partner

Connect your customers' Nearpays accounts, charge them, and pay their bills,
from your Node.js server or your AI agent.

The SDK does the protocol work for you: pushed authorization requests, PKCE,
signed client authentication (`private_key_jwt`), DPoP-bound tokens, token
refresh, idempotent retries and webhook signatures. You write the parts that
are about your product.

Requires Node.js 20 or later.

## How it works

1. Your customer clicks **Connect Nearpays** on your site.
2. They approve in the **Nearpays app** with their transaction PIN, including
   the limits you asked for (for example, up to ₦5,000 a payment). They can
   lower those limits, but not raise them.
3. From then on you can charge them, or pay their bills, within those limits,
   without asking again. They can pause or disconnect you at any time in the
   app, and you'll get a webhook when they do.

Every charge lands in your own Nearpays business account.

## Quickstart (about 15 minutes, on staging)

### 1. Make your keys

```bash
npx nearpays-partner keygen
```

This writes `nearpays-private-key.json` (keep it secret, never commit it) and
`nearpays-public-jwks.json` (send it to Nearpays).

### 2. Get registered

Send Nearpays:
- your public keys (`nearpays-public-jwks.json`);
- your redirect URI, e.g. `https://yourapp.com/nearpays/callback`;
- your webhook URL, e.g. `https://yourapp.com/nearpays/webhooks`;
- what you need: charges, bills, balance;
- your Nearpays **business** account, which your charges settle into.

You'll get back a `client_id` (`npc_…`) and a webhook signing secret.

### 3. Set up the client

| Environment | `baseUrl` |
|---|---|
| Staging (test money; build and test here) | `https://p01--au-api--kwy26k2wm4fb.code.run/api/v2` |
| Production | `https://api.nearpays.com:8443/api/v2` |

Keep `baseUrl` in your configuration, not in code, so you can switch
environments without a deploy.

```js
import { Nearpays } from '@nearpays/partner';

export const nearpays = new Nearpays({
  baseUrl: process.env.NEARPAYS_BASE_URL, // see the table above
  clientId: process.env.NEARPAYS_CLIENT_ID,
  privateKey: JSON.parse(process.env.NEARPAYS_PRIVATE_KEY), // the keygen file's contents
  redirectUri: 'https://yourapp.com/nearpays/callback',
  webhookSecret: process.env.NEARPAYS_WEBHOOK_SECRET,
  store: yourStore, // see "Storing connections"
});
```

### 4. Connect a customer

```js
app.post('/connect-nearpays', async (req, res) => {
  const { url } = await nearpays.connect({
    customer: req.user.id, // your own id for them
    charge: { maxPerPayment: 5000, maxPerDay: 20000, maxPerMonth: 100000, maxPaymentsPerDay: 5 },
    bills: { maxPerPayment: 2000, maxPerDay: 5000, maxPerMonth: 20000, maxPaymentsPerDay: 3 },
    balance: true,
  });
  res.redirect(url);
});

app.get('/nearpays/callback', async (req, res) => {
  const connection = await nearpays.finish(req.originalUrl);
  // connection.customer is req.user.id from above; connection.profile has their name
  res.redirect('/settings?nearpays=connected');
});
```

Pass `charge: true` instead of an object to show the customer your
registered maximums to approve.

### 5. Charge them

```js
const charge = await nearpays.charges.create(user.id, {
  amount: '1500',
  reference: invoice.id, // your own unique id for this charge
  description: 'Pro plan, October', // shown on their statement
});
// charge.status === 'COMPLETED'
```

**Always pass your own `reference`.** The SDK turns it into the request's
`Idempotency-Key`, so retrying after a timeout, a crash or a deploy returns
the first result (`charge.replayed === true`) and never charges twice.

### 6. Pay a bill

```js
const { validation, payment } = await nearpays.bills.buy(user.id, {
  channel: 'AIRTIME', // or DATA, ELECTRICITY
  category: 'MTN', // a provider's name or id
  customerId: '08030000000', // phone, meter or smartcard number
  amount: 500,
  reference: topup.id,
});
// payment.status: COMPLETED, or PENDING until the provider confirms (a webhook follows)
```

For more control, use the steps separately: `bills.channels()`,
`bills.categories()`, `bills.products()` (data bundles), `bills.validate()`,
then `bills.pay()`.

### 7. Receive webhooks

```js
import express from 'express';

app.post(
  '/nearpays/webhooks',
  express.raw({ type: 'application/json' }), // the raw body is needed for the signature
  nearpays.webhooks.express({
    'charge.completed': (event) => markPaid(event.data.reference),
    'charge.failed': (event) => markFailed(event.data.reference, event.data.failure),
    'bill.completed': (event) => deliverToken(event.customer, event.data.result),
    'bill.refunded': (event) => notifyRefund(event.customer, event.data.reference),
    'grant.revoked': (event) => markDisconnected(event.customer),
    'mandate.paused': (event) => pauseBilling(event.customer),
  }),
);
```

The handler checks the signature and timestamp, gives you `event.customer`
(your id), skips deliveries it already handled, and answers 500 if your
handler throws, so Nearpays retries. When a customer disconnects, the SDK
forgets their connection before your `grant.revoked` handler runs.

Not on Express? Use `nearpays.webhooks.handle(rawBody, headers, handlers)`.

### Try it

[`examples/starter/server.mjs`](examples/starter/server.mjs) is all of the
above in one runnable file.

## Errors

Every failure is a `NearpaysError` with a stable `code`:

| `code` | Meaning | What to do |
|---|---|---|
| `not_connected` (`NotConnectedError`) | No live connection: never connected, disconnected in the app, or expired | Ask the customer to connect again |
| `mandate_limit_exceeded` | Over a limit the customer approved | `error.headroom` says what's left today, this month, and per payment |
| `mandate_unavailable` | No permission of this kind, or it's paused | Ask the customer to resume it in the Nearpays app, or reconnect |
| `insufficient_scope` | The customer didn't approve this kind of access | Reconnect asking for it |
| `account_unavailable` | Their account is suspended | Don't retry |
| `conflict` | The same reference was used for a different request, or the first is still running | Use a new reference for a new payment; wait and retry for the same one |
| `invalid_request`, `bad_request` | Something in your request | Fix it; `error.message` says what |

```js
try {
  await nearpays.charges.create(user.id, { amount: '6000', reference: inv.id });
} catch (error) {
  if (error.code === 'mandate_limit_exceeded') {
    console.log(`Only ₦${error.headroom.today} left today`);
  }
}
```

## Storing connections

The SDK stores each customer's tokens and DPoP key through a `Store` you
provide. Its contents are secrets: encrypt at rest, never log them.

```js
const store = {
  get: (key) => redis.get(key),
  set: (key, value, ttlSeconds) =>
    ttlSeconds ? redis.set(key, value, 'EX', ttlSeconds) : redis.set(key, value),
  delete: (key) => redis.del(key),
  // Needed when you run more than one server instance:
  lock: (key, fn) => redlock.using([key], 10_000, fn),
};
```

**Running more than one instance? Implement `lock`.** A refresh token works
exactly once, and Nearpays treats a second use as theft and disconnects the
customer. The SDK never refreshes twice at once within one process. `lock`
makes that hold across your instances.

`MemoryStore` is for tests only: a restart forgets every customer.

## AI agents

`nearpays.agentTools()` gives an agent ready-made tools for one customer:

| Tool | Does | Moves money |
|---|---|---|
| `get_balance` | Wallet balance | |
| `list_bill_categories` | Networks, electricity companies… | |
| `list_bill_products` | Data bundles and prices | |
| `validate_bill` | Checks a phone, meter or smartcard number | |
| `pay_bill` | Pays a validated bill | ✓ |
| `get_bill_payment` | A bill payment's status | |
| `charge_customer` | Charges the customer | ✓ |
| `get_charge` | A charge's status | |

```js
import Anthropic from '@anthropic-ai/sdk';
import { runTool, toAnthropicTools } from '@nearpays/partner';

const tools = nearpays.agentTools({
  customer: user.id, // bound: the agent can't reach any other customer
  only: ['get_balance', 'list_bill_categories', 'validate_bill', 'pay_bill', 'get_bill_payment'],
  confirm: async ({ summary }) => askUserToConfirm(summary), // optional human check before money moves
});

const reply = await anthropic.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  tools: toAnthropicTools(tools),
  messages,
});
for (const block of reply.content) {
  if (block.type === 'tool_use') {
    const result = await runTool(tools, block.name, block.input);
    // send { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) }
  }
}
```

What makes them safe to hand to an agent:
- **No secrets in the agent.** Keys and tokens stay inside the SDK; the agent
  only sees operations and results.
- **One customer per tool set.** Make tools per conversation, for the customer
  in it.
- **Retries never pay twice.** Money tools require a `reference`, and tell the
  agent to reuse it when retrying.
- **Refusals are explained, not thrown.** An over-limit payment returns
  `{ error, message, headroom }` in words the agent can relay.
- **Limits are enforced by Nearpays**, whatever the agent decides: the
  customer's approved limits always apply.

`toOpenAITools(tools)` gives the same tools in OpenAI's format. A complete
loop is in [`examples/agent/agent.mjs`](examples/agent/agent.mjs).

## Other calls

```js
await nearpays.isConnected(user.id);   // does the SDK hold a connection?
await nearpays.connection(user.id);    // what Nearpays says it allows right now
await nearpays.balance(user.id);       // needs balance: true at connect
await nearpays.charges.get(user.id, chargeId);
await nearpays.bills.get(user.id, billPaymentId);
await nearpays.disconnect(user.id);    // ends it at Nearpays and forgets it
await nearpays.request(user.id, 'GET', '/grant'); // any partner API call, signed for you
```

## Developing this package

```bash
npm test          # node --test, no network
npm run build     # compiles to dist/ for publishing
```

The source is TypeScript that Node.js runs directly (type stripping), so tests
need Node.js 23.6 or later. The published package is compiled JavaScript with
type declarations and runs on Node.js 20.
