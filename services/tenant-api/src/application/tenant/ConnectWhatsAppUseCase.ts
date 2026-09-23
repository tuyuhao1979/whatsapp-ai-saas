import { ConflictError, NotFoundError } from '../../domain/errors.js';
import type { MetaConnectionResult } from '../../domain/models/MetaConnection.js';
import type { IMetaGraphClient } from '../../domain/ports/IMetaGraphClient.js';
import type { ITenantRepo } from '../../domain/ports/ITenantRepo.js';
import { encrypt } from './encryption.js';
import { proveOwnership } from './metaOwnership.js';

export interface ConnectWhatsAppInput {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  /**
   * Whether to require the token's granular whatsapp_business_management scope
   * to name the WABA. Defaults to the constructor setting; only a trusted
   * operator backfill should turn it off.
   */
  requireOwnershipProof?: boolean;
}

export interface ConnectWhatsAppOptions {
  masterKey: string;
  requireOwnershipProof?: boolean;
  /** Meta app id the token must belong to, when known. */
  expectedAppId?: string | null;
}

/**
 * The single writer for a tenant's WhatsApp binding.
 *
 * Both entry points — the manual "paste a token" path and the Embedded Signup
 * completion — funnel through here so ownership verification and webhook
 * subscription can never be skipped by choosing one path over the other.
 *
 * Previously this use case encrypted whatever token it was handed and stored
 * whatever waba_id / phone_number_id the caller supplied, with no check against
 * Meta at all (audit finding H2: a tenant could claim another business's phone
 * number and thereafter receive its customers' messages).
 */
export class ConnectWhatsAppUseCase {
  private readonly masterKey: string;
  private readonly requireOwnershipProof: boolean;
  private readonly expectedAppId: string | null;

  constructor(
    private readonly tenantRepo: ITenantRepo,
    private readonly metaClient: IMetaGraphClient,
    options: ConnectWhatsAppOptions,
  ) {
    this.masterKey = options.masterKey;
    this.requireOwnershipProof = options.requireOwnershipProof ?? true;
    this.expectedAppId = options.expectedAppId ?? null;
  }

  async execute(
    tenantId: string,
    input: ConnectWhatsAppInput,
  ): Promise<MetaConnectionResult> {
    const tenant = await this.tenantRepo.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const requireProof = input.requireOwnershipProof ?? this.requireOwnershipProof;

    // 1. Prove the token actually controls this WABA and this phone number.
    const proof = await proveOwnership(
      this.metaClient,
      input.accessToken,
      input.wabaId,
      input.phoneNumberId,
      { requireGranularScope: requireProof, expectedAppId: this.expectedAppId },
    );

    // 2. Refuse to take a number another tenant already holds. The DB has a
    //    UNIQUE constraint, but checking first yields a clear 409 instead of a
    //    raw constraint violation surfacing as a 500.
    const existing = await this.tenantRepo.findByPhoneNumberId(input.phoneNumberId);
    if (existing && existing.id !== tenantId) {
      throw new ConflictError(
        `Phone number ${input.phoneNumberId} is already connected to another account`,
      );
    }

    // 3. Subscribe this app to the WABA's webhooks. Without this Meta never
    //    delivers messages, so the binding would look successful but be dead.
    await this.metaClient.subscribeAppToWaba(input.wabaId, input.accessToken);

    // 4. Encrypt at rest and persist.
    const encryptedToken = encrypt(input.accessToken, this.masterKey);
    await this.tenantRepo.update(tenantId, {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      accessToken: encryptedToken,
    });

    return {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: proof.phoneNumber.displayPhoneNumber,
      verifiedName: proof.phoneNumber.verifiedName,
      webhookSubscribed: true,
    };
  }
}
