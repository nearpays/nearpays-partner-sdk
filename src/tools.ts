import { NearpaysError } from './errors.ts';
import type { Nearpays } from './client.ts';
import type { AgentToolError, BillChannel } from './types.ts';

/** JSON Schema for a tool's input. */
export type JsonSchema = Record<string, unknown>;

/**
 * One operation an AI agent can call. `execute` never throws for a Nearpays
 * refusal: it returns `{ error, message }` the agent can read and explain.
 */
export interface AgentTool {
  name: AgentToolName;
  description: string;
  inputSchema: JsonSchema;
  /** Whether calling it can move money. */
  movesMoney: boolean;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export type AgentToolName =
  | 'get_balance'
  | 'list_bill_categories'
  | 'list_bill_products'
  | 'validate_bill'
  | 'pay_bill'
  | 'get_bill_payment'
  | 'charge_customer'
  | 'get_charge';

export interface AgentToolsOptions {
  /**
   * The one customer these tools act for. Bind tools per conversation, so an
   * agent can never reach a customer it wasn't given.
   */
  customer: string;
  /** Only offer these tools. Default: all of them. */
  only?: AgentToolName[];
  /**
   * Asked before any tool that moves money runs. Return false to stop it,
   * e.g. after asking your user. Without it, money tools run within the
   * customer's mandate limits.
   */
  confirm?: (call: { tool: AgentToolName; input: Record<string, unknown>; summary: string }) =>
    | boolean
    | Promise<boolean>;
}

const CHANNELS: BillChannel[] = ['AIRTIME', 'DATA', 'ELECTRICITY'];

const REFERENCE = {
  type: 'string',
  maxLength: 100,
  description:
    'A unique id you make up for this one payment, e.g. "airtime-2026-10-05-1". ' +
    'If a call fails or you are unsure it went through, retry with the SAME reference: ' +
    'it returns the first result and never pays twice. Use a new reference only for a new payment.',
};

/** Builds the tools for one customer. Prefer `nearpays.agentTools()`. */
export function createAgentTools(nearpays: Nearpays, options: AgentToolsOptions): AgentTool[] {
  const { customer } = options;
  if (!customer) throw new NearpaysError('invalid_request', 'customer is required');

  const guarded = async (
    tool: AgentToolName,
    input: Record<string, unknown>,
    summary: string,
    run: () => Promise<unknown>,
  ) => {
    if (options.confirm && !(await options.confirm({ tool, input, summary }))) {
      return { error: 'not_confirmed', message: `Not done: ${summary} was not confirmed.` };
    }
    return run();
  };

  const tools: AgentTool[] = [
    {
      name: 'get_balance',
      movesMoney: false,
      description: "Gets the customer's Nearpays wallet balance in naira.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => nearpays.balance(customer),
    },
    {
      name: 'list_bill_categories',
      movesMoney: false,
      description:
        'Lists the providers for a bill type: mobile networks for AIRTIME and DATA, ' +
        'electricity distribution companies for ELECTRICITY. Returns their ids.',
      inputSchema: {
        type: 'object',
        properties: { channel: { type: 'string', enum: CHANNELS } },
        required: ['channel'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const channel = String(input.channel).toUpperCase();
        const found = (await nearpays.bills.channels(customer)).find(
          (c) => String(c.name).toUpperCase() === channel,
        );
        if (!found) return { error: 'unknown_channel', message: `No ${channel} bills available` };
        const categories = await nearpays.bills.categories(customer, found.id);
        return {
          channel,
          requiresProduct: !!found.requireSubCategory,
          requiresAmount: !!found.requireAmount,
          minAmount: found.minAmount,
          maxAmount: found.maxAmount,
          categories: categories.map((c) => ({ id: c.id, name: c.name })),
        };
      },
    },
    {
      name: 'list_bill_products',
      movesMoney: false,
      description:
        'Lists the products of a bill provider, such as data bundles, with their prices. ' +
        'Use the categoryId from list_bill_categories.',
      inputSchema: {
        type: 'object',
        properties: { categoryId: { type: 'string' } },
        required: ['categoryId'],
        additionalProperties: false,
      },
      execute: async (input) =>
        (await nearpays.bills.products(customer, String(input.categoryId))).map((p) => ({
          id: p.id,
          name: p.name,
          price: p.sellingPrice,
          fee: p.fee,
          duration: p.duration,
        })),
    },
    {
      name: 'validate_bill',
      movesMoney: false,
      description:
        'Checks a phone, meter or smartcard number with the provider before paying, and returns ' +
        'a validationReference for pay_bill plus what the provider knows (e.g. the meter owner). ' +
        'Show the customer those details before paying.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: CHANNELS },
          categoryId: { type: 'string', description: 'From list_bill_categories' },
          productId: { type: 'string', description: 'From list_bill_products, when required' },
          customerId: { type: 'string', description: 'Phone number in +234 form (e.g. +2348031234567), meter number or smartcard number' },
          meterType: { type: 'string', enum: ['PREPAID', 'POSTPAID'] },
        },
        required: ['channel', 'categoryId', 'customerId'],
        additionalProperties: false,
      },
      execute: (input) =>
        nearpays.bills.validate(customer, {
          channel: String(input.channel).toUpperCase() as BillChannel,
          categoryId: String(input.categoryId),
          productId: input.productId ? String(input.productId) : undefined,
          customerId: String(input.customerId),
          meterType: input.meterType as 'PREPAID' | 'POSTPAID' | undefined,
        }),
    },
    {
      name: 'pay_bill',
      movesMoney: true,
      description:
        "Pays a validated bill from the customer's wallet, within the limits they approved. " +
        'A PENDING status means the provider has not confirmed yet; check later with get_bill_payment.',
      inputSchema: {
        type: 'object',
        properties: {
          validationReference: { type: 'string', description: 'From validate_bill' },
          amount: { type: 'number', description: 'Naira; required for airtime and electricity' },
          reference: REFERENCE,
        },
        required: ['validationReference', 'reference'],
        additionalProperties: false,
      },
      execute: (input) =>
        guarded(
          'pay_bill',
          input,
          `paying a bill${input.amount ? ` of ₦${input.amount}` : ''}`,
          () =>
            nearpays.bills.pay(customer, {
              validationReference: String(input.validationReference),
              amount: input.amount === undefined ? undefined : Number(input.amount),
              reference: String(input.reference),
            }),
        ),
    },
    {
      name: 'get_bill_payment',
      movesMoney: false,
      description: 'Gets the current status of a bill payment by its id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      execute: (input) => nearpays.bills.get(customer, String(input.id)),
    },
    {
      name: 'charge_customer',
      movesMoney: true,
      description:
        "Charges the customer's Nearpays wallet, paid to your business, within the limits " +
        'they approved. Only charge for something the customer has agreed to pay for.',
      inputSchema: {
        type: 'object',
        properties: {
          amount: { type: 'string', pattern: '^[0-9]+(\\.[0-9]{1,2})?$', description: 'Naira, e.g. "1500" or "1500.50"' },
          description: { type: 'string', maxLength: 200, description: "Shown on the customer's statement" },
          reference: REFERENCE,
        },
        required: ['amount', 'reference'],
        additionalProperties: false,
      },
      execute: (input) =>
        guarded('charge_customer', input, `charging ₦${input.amount}`, () =>
          nearpays.charges.create(customer, {
            amount: String(input.amount),
            reference: String(input.reference),
            description: input.description ? String(input.description) : undefined,
          }),
        ),
    },
    {
      name: 'get_charge',
      movesMoney: false,
      description: 'Gets the current status of a charge by its id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      execute: (input) => nearpays.charges.get(customer, String(input.id)),
    },
  ];

  return tools
    .filter((t) => !options.only || options.only.includes(t.name))
    .map((t) => ({ ...t, execute: (input: Record<string, unknown>) => safely(() => t.execute(input ?? {})) }));
}

/** Refusals become data the agent can read; anything unexpected still throws. */
async function safely(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof NearpaysError)) throw error;
    const result: AgentToolError = { error: error.code, message: error.message };
    if (error.headroom) {
      result.headroom = error.headroom;
      result.message +=
        ` Left today: ₦${error.headroom.today}; this month: ₦${error.headroom.thisMonth};` +
        ` largest single payment: ₦${error.headroom.perTransaction}.`;
    }
    return result;
  }
}

/** The tools in the Anthropic Messages API format. */
export function toAnthropicTools(tools: AgentTool[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

/** The tools in the OpenAI function-calling format. */
export function toOpenAITools(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** Runs the tool an agent asked for, by name. */
export async function runTool(
  tools: AgentTool[],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: 'unknown_tool', message: `No tool named ${name}` };
  return tool.execute(input);
}
