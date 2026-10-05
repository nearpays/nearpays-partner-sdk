/**
 * An AI agent acting for one connected customer, using the SDK's tools with
 * the Anthropic Messages API. The agent sees operations only: no keys, no
 * tokens, and no way to reach any other customer.
 *
 *   ANTHROPIC_API_KEY=... node examples/agent/agent.mjs "Buy ₦200 MTN airtime for 08030000000"
 *
 * Connect demo-user with the starter app first; both share ../nearpays.mjs.
 *
 * Shown with plain fetch so it has no extra dependencies; any agent framework
 * that takes JSON Schema tools works the same way (toOpenAITools for OpenAI).
 */
import { createInterface } from 'node:readline/promises';
// In your app: import { runTool, toAnthropicTools } from '@nearpays/partner';
import { runTool, toAnthropicTools } from '../../src/index.ts';
import { nearpays } from '../nearpays.mjs';

const customer = process.env.CUSTOMER ?? 'demo-user';
const ask = createInterface({ input: process.stdin, output: process.stdout });

const tools = nearpays.agentTools({
  customer,
  // A person confirms every payment. Drop this to let the agent pay within
  // the customer's mandate limits on its own.
  confirm: async ({ summary }) =>
    (await ask.question(`Agent wants to go ahead with ${summary}. Allow? [y/N] `)).trim().toLowerCase() === 'y',
});

const messages = [{ role: 'user', content: process.argv.slice(2).join(' ') || 'What is my balance?' }];
for (let turn = 0; turn < 10; turn++) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system:
        'You help a customer with their Nearpays wallet: balance and bill payments. ' +
        'Validate a bill and tell the customer what the provider returned before paying it.',
      tools: toAnthropicTools(tools),
      messages,
    }),
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(reply));
  messages.push({ role: 'assistant', content: reply.content });
  for (const block of reply.content) if (block.type === 'text') console.log(block.text);
  if (reply.stop_reason !== 'tool_use') break;

  const results = [];
  for (const block of reply.content) {
    if (block.type !== 'tool_use') continue;
    const result = await runTool(tools, block.name, block.input);
    console.log(`  [${block.name}] → ${JSON.stringify(result).slice(0, 200)}`);
    results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
  }
  messages.push({ role: 'user', content: results });
}
ask.close();
