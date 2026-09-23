import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// WhatsApp access-token encryption (audit findings H1 + H6)
// ---------------------------------------------------------------------------
// v1 (the original format) was `base64(iv || ciphertext || tag)` with the AES
// key being the first 32 bytes of MASTER_KEY. Three problems:
//
//   1. One key for every tenant and every row: no cryptographic separation, so
//      a single key compromise decrypts every tenant's token.
//   2. The ciphertext is not bound to the row it lives in. A token copied into
//      another tenant's row still decrypts, so any write primitive becomes
//      cross-tenant credential theft.
//   3. No key id, so MASTER_KEY could never be rotated: changing it would make
//      every stored token undecryptable with no migration path.
//
// v2 fixes all three:
//   envelope   `v2.<kid>.<base64(iv || ciphertext || tag)>`
//   key        HKDF-SHA256(MASTER_KEY, salt = tenant_id, info = "…:v2")
//   AAD        `${tenant_id}|${phone_number_id}`
//
// v1 ciphertexts still decrypt (decryptLegacy) so existing rows keep working;
// scripts/reencrypt-access-tokens.ts rewrites them as v2.
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce
const TAG_LENGTH = 16; // 128-bit auth tag
const KEY_LENGTH = 32;
const HKDF_INFO = Buffer.from('whatsapp-access-token:v2', 'utf8');
const V2_PREFIX = 'v2';
const KID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

/** One MASTER_KEY generation. `id` is what lands in the envelope as `kid`. */
export interface KeyGeneration {
  id: string;
  key: string;
}

/** Current key plus, during a rotation, the key still needed to read old rows. */
export interface MasterKeys {
  current: KeyGeneration;
  previous?: KeyGeneration;
}

/** The row identity the ciphertext is bound to (the AEAD associated data). */
export interface TokenContext {
  tenantId: string;
  phoneNumberId: string;
}

export class AccessTokenDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessTokenDecryptError';
  }
}

export function isEncryptedTokenV2(envelope: string): boolean {
  return envelope.startsWith(`${V2_PREFIX}.`);
}

/**
 * Build the key set from environment-style configuration.
 *
 * `MASTER_KEY` is the generation new ciphertexts use; `MASTER_KEY_PREVIOUS`
 * keeps rows written before a rotation readable until
 * scripts/reencrypt-access-tokens.ts has rewritten them, after which the
 * previous key can be dropped. Ids appear in the envelope as `kid`.
 */
export function masterKeysFromConfig(input: {
  masterKey: string;
  masterKeyId?: string;
  previousMasterKey?: string;
  previousMasterKeyId?: string;
}): MasterKeys {
  const currentId = input.masterKeyId ?? 'k1';
  if (!KID_PATTERN.test(currentId)) {
    throw new Error(`MASTER_KEY_ID '${currentId}' must match ${KID_PATTERN}`);
  }

  const generation: MasterKeys = { current: { id: currentId, key: input.masterKey } };
  if (!input.previousMasterKey) return generation;

  const previousId = input.previousMasterKeyId ?? 'k0';
  if (!KID_PATTERN.test(previousId)) {
    throw new Error(`MASTER_KEY_PREVIOUS_ID '${previousId}' must match ${KID_PATTERN}`);
  }
  if (previousId === currentId) {
    throw new Error(
      `MASTER_KEY_PREVIOUS_ID must differ from MASTER_KEY_ID ('${currentId}'): the id in the ` +
        'envelope decides which key is tried, so identical ids make the previous key unreachable',
    );
  }

  return { current: generation.current, previous: { id: previousId, key: input.previousMasterKey } };
}

/**
 * Per-tenant key derivation. HKDF rather than a plain hash: it is a one-way,
 * domain-separated derivation, so a leaked derived key does not expose
 * MASTER_KEY and two tenants never share key material.
 */
export function deriveTenantKey(masterKey: string, tenantId: string): Buffer {
  const derived = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from(tenantId, 'utf8'),
    HKDF_INFO,
    KEY_LENGTH,
  );
  return Buffer.from(derived);
}

/**
 * `ivOverride` exists only so tests can produce deterministic cross-language
 * vectors (the Python side must agree on HKDF and AAD byte for byte).
 * Production callers omit it and get a fresh random nonce.
 */
