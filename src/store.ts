/**
 * Where the SDK keeps each customer's connection: their tokens and the DPoP
 * key the tokens are bound to, plus short-lived sign-in state and webhook
 * delivery ids. Values are JSON strings.
 *
 * What it holds is secret. Use your database or Redis, encrypt it at rest,
 * and never log it.
 *
 * Running more than one instance of your server? Implement `lock`, so two
 * instances never refresh the same customer's tokens at once. A refresh token
 * works once, and Nearpays treats a second use as theft and disconnects the
 * customer.
 */
export interface Store {
  get(key: string): Promise<string | null | undefined>;
  /** `ttlSeconds` absent means keep until deleted. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Runs `fn` while holding a lock on `key` across all your instances. */
  lock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Keeps everything in this process's memory. For tests and local
 * development only: a restart disconnects every customer, and two instances
 * don't share it.
 */
export class MemoryStore implements Store {
  #values = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | undefined> {
    const entry = this.#values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.#values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.#values.set(key, {
      value,
      expiresAt:
        ttlSeconds === undefined ? undefined : Date.now() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }
}

export const storeKeys = {
  connection: (customer: string) => `nearpays:connection:${customer}`,
  subject: (sub: string) => `nearpays:sub:${sub}`,
  pending: (state: string) => `nearpays:pending:${state}`,
  webhook: (id: string) => `nearpays:webhook:${id}`,
  lock: (customer: string) => `nearpays:lock:${customer}`,
};
