import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { NearpaysError } from './errors.ts';
import type { Store } from './store.ts';

/** How long a lock is held at most, should its holder crash. */
const LOCK_TTL_MS = 30_000;
/** How long to wait for another instance's lock before giving up. */
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Redis client from `ioredis` or `redis` (node-redis 4+). The SDK sends raw
 * commands, so it needs neither as a dependency.
 */
export type RedisClient =
  | { call(command: string, ...args: (string | number)[]): Promise<unknown> }
  | { sendCommand(args: string[]): Promise<unknown> };

export interface RedisStoreOptions {
  /** Put before every key, e.g. `myapp:`. */
  prefix?: string;
}

/** Deletes the lock only if this instance still holds it. */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Keeps connections in Redis, with a lock that works across all your
 * instances. Turn on Redis persistence (AOF): losing the data disconnects
 * every customer.
 *
 * ```ts
 * import Redis from 'ioredis';
 * const store = new RedisStore(new Redis(process.env.REDIS_URL));
 * ```
 */
export class RedisStore implements Store {
  readonly #send: (args: string[]) => Promise<unknown>;
  readonly #prefix: string;

  constructor(client: RedisClient, options: RedisStoreOptions = {}) {
    if ('call' in client && typeof client.call === 'function') {
      this.#send = ([command, ...args]) => client.call(command, ...args);
    } else if ('sendCommand' in client && typeof client.sendCommand === 'function') {
      this.#send = (args) => client.sendCommand(args);
    } else {
      throw new NearpaysError('invalid_options', 'RedisStore needs an ioredis or node-redis client');
    }
    this.#prefix = options.prefix ?? '';
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.#send(['GET', this.#prefix + key]);
    return value == null ? undefined : String(value);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const args = ['SET', this.#prefix + key, value];
    if (ttlSeconds !== undefined) args.push('EX', String(Math.max(1, Math.ceil(ttlSeconds))));
    await this.#send(args);
  }

  async delete(key: string): Promise<void> {
    await this.#send(['DEL', this.#prefix + key]);
  }

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const name = this.#prefix + key;
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while ((await this.#send(['SET', name, token, 'NX', 'PX', String(LOCK_TTL_MS)])) == null) {
      if (Date.now() > deadline) {
        throw new NearpaysError('lock_timeout', `Timed out waiting for ${key}`);
      }
      await sleep(LOCK_POLL_MS);
    }
    try {
      return await fn();
    } finally {
      await this.#send(['EVAL', RELEASE_SCRIPT, '1', name, token]);
    }
  }
}

/** A `pg` Pool, or anything with the same `query` and `connect`. */
export interface PostgresPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<unknown>;
    release(): void;
  }>;
}

export interface PostgresStoreOptions {
  /** Defaults to `nearpays_store`. May include a schema, e.g. `app.nearpays_store`. */
  table?: string;
}

/**
 * Keeps connections in a Postgres table, with a lock that works across all
 * your instances (an advisory lock). Call `createTable()` once, e.g. in a
 * migration, and `prune()` now and then to drop expired rows.
 *
 * The lock holds one pool connection while tokens refresh, so give the pool
 * at least two.
 *
 * ```ts
 * import pg from 'pg';
 * const store = new PostgresStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
 * await store.createTable();
 * ```
 */
export class PostgresStore implements Store {
  readonly #pool: PostgresPool;
  readonly #table: string;

  constructor(pool: PostgresPool, options: PostgresStoreOptions = {}) {
    const table = options.table ?? 'nearpays_store';
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(table)) {
      throw new NearpaysError('invalid_options', `Not a usable table name: ${table}`);
    }
    this.#pool = pool;
    this.#table = table;
  }

  async createTable(): Promise<void> {
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#table} (
        key text PRIMARY KEY,
        value text NOT NULL,
        expires_at timestamptz
      )`,
    );
  }

  /** Deletes expired rows. Returns how many. */
  async prune(): Promise<number> {
    const { rows } = await this.#pool.query(
      `WITH gone AS (DELETE FROM ${this.#table} WHERE expires_at <= now() RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async get(key: string): Promise<string | undefined> {
    const { rows } = await this.#pool.query(
      `SELECT value FROM ${this.#table} WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [key],
    );
    return rows.length ? String(rows[0].value) : undefined;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.#pool.query(
      `INSERT INTO ${this.#table} (key, value, expires_at)
       VALUES ($1, $2, now() + $3::double precision * interval '1 second')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [key, value, ttlSeconds ?? null],
    );
  }

  async delete(key: string): Promise<void> {
    await this.#pool.query(`DELETE FROM ${this.#table} WHERE key = $1`, [key]);
  }

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
    } finally {
      client.release();
    }
  }
}

export interface EncryptStoreOptions {
  /** Keys you encrypted with before, so you can rotate. Tried after `key`. */
  previousKeys?: (string | Uint8Array)[];
}

const VERSION = 'v1.';

/**
 * Encrypts every value with AES-256-GCM before it reaches `store`, so a
 * leaked database or Redis dump holds no usable tokens. The key is 32 bytes,
 * raw or base64 (`openssl rand -base64 32`); keep it outside that database.
 *
 * Each value is bound to its key name, so a value copied to another key does
 * not decrypt. To rotate, pass the new key as `key` and the old one in
 * `previousKeys`; values are re-encrypted as they are next written.
 *
 * ```ts
 * const store = encryptStore(new RedisStore(redis), process.env.NEARPAYS_STORE_KEY);
 * ```
 */
export function encryptStore(
  store: Store,
  key: string | Uint8Array | undefined,
  options: EncryptStoreOptions = {},
): Store {
  const current = toKey(key);
  const keys = [current, ...(options.previousKeys ?? []).map(toKey)];

  const encrypted: Store = {
    async get(name) {
      const value = await store.get(name);
      if (value == null) return value;
      if (!value.startsWith(VERSION)) {
        throw new NearpaysError('store_decrypt_failed', `The stored value for ${name} is not encrypted`);
      }
      const data = Buffer.from(value.slice(VERSION.length), 'base64url');
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const body = data.subarray(28);
      for (const k of keys) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', k, iv);
          decipher.setAAD(Buffer.from(name));
          decipher.setAuthTag(tag);
          return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
        } catch {
          // Try the next key.
        }
      }
      throw new NearpaysError('store_decrypt_failed', `The stored value for ${name} did not decrypt with any key`);
    },
    async set(name, value, ttlSeconds) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', current, iv);
      cipher.setAAD(Buffer.from(name));
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
      await store.set(name, VERSION + sealed, ttlSeconds);
    },
    delete: (name) => store.delete(name),
  };
  if (store.lock) {
    const lock = store.lock.bind(store);
    encrypted.lock = (name, fn) => lock(name, fn);
  }
  return encrypted;
}

function toKey(key: string | Uint8Array | undefined): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'base64') : key ? Buffer.from(key) : undefined;
  if (!bytes || bytes.length !== 32) {
    throw new NearpaysError(
      'invalid_options',
      'The store encryption key must be 32 bytes, raw or base64 (openssl rand -base64 32)',
    );
  }
  return bytes;
}
