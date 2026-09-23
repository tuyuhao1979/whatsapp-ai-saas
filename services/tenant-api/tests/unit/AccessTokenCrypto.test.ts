import { createCipheriv, randomBytes } from 'node:crypto';
import {
  AccessTokenDecryptError,
  decryptAccessToken,
  deriveTenantKey,
  encryptAccessToken,
  isEncryptedTokenV2,
  masterKeysFromConfig,
  type MasterKeys,
  type TokenContext,
} from '../../src/application/tenant/encryption.js';

// Regression coverage for audit findings H1 + H6: the access token at rest must
// be bound to its row (AAD), keyed per tenant (HKDF), and versioned so
// MASTER_KEY can be rotated.

const MASTER_KEY = 'M'.repeat(32);
const KEYS: MasterKeys = masterKeysFromConfig({ masterKey: MASTER_KEY, masterKeyId: 'k1' });
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CTX_A: TokenContext = { tenantId: TENANT_A, phoneNumberId: 'pn-1' };
const TOKEN = 'EAAG-test-access-token';

/**
 * Produced by services/flow-engine/flow_engine/infrastructure/crypto.py with the
 * same key, tenant, phone number and IV. If either side changes its HKDF info,
 * salt, AAD layout, or envelope framing, this fails on the side that did not
 * change -- which is the only thing keeping the two services interoperable.
 */
const CROSS_LANGUAGE_ENVELOPE =
  'v2.k1.AAECAwQFBgcICQoLvvpxQXmMlu3DyFiZ6s1dYly+z51rg5xC5PpByj3QMj2/ATZTiYM=';
const FIXED_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

describe('envelope format', () => {
  it('produces the exact envelope the Python side produces', () => {
    expect(encryptAccessToken(TOKEN, KEYS, CTX_A, FIXED_IV)).toBe(CROSS_LANGUAGE_ENVELOPE);
  });

  it('decrypts the envelope produced by the Python side', () => {
    expect(decryptAccessToken(CROSS_LANGUAGE_ENVELOPE, KEYS, CTX_A)).toBe(TOKEN);
  });

  it('carries the key id and is recognisable as v2', () => {
    const envelope = encryptAccessToken(TOKEN, KEYS, CTX_A);
    expect(envelope.startsWith('v2.k1.')).toBe(true);
    expect(isEncryptedTokenV2(envelope)).toBe(true);
    expect(isEncryptedTokenV2('AAAA')).toBe(false);
  });

  it('round-trips with a random nonce', () => {
    for (let i = 0; i < 5; i += 1) {
      const envelope = encryptAccessToken(TOKEN, KEYS, CTX_A);
      expect(decryptAccessToken(envelope, KEYS, CTX_A)).toBe(TOKEN);
      // A fresh nonce every time, so two encryptions of the same value differ.
      expect(envelope).not.toBe(encryptAccessToken(TOKEN, KEYS, CTX_A));
    }
  });
});

describe('row binding (AAD)', () => {
  // The pre-fix behaviour: the ciphertext carried no associated data, so it
  // decrypted anywhere it was copied to.
  it('refuses to decrypt a token under a different tenant id', () => {
    const envelope = encryptAccessToken(TOKEN, KEYS, CTX_A);
    expect(() => decryptAccessToken(envelope, KEYS, { ...CTX_A, tenantId: TENANT_B })).toThrow(
      AccessTokenDecryptError,
    );
  });

  it('refuses to decrypt a token under a different phone number id', () => {
    const envelope = encryptAccessToken(TOKEN, KEYS, CTX_A);
    expect(() => decryptAccessToken(envelope, KEYS, { ...CTX_A, phoneNumberId: 'pn-2' })).toThrow(
      /authentication failed/,
    );
  });

  it('refuses a tampered ciphertext', () => {
    const envelope = encryptAccessToken(TOKEN, KEYS, CTX_A);
    const [prefix, kid, payload] = envelope.split('.');
    const raw = Buffer.from(payload!, 'base64');
    const last = raw.length - 1;
    raw.writeUInt8(raw.readUInt8(last) ^ 0x01, last);
    const tampered = `${prefix}.${kid}.${raw.toString('base64')}`;
    expect(() => decryptAccessToken(tampered, KEYS, CTX_A)).toThrow(AccessTokenDecryptError);
  });
});

