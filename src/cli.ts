#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateClientKeys } from './keys.ts';

const USAGE = `Usage: nearpays-partner keygen [--kid <id>] [--out <dir>]

Creates the ES256 key pair your server signs Nearpays requests with:
  nearpays-private-key.json   keep secret; load it as privateKey
  nearpays-public-jwks.json   send to Nearpays when you register`;

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (command !== 'keygen') {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

const out = flag('out') ?? '.';
const privatePath = join(out, 'nearpays-private-key.json');
const publicPath = join(out, 'nearpays-public-jwks.json');
if (existsSync(privatePath)) {
  console.error(`${privatePath} already exists; refusing to overwrite a key.`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const { privateJwk, publicJwks } = await generateClientKeys(flag('kid'));
writeFileSync(privatePath, JSON.stringify(privateJwk, null, 2) + '\n', { mode: 0o600 });
writeFileSync(publicPath, JSON.stringify(publicJwks, null, 2) + '\n');
console.log(`Key id: ${privateJwk.kid}
Private key: ${privatePath}  (secret: never commit or share it)
Public keys: ${publicPath}  (send this to Nearpays)`);
