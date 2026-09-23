import type { MetaConnectionStatus } from '../../domain/models/MetaConnection.js';
import type { IMetaGraphClient } from '../../domain/ports/IMetaGraphClient.js';
import type { ITenantRepo } from '../../domain/ports/ITenantRepo.js';
import { NotFoundError } from '../../domain/errors.js';
import { decryptAccessToken, type MasterKeys } from './encryption.js';

/**
 * Reports the live health of a tenant's WhatsApp binding.
 *
 * Deliberately performs a real Meta call: a stored `waba_id` / `phone_number_id`
 * only proves that onboarding once succeeded. It does not prove the token is
 * still valid or that the webhook subscription is still in place, both of which
 * Meta can revoke independently.
 *
 * The decrypted access token is never returned to the caller.
 */
export class CheckMetaConnectionUseCase {
  constructor(
    private readonly tenantRepo: ITenantRepo,
    private readonly metaClient: IMetaGraphClient,
    private readonly masterKeys: MasterKeys,
    private readonly appId: string,
  ) {}

  async execute(tenantId: string): Promise<MetaConnectionStatus> {
    const tenant = await this.tenantRepo.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    if (!tenant.wabaId || !tenant.phoneNumberId || !tenant.accessToken) {
      return {
        connected: false,
        wabaId: tenant.wabaId,
        phoneNumberId: tenant.phoneNumberId,
        displayPhoneNumber: null,
        verifiedName: null,
        webhookSubscribed: null,
        checkError: null,
      };
    }

    const status: MetaConnectionStatus = {
      connected: true,
      wabaId: tenant.wabaId,
      phoneNumberId: tenant.phoneNumberId,
      displayPhoneNumber: null,
      verifiedName: null,
      webhookSubscribed: null,
      checkError: null,
    };

    try {
      const token = decryptAccessToken(tenant.accessToken, this.masterKeys, {
        tenantId,
        phoneNumberId: tenant.phoneNumberId,
      });

      const phone = await this.metaClient.getPhoneNumber(tenant.phoneNumberId, token);
      status.displayPhoneNumber = phone.displayPhoneNumber;
      status.verifiedName = phone.verifiedName;

      if (this.appId) {
        const subscribed = await this.metaClient.getSubscribedApps(tenant.wabaId, token);
        status.webhookSubscribed = subscribed.includes(this.appId);
      }
    } catch (err) {
      // Surface the failure without failing the request: the tenant still needs
      // to learn that it is connected-but-broken.
      status.checkError = err instanceof Error ? err.message : String(err);
    }

    return status;
  }
}
