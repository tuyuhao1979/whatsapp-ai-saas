import { OAuthStateError, ValidationError } from '../../domain/errors.js';
import type { CompleteOnboardingInput, MetaConnectionResult } from '../../domain/models/MetaConnection.js';
import type { IMetaGraphClient } from '../../domain/ports/IMetaGraphClient.js';
import type { IOAuthStateStore } from '../../domain/ports/IOAuthStateStore.js';
import type { ConnectWhatsAppUseCase } from './ConnectWhatsAppUseCase.js';

export interface CompleteMetaOnboardingInput extends CompleteOnboardingInput {
  /** Tenant from the authenticated session — never from the request body. */
  tenantId: string;
}

/**
 * Step 2-5 of the Embedded Signup chain:
 *
 *   OAuth code -> Access Token Exchange -> WABA ID -> Phone Number ID
 *   -> ownership proof -> webhook subscription -> encrypted persistence
 *
 * Security notes:
 *  - The OAuth `state` is consumed atomically and must have been issued to the
 *    *same* tenant now completing the flow, so an attacker cannot inject their
 *    own WABA into a victim's tenant.
 *  - The state is single-use, so a replayed `complete` call fails. If the token
 *    exchange fails after the state is consumed the operator must restart the
 *    flow; that trade-off is deliberate (a reusable state is a replay surface).
 *  - WABA and phone number are discovered from Meta rather than trusted from
 *    the request; body values are only accepted as a narrowing hint and are
 *    still verified against the token.
 */
export class CompleteMetaOnboardingUseCase {
  constructor(
    private readonly stateStore: IOAuthStateStore,
    private readonly metaClient: IMetaGraphClient,
    private readonly connectWhatsApp: ConnectWhatsAppUseCase,
  ) {}

  async execute(input: CompleteMetaOnboardingInput): Promise<MetaConnectionResult> {
    // 1. Validate + atomically consume the CSRF state.
    const stateRecord = await this.stateStore.consume(input.state);
    if (!stateRecord) {
      throw new OAuthStateError();
    }
    if (stateRecord.tenantId !== input.tenantId) {
      throw new OAuthStateError('OAuth state was issued to a different account');
    }

    // 2. Access Token Exchange.
    const token = await this.metaClient.exchangeCodeForToken(input.code);

    // 3. Resolve the WABA.
    const wabaId = await this.resolveWabaId(input.wabaId, token.accessToken);

    // 4. Resolve the phone number within that WABA.
    const phoneNumberId = await this.resolvePhoneNumberId(
      input.phoneNumberId,
      wabaId,
      token.accessToken,
    );

    // 5. Prove ownership, refuse a number another tenant holds, subscribe the
    //    webhook, and persist the encrypted token — all in one place.
    return this.connectWhatsApp.execute(input.tenantId, {
      wabaId,
      phoneNumberId,
      accessToken: token.accessToken,
    });
  }

  private async resolveWabaId(
    hinted: string | undefined,
    token: string,
  ): Promise<string> {
    if (hinted) return hinted;

    const wabas = await this.metaClient.listWabas(token);
    if (wabas.length === 1 && wabas[0]) return wabas[0].id;
    if (wabas.length === 0) {
      throw new ValidationError(
        'The authorised token does not expose any WhatsApp Business Account',
      );
    }
    throw new ValidationError(
      `The authorised token exposes ${wabas.length} WhatsApp Business Accounts; ` +
        'specify waba_id explicitly',
    );
  }

  private async resolvePhoneNumberId(
    hinted: string | undefined,
    wabaId: string,
    token: string,
  ): Promise<string> {
    if (hinted) return hinted;

    const numbers = await this.metaClient.listPhoneNumbers(wabaId, token);
    if (numbers.length === 1 && numbers[0]) return numbers[0].id;
    if (numbers.length === 0) {
      throw new ValidationError(
        `WhatsApp Business Account ${wabaId} has no phone numbers`,
      );
    }
    throw new ValidationError(
      `WhatsApp Business Account ${wabaId} has ${numbers.length} phone numbers; ` +
        'specify phone_number_id explicitly',
    );
  }
}