export function encryptAccessToken(
  plaintext: string,
  keys: MasterKeys,
  context: TokenContext,
  ivOverride?: Buffer,
): string {
  const iv = ivOverride ?? randomBytes(IV_LENGTH);
  if (iv.length !== IV_LENGTH) {
    throw new Error(`IV must be ${IV_LENGTH} bytes, got ${iv.length}`);
  }

  const cipher = createCipheriv(ALGORITHM, deriveTenantKey(keys.current.key, context.tenantId), iv);
  cipher.setAAD(aadFor(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${V2_PREFIX}.${keys.current.id}.${Buffer.concat([iv, ciphertext, tag]).toString('base64')}`;
}

export function decryptAccessToken(
  envelope: string,
  keys: MasterKeys,
  context: TokenContext,
): string {
  if (isEncryptedTokenV2(envelope)) return decryptV2(envelope, keys, context);
  return decryptLegacy(envelope, keys);
}

function decryptV2(envelope: string, keys: MasterKeys, context: TokenContext): string {
  const [, kid, payload] = envelope.split('.');
  if (!kid || !payload) {
    throw new AccessTokenDecryptError('Malformed v2 envelope (expected v2.<kid>.<payload>)');
  }
  if (!KID_PATTERN.test(kid)) {
    throw new AccessTokenDecryptError(`Malformed key id '${kid}'`);
  }

  const generation = keyFor(kid, keys);
  if (!generation) {
    throw new AccessTokenDecryptError(
      `No key configured for key id '${kid}' (check MASTER_KEY_ID / MASTER_KEY_PREVIOUS_ID)`,
    );
  }

  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new AccessTokenDecryptError('v2 payload is too short to contain an IV and auth tag');
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveTenantKey(generation.key, context.tenantId),
      raw.subarray(0, IV_LENGTH),
    );
    decipher.setAAD(aadFor(context));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_LENGTH));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authenticates the ciphertext *and* the AAD, so this also covers
    // "this token belongs to a different tenant or phone number".
    throw new AccessTokenDecryptError(
      'Access-token authentication failed: wrong key, wrong tenant/phone binding, or tampered ciphertext',
    );
  }
}

/**
 * v1: no key id, no AAD, key = first 32 bytes of the master key. Tried against
 * the current key first, then the previous one, so a rotation that only changes
 * the derivation (v1 -> v2) still reads old rows.
 */
function decryptLegacy(envelope: string, keys: MasterKeys): string {
  const candidates = [keys.current.key, keys.previous?.key].filter(
    (key): key is string => typeof key === 'string',
  );

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return legacyGcmDecrypt(envelope, candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw new AccessTokenDecryptError(
    `Legacy (v1) access-token decryption failed with every configured key: ${
      lastError instanceof Error ? lastError.message : 'unknown error'
    }`,
  );
}

function legacyGcmDecrypt(envelope: string, masterKey: string): string {
  const raw = Buffer.from(envelope, 'base64');
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new AccessTokenDecryptError('Legacy payload is too short to contain an IV and auth tag');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    legacyDeriveKey(masterKey),
    raw.subarray(0, IV_LENGTH),
  );
  decipher.setAuthTag(raw.subarray(raw.length - TAG_LENGTH));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Byte-for-byte reproduction of the v1 key derivation (truncate if long enough,
 * zero-pad otherwise) so pre-existing ciphertexts keep decrypting unchanged.
 */
function legacyDeriveKey(masterKey: string): Buffer {
  const raw = Buffer.from(masterKey, 'utf8');
  if (raw.length >= KEY_LENGTH) return raw.subarray(0, KEY_LENGTH);
  return Buffer.concat([raw, Buffer.alloc(KEY_LENGTH - raw.length)]);
}

function keyFor(kid: string, keys: MasterKeys): KeyGeneration | undefined {
  if (keys.current.id === kid) return keys.current;
  if (keys.previous?.id === kid) return keys.previous;
  return undefined;
}

/** The bytes GCM authenticates alongside the ciphertext. */
function aadFor(context: TokenContext): Buffer {
  return Buffer.from(`${context.tenantId}|${context.phoneNumberId}`, 'utf8');
}
