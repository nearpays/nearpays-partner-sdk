import type { NearpaysError } from './errors.ts';

export type BillChannel = 'AIRTIME' | 'DATA' | 'ELECTRICITY';

/**
 * Limits you ask the customer to approve. Amounts are naira. The customer may
 * lower any of them before approving, never raise them, and none may exceed
 * the ceilings Nearpays set when it registered you.
 */
export interface MandateRequest {
  maxPerPayment: number;
  maxPerDay: number;
  maxPerMonth: number;
  maxPaymentsPerDay: number;
  /** When the permission ends. Default: when the connection does. */
  expiresAt?: Date;
}

export interface BillsMandateRequest extends MandateRequest {
  /** Only these bill types. Default: every bill type. */
  channels?: BillChannel[];
}

export interface ConnectOptions {
  /** Your own id for the customer. Every later call names them by it. */
  customer: string;
  /**
   * Ask to charge the customer. `true` shows them your registered ceilings to
   * approve; an object proposes your own limits.
   */
  charge?: boolean | MandateRequest;
  /** Ask to pay the customer's bills, as for `charge`. */
  bills?: boolean | BillsMandateRequest;
  /** Ask to see their balance. */
  balance?: boolean;
  /** Profile details released in the ID token. `name` is always asked for. */
  identity?: Array<'email' | 'phone'>;
}

/** A customer's connection, as `finish()` returns it. */
export interface Connection {
  customer: string;
  /** How Nearpays identifies this customer to you. Stable across reconnects. */
  sub: string;
  grantId: string;
  scopes: string[];
  profile: { name?: string; email?: string; phone?: string };
}

/** What the current token stands for, from `GET /open/grant`. */
export interface ConnectionInfo {
  sub: string;
  grantId: string;
  clientId: string;
  scopes: string[];
  tokenExpiresAt: string;
  grantExpiresAt: string | null;
}

export interface Balance {
  currency: string;
  balance: string;
  locked: string;
}

export interface Failure {
  code: string;
  message: string;
}

export interface Charge {
  id: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  amount: string;
  currency: string;
  description: string | null;
  reference: string | null;
  transactionReference: string | null;
  failure: Failure | null;
  createdAt: string;
  /** True when this is the stored result of an earlier identical request. */
  replayed: boolean;
}

export interface ChargeRequest {
  /** Naira, as a string or number, up to 2 decimals. */
  amount: string | number;
  /**
   * Your own unique reference for this charge, such as an invoice id. Retrying
   * with the same reference returns the first result and never charges twice.
   */
  reference: string;
  /** Shown to the customer on their statement. */
  description?: string;
  /** Overrides the key the SDK derives from `reference`. */
  idempotencyKey?: string;
}

export interface BillCategory {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface BillChannelInfo {
  id: string;
  name: BillChannel | string;
  requireSubCategory?: boolean;
  requireAmount?: boolean;
  minAmount?: string;
  maxAmount?: string;
  customerIdLabel?: string;
  [key: string]: unknown;
}

export interface BillValidation {
  /** Pass this to `bills.pay()`. */
  reference: string;
  /** What the provider returned about the customer (name, meter, network…). */
  response: Array<{ label: string; value: unknown }>;
  [key: string]: unknown;
}

export interface ValidateBillRequest {
  channel: BillChannel;
  categoryId: string;
  /** A data bundle or similar product, when the channel has them. */
  productId?: string;
  /** Phone number in +234 form (e.g. `+2348031234567`), meter number or smartcard number. */
  customerId: string;
  meterType?: 'PREPAID' | 'POSTPAID';
}

export interface PayBillRequest {
  validationReference: string;
  /** Required for airtime and electricity. */
  amount?: number;
  /** Your own unique reference; see `ChargeRequest.reference`. */
  reference: string;
  idempotencyKey?: string;
}

export interface BuyBillRequest {
  channel: BillChannel;
  /** A category id, or its name (e.g. "MTN", "IKEDC"). */
  category: string;
  /** A product id or name, for channels that need one (data bundles). */
  product?: string;
  /** Phone number in +234 form (e.g. `+2348031234567`), meter number or smartcard number. */
  customerId: string;
  meterType?: 'PREPAID' | 'POSTPAID';
  amount?: number;
  reference: string;
}

export interface BillPayment {
  id: string;
  /** PENDING: the provider hasn't confirmed yet; a webhook will follow. */
  status: 'PROCESSING' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';
  channel: string | null;
  amount: string | null;
  reference: string | null;
  /** The provider's answer; for electricity, includes the meter token. */
  result: Record<string, unknown> | null;
  failure: Failure | null;
  createdAt: string;
  replayed: boolean;
}

export type WebhookEventType =
  | 'grant.revoked'
  | 'mandate.paused'
  | 'mandate.resumed'
  | 'charge.completed'
  | 'charge.failed'
  | 'bill.completed'
  | 'bill.failed'
  | 'bill.refunded';

/** What `sendTestWebhook` queued. */
export interface TestWebhook {
  /** Matches the `X-Nearpays-Delivery` header on the request you receive. */
  deliveryId: string;
  type: WebhookEventType;
  /** Where it is being sent. */
  webhookUrl: string;
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType | string;
  createdAt: string;
  data: Record<string, unknown> & { sub?: string };
  /** Your id for the customer, when the SDK knows it. */
  customer?: string;
}

export type WebhookHandlers = Partial<
  Record<WebhookEventType | '*', (event: WebhookEvent) => unknown | Promise<unknown>>
>;

export type ToolResult = Record<string, unknown> | Array<unknown>;

export interface AgentToolError {
  error: string;
  message: string;
  headroom?: NearpaysError['headroom'];
}
