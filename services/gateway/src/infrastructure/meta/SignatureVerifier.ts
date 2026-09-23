import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignatureVerificationError } from '../../domain/errors.js';

export const SHA256_PREFIX = 'sha256=';

/**
 * Verifies the HMAC-SHA256 signature sent by Meta in X-Hub-Signature-256.
 *
 * SECURITY REQUIREMENTS:
 * - Must operate on raw body BYTES, not the parsed JSON string, to avoid
 *   canonicalization inconsistencies.
 * - Must use crypto.timingSafeEqual to prevent timing-oracle attacks. String
 *   equality (===) leaks timing information proportional to common prefix length.
 * - Throws SignatureVerificationError on any mismatch — never returns false.
 */
export class SignatureVerifier {
  private readonly appSecret: string;

  constructor(appSecret: string) {
    if (!appSecret) {
      throw new Error('SignatureVerifier requires a non-empty APP_SECRET');
    }
    this.appSecret = appSecret;
  }

  /**
   * @param rawBody - The raw request body as a Buffer (before JSON.parse).
   * @param signatureHeader - The full value of X-Hub-Signature-256, e.g. "sha256=abc123...".
   * @throws SignatureVerificationError if the signature is invalid or malformed.
   */
  verify(rawBody: Buffer, signatureHeader: string | undefined): void {
    if (!signatureHeader || !signatureHeader.startsWith(SHA256_PREFIX)) {
      throw new SignatureVerificationError(
        'Missing or malformed X-Hub-Signature-256 header',
      );
    }

    const receivedHex = signatureHeader.slice(SHA256_PREFIX.length);
    const expectedHex = createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');

    // Both buffers must be the same length for timingSafeEqual to work.
    // If lengths differ (hex string length mismatch) an attacker can learn
    // that the signature has a different length — still throw but without
    // calling timingSafeEqual on mismatched lengths to avoid the RangeError.
    const receivedBuf = Buffer.from(receivedHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');

    const isValid =
      receivedBuf.length === expectedBuf.length &&
      timingSafeEqual(receivedBuf, expectedBuf);

    if (!isValid) {
      throw new SignatureVerificationError('X-Hub-Signature-256 mismatch');
    }
  }
}
