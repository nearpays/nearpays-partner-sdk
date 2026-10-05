import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { NearpaysError } from '../src/errors.ts';
import { MemoryStore } from '../src/store.ts';
import { PostgresStore, RedisStore, encryptStore } from '../src/stores.ts';

/** Just enough Redis for the store: GET, SET (EX, NX, PX), DEL and the release script. */
class FakeRedis {
  values = new Map<string, string>();
  commands: string[][] = [];

  async run(args: string[]): Promise<unknown> {
    this.commands.push(args);
    const [command, key, ...rest] = args;
    switch (command) {
      case 'GET':
        return this.values.get(key) ?? null;
      case 'SET':
        if (rest.includes('NX') && this.values.has(key)) return null;
        this.values.set(key, rest[0]);
        return 'OK';
      case 'DEL':
        return this.values.delete(key) ? 1 : 0;
      case 'EVAL': {
        const [name, token] = rest.slice(1);
        if (this.values.get(name) !== token) return 0;
        this.values.delete(name);
        return 1;
      }
      default:
        throw new Error(`unexpected ${command}`);
    }
  }
}

const ioredis = (fake: FakeRedis) => ({ call: (c: string, ...a: (string | number)[]) => fake.run([c, ...a.map(String)]) });
const nodeRedis = (fake: FakeRedis) => ({ sendCommand: (a: string[]) => fake.run(a) });

describe('RedisStore', () => {
  for (const [name, wrap] of [['ioredis', ioredis], ['node-redis', nodeRedis]] as const) {
    it(`gets, sets with a TTL and deletes through ${name}`, async () => {
      const fake = new FakeRedis();
      const store = new RedisStore(wrap(fake), { prefix: 'app:' });
      await store.set('a', '1', 900);
      await store.set('b', '2');
      assert.equal(await store.get('a'), '1');
      assert.equal(await store.get('missing'), undefined);
      await store.delete('a');
      assert.equal(await store.get('a'), undefined);
      assert.deepEqual(fake.commands[0], ['SET', 'app:a', '1', 'EX', '900']);
      assert.deepEqual(fake.commands[1], ['SET', 'app:b', '2']);
    });
  }

  it('runs one holder of a lock at a time, and releases it after a failure', async () => {
    const fake = new FakeRedis();
    const store = new RedisStore(ioredis(fake));
    const order: string[] = [];
    const work = (id: string) => store.lock('nearpays:lock:user_42', async () => {
      order.push(`${id} in`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${id} out`);
    });
    await Promise.all([work('one'), work('two')]);
    assert.deepEqual(order, ['one in', 'one out', 'two in', 'two out']);

    await assert.rejects(store.lock('k', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(fake.values.has('k'), false);
  });

  it('refuses something that is not a Redis client', () => {
    assert.throws(() => new RedisStore({} as never), NearpaysError);
  });
});

/** Records what PostgresStore sends. */
function fakePool(rows: Record<string, unknown>[] = []) {
  const sent: { text: string; values?: unknown[] }[] = [];
  const pool = {
    sent,
    released: 0,
    async query(text: string, values?: unknown[]) {
      sent.push({ text, values });
      return { rows };
    },
    async connect() {
      return {
        query: async (text: string, values?: unknown[]) => { sent.push({ text, values }); },
        release: () => { pool.released += 1; },
      };
    },
  };
  return pool;
}

describe('PostgresStore', () => {
  it('reads only unexpired rows and writes the TTL as an expiry', async () => {
    const pool = fakePool([{ value: 'v' }]);
    const store = new PostgresStore(pool, { table: 'app.nearpays_store' });
    assert.equal(await store.get('k'), 'v');
    await store.set('k', 'v', 900);
    await store.set('k', 'v');
    assert.match(pool.sent[0].text, /FROM app\.nearpays_store WHERE key = \$1 AND \(expires_at IS NULL OR expires_at > now\(\)\)/);
    assert.deepEqual(pool.sent[1].values, ['k', 'v', 900]);
    assert.deepEqual(pool.sent[2].values, ['k', 'v', null]);
    assert.match(pool.sent[1].text, /ON CONFLICT \(key\) DO UPDATE/);
  });

  it('holds an advisory lock on its own connection, and gives it back', async () => {
    const pool = fakePool();
    const store = new PostgresStore(pool);
    await assert.rejects(store.lock('nearpays:lock:user_42', async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(pool.sent.map((s) => s.text), [
      'SELECT pg_advisory_lock(hashtext($1))',
      'SELECT pg_advisory_unlock(hashtext($1))',
    ]);
    assert.equal(pool.released, 1);
  });

  it('refuses a table name it would have to quote', () => {
    assert.throws(() => new PostgresStore(fakePool(), { table: 'x; DROP TABLE users' }), NearpaysError);
  });
});

describe('encryptStore', () => {
  const key = randomBytes(32);

  it('stores ciphertext and reads back the value', async () => {
    const inner = new MemoryStore();
    const store = encryptStore(inner, key.toString('base64'));
    await store.set('nearpays:connection:user_42', '{"accessToken":"secret"}');
    const raw = await inner.get('nearpays:connection:user_42');
    assert.match(raw ?? '', /^v1\./);
    assert.doesNotMatch(raw ?? '', /secret/);
    assert.equal(await store.get('nearpays:connection:user_42'), '{"accessToken":"secret"}');
    assert.equal(await store.get('missing'), undefined);
  });

  it('will not decrypt a value moved to another key, or a plain one', async () => {
    const inner = new MemoryStore();
    const store = encryptStore(inner, key);
    await store.set('nearpays:connection:alice', 'tokens');
    await inner.set('nearpays:connection:mallory', (await inner.get('nearpays:connection:alice'))!);
    await assert.rejects(store.get('nearpays:connection:mallory'), { code: 'store_decrypt_failed' });
    await inner.set('plain', 'tokens');
    await assert.rejects(store.get('plain'), { code: 'store_decrypt_failed' });
  });

  it('reads values written with a previous key', async () => {
    const inner = new MemoryStore();
    await encryptStore(inner, key).set('k', 'v');
    const rotated = encryptStore(inner, randomBytes(32), { previousKeys: [key] });
    assert.equal(await rotated.get('k'), 'v');
    await assert.rejects(encryptStore(inner, randomBytes(32)).get('k'), { code: 'store_decrypt_failed' });
  });

  it('passes the lock through, and needs a 32-byte key', async () => {
    const fake = new FakeRedis();
    const store = encryptStore(new RedisStore(ioredis(fake)), key);
    assert.equal(await store.lock?.('k', async () => 'ran'), 'ran');
    assert.equal(encryptStore(new MemoryStore(), key).lock, undefined);
    assert.throws(() => encryptStore(new MemoryStore(), 'short'), NearpaysError);
    assert.throws(() => encryptStore(new MemoryStore(), undefined), NearpaysError);
  });
});
