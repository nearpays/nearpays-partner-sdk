/**
 * The Nearpays client both examples share, configured from the environment:
 *
 *   NEARPAYS_BASE_URL          https://<api>/api/v2
 *   NEARPAYS_CLIENT_ID         npc_...
 *   NEARPAYS_PRIVATE_KEY_FILE  from `nearpays-partner keygen`
 *   NEARPAYS_WEBHOOK_SECRET    or NEARPAYS_WEBHOOK_SECRET_FILE
 *   PUBLIC_ORIGIN              default http://127.0.0.1:4000
 *   NEARPAYS_REDIRECT_PATH     default /nearpays/callback
 *   NEARPAYS_WEBHOOK_PATH      default /nearpays/webhooks
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// In your app: import { Nearpays } from '@nearpays/partner';
import { Nearpays } from '../src/index.ts';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Set ${name}`);
  return value;
};

export const ORIGIN = env('PUBLIC_ORIGIN', 'http://127.0.0.1:4000');
export const REDIRECT_PATH = env('NEARPAYS_REDIRECT_PATH', '/nearpays/callback');
export const WEBHOOK_PATH = env('NEARPAYS_WEBHOOK_PATH', '/nearpays/webhooks');
const baseUrl = env('NEARPAYS_BASE_URL');

/**
 * Keeps connections in a JSON file so the starter app and the agent example
 * share them. DEVELOPMENT ONLY: plaintext secrets, no locking. Use your
 * database or Redis, encrypted at rest, in production.
 */
class FileStore {
  constructor(path) {
    this.path = path;
  }
  #read() {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  }
  async get(key) {
    const entry = this.#read()[key];
    return entry && (!entry.expiresAt || entry.expiresAt > Date.now()) ? entry.value : undefined;
  }
  async set(key, value, ttlSeconds) {
    const all = this.#read();
    all[key] = { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined };
    writeFileSync(this.path, JSON.stringify(all), { mode: 0o600 });
  }
  async delete(key) {
    const all = this.#read();
    delete all[key];
    writeFileSync(this.path, JSON.stringify(all), { mode: 0o600 });
  }
}

export const nearpays = new Nearpays({
  baseUrl,
  clientId: env('NEARPAYS_CLIENT_ID'),
  privateKey: JSON.parse(readFileSync(env('NEARPAYS_PRIVATE_KEY_FILE'), 'utf8')),
  redirectUri: `${ORIGIN}${REDIRECT_PATH}`,
  webhookSecret: process.env.NEARPAYS_WEBHOOK_SECRET_FILE
    ? readFileSync(process.env.NEARPAYS_WEBHOOK_SECRET_FILE, 'utf8').trim()
    : env('NEARPAYS_WEBHOOK_SECRET'),
  store: new FileStore(new URL('./.dev-store.json', import.meta.url)),
  allowInsecureHttp: baseUrl.startsWith('http://'),
});
