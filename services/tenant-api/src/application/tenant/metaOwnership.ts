import { MetaApiError, MetaOwnershipError } from '../../domain/errors.js';
import type { MetaPhoneNumber } from '../../domain/models/MetaConnection.js';
import type { IMetaGraphClient } from '../../domain/ports/IMetaGraphClient.js';

export interface OwnershipProof {
  wabaId: string;
  phoneNumberId: string;
  phoneNumber: MetaPhoneNumber;
}

export interface ProveOwnershipOptions {
  /** Require the token's granular WABA-management scope to name the WABA. */
  requireGranularScope: boolean;
  /**
   * When set, the token must have been issued by this Meta app. Guards against
   * a token minted by a different app being substituted into the flow.
   */
  expectedAppId?: string | null;
}

const WABA_MANAGEMENT_SCOPE = 'whatsapp_business_management';

/**
 * Prove that `token` really administers `wabaId` and owns `phoneNumberId`.
 *
 * This is the guard against phone-number hijacking (audit finding H2): the
 * onboarding API used to accept a caller-supplied `waba_id` / `phone_number_id`
 * pair and simply store it. Because `tenants.phone_number_id` is UNIQUE and the
 * gateway routes inbound messages by that id alone, whichever tenant claimed a
 * number first received that number's traffic — including a number belonging to
 * somebody else.
 *
 * Two independent checks are performed:
 *  1. `GET /{waba_id}/phone_numbers` must succeed AND contain `phoneNumberId`.
 *     Succeeding already proves the token can read that WABA's numbers.
 *  2. The token's granular `whatsapp_business_management` scope must list the
 *     WABA. Skipped only when `requireGranularScope` is false.
 */
export async function proveOwnership(
  meta: IMetaGraphClient,
  token: string,
  wabaId: string,
  phoneNumberId: string,
  options: ProveOwnershipOptions,
): Promise<OwnershipProof> {
  if (!wabaId || !phoneNumberId) {
    throw new MetaOwnershipError('Both waba_id and phone_number_id are required');
  }

  const debug = await meta.debugToken(token);
  if (!debug.isValid) {
    throw new MetaOwnershipError('The supplied Meta access token is not valid');
  }

  if (options.expectedAppId && debug.appId && debug.appId !== options.expectedAppId) {
    throw new MetaOwnershipError(
      'The access token was not issued by this application',
    );
  }

  if (options.requireGranularScope) {
    const granted = debug.granularScopes[WABA_MANAGEMENT_SCOPE] ?? [];
    if (granted.length === 0) {
      throw new MetaOwnershipError(
        'The access token does not carry a whatsapp_business_management scope, ' +
          'so ownership of the WhatsApp Business Account cannot be verified. ' +
          'Re-run Embedded Signup and grant the WhatsApp Business Management permission.',
      );
    }
    if (!granted.includes(wabaId)) {
      throw new MetaOwnershipError(
        `The access token does not manage WhatsApp Business Account ${wabaId}`,
      );
    }
  }

  let phoneNumbers: MetaPhoneNumber[];
  try {
    phoneNumbers = await meta.listPhoneNumbers(wabaId, token);
  } catch (err) {
    // A 4xx here means the token cannot read the WABA at all.
    if (err instanceof MetaApiError) {
      throw new MetaOwnershipError(
        `The access token cannot read phone numbers for WhatsApp Business Account ${wabaId}`,
      );
    }
    throw err;
  }

  const match = phoneNumbers.find((number) => number.id === phoneNumberId);
  if (!match) {
    throw new MetaOwnershipError(
      `Phone number ${phoneNumberId} does not belong to WhatsApp Business Account ${wabaId}`,
    );
  }

  return { wabaId, phoneNumberId, phoneNumber: match };
}