describe('per-tenant key derivation', () => {
  it('derives different keys for different tenants', () => {
    expect(deriveTenantKey(MASTER_KEY, TENANT_A).equals(deriveTenantKey(MASTER_KEY, TENANT_B))).toBe(
      false,
    );
  });

  it('derives a 32-byte key', () => {
    expect(deriveTenantKey(MASTER_KEY, TENANT_A)).toHaveLength(32);
  });

  it('does not use MASTER_KEY as the AES key directly', () => {
    // A leaked derived key must not reveal MASTER_KEY, and the derived key must
    // not simply be a truncation of it (the pre-fix derivation).
    expect(deriveTenantKey(MASTER_KEY, TENANT_A).toString('utf8')).not.toContain(MASTER_KEY);
    expect(deriveTenantKey(MASTER_KEY, TENANT_A).subarray(0, 32).toString('utf8')).not.toBe(
      MASTER_KEY,
    );
  });
});

describe('rotation (key ids)', () => {
  const rotated = masterKeysFromConfig({
    masterKey: 'N'.repeat(32),
    masterKeyId: 'k2',
    previousMasterKey: MASTER_KEY,
    previousMasterKeyId: 'k1',
  });

  it('reads rows written with the previous key during a rotation', () => {
    const oldEnvelope = encryptAccessToken(TOKEN, KEYS, CTX_A);
    expect(decryptAccessToken(oldEnvelope, rotated, CTX_A)).toBe(TOKEN);
  });

  it('writes new rows with the current key id', () => {
    expect(encryptAccessToken(TOKEN, rotated, CTX_A).startsWith('v2.k2.')).toBe(true);
  });

  it('fails loudly when the key id is not configured', () => {
    const oldEnvelope = encryptAccessToken(TOKEN, KEYS, CTX_A);
    expect(() => decryptAccessToken(oldEnvelope, rotated, CTX_A)).not.toThrow();
    expect(() => decryptAccessToken(oldEnvelope, { current: rotated.current }, CTX_A)).toThrow(
      /No key configured for key id 'k1'/,
    );
  });

  it('rejects a malformed key id', () => {
    expect(() => masterKeysFromConfig({ masterKey: MASTER_KEY, masterKeyId: 'k 1!' })).toThrow(
      /MASTER_KEY_ID/,
    );
    expect(() =>
      masterKeysFromConfig({
        masterKey: MASTER_KEY,
        masterKeyId: 'k1',
        previousMasterKey: MASTER_KEY,
        previousMasterKeyId: 'k1',
      }),
    ).toThrow(/must differ/);
  });
});

describe('v1 compatibility', () => {
  /** Reproduces the pre-fix format: base64(iv||ct||tag), no AAD, key = first 32 bytes. */
  function encryptV1(plaintext: string, masterKey: string): string {
    const iv = randomBytes(12);
    const key = Buffer.from(masterKey, 'utf8').subarray(0, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
  }

  it('still decrypts ciphertext written before the upgrade', () => {
    const legacy = encryptV1(TOKEN, MASTER_KEY);
    expect(isEncryptedTokenV2(legacy)).toBe(false);
    expect(decryptAccessToken(legacy, KEYS, CTX_A)).toBe(TOKEN);
  });

  it('decrypts legacy ciphertext with the previous key after a rotation', () => {
    const legacy = encryptV1(TOKEN, MASTER_KEY);
    const rotated = masterKeysFromConfig({
      masterKey: 'N'.repeat(32),
      masterKeyId: 'k2',
      previousMasterKey: MASTER_KEY,
      previousMasterKeyId: 'k1',
    });
    expect(decryptAccessToken(legacy, rotated, CTX_A)).toBe(TOKEN);
  });
});

describe('malformed input', () => {
  it.each(['v2.', 'v2.k1', 'v2.k1.', 'v2.bad_kid!!.AAAA', 'AAAA'])(
    'rejects %p without leaking internals',
    (envelope) => {
      const attempt = (): string => decryptAccessToken(envelope, KEYS, CTX_A);
      if (envelope === 'AAAA') {
        // Not a v2 envelope: falls through to the legacy path and fails there.
        expect(attempt).toThrow(AccessTokenDecryptError);
        return;
      }
      expect(attempt).toThrow(AccessTokenDecryptError);
    },
  );
});
