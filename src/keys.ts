import { createPrivateKey, randomUUID, webcrypto } from 'node:crypto';
import { NearpaysError } from './errors.ts';

const { subtle } = webcrypto;
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** A private key as a JWK (with its `kid`), or a PEM string. */
export type ClientKeyInput = (JsonWebKey & { kid?: string }) | string;

export interface ClientKey {
  key: CryptoKey;
  kid: string;
}

/**
 * A fresh ES256 key pair for authenticating to Nearpays. Keep `privateJwk`
 * secret on your server; send `publicJwks` to Nearpays when you register.
 */
export async function generateClientKeys(
  kid = `nearpays-${randomUUID().slice(0, 8)}`,
): Promise<{ privateJwk: JsonWebKey & { kid: string }; publicJwks: { keys: JsonWebKey[] } }> {
  const pair = await subtle.generateKey(EC, true, ['sign', 'verify']);
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await subtle.exportKey('jwk', pair.publicKey);
  return {
    privateJwk: { ...privateJwk, kid, alg: 'ES256', use: 'sig' },
    publicJwks: { keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' } as JsonWebKey] },
  };
}

/** Loads the private key the SDK signs its token requests with. */
export async function importClientKey(
  input: ClientKeyInput,
  kid?: string,
): Promise<ClientKey> {
  let jwk: JsonWebKey & { kid?: string };
  if (typeof input === 'string') {
    try {
      jwk = createPrivateKey(input).export({ format: 'jwk' }) as JsonWebKey;
    } catch (cause) {
      throw new NearpaysError('invalid_key', 'privateKey is not a valid PEM private key', { cause });
    }
  } else {
    jwk = input;
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) {
    throw new NearpaysError(
      'invalid_key',
      'privateKey must be an EC P-256 (ES256) private key',
    );
  }
  const keyId = kid ?? jwk.kid;
  if (!keyId) {
    throw new NearpaysError(
      'invalid_key',
      'The key needs a kid: the one you registered with Nearpays',
    );
  }
  const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...material } = jwk as Record<string, unknown>;
  const key = await subtle.importKey('jwk', material as JsonWebKey, EC, false, ['sign']);
  return { key, kid: keyId };
}

/** A stored DPoP key pair. */
export interface StoredKeyPair {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/** A new DPoP key pair for one customer's connection, exportable so it can be stored. */
export async function newDPoPKeyPair(): Promise<{ pair: CryptoKeyPair; stored: StoredKeyPair }> {
  const pair = await subtle.generateKey(EC, true, ['sign', 'verify']);
  return {
    pair,
    stored: {
      privateJwk: await subtle.exportKey('jwk', pair.privateKey),
      publicJwk: await subtle.exportKey('jwk', pair.publicKey),
    },
  };
}

export async function importDPoPKeyPair(stored: StoredKeyPair): Promise<CryptoKeyPair> {
  return {
    privateKey: await subtle.importKey('jwk', stored.privateJwk, EC, false, ['sign']),
    publicKey: await subtle.importKey('jwk', stored.publicJwk, EC, true, ['verify']),
  };
}
