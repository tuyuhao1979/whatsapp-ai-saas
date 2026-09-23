import type { Tenant } from '../../src/domain/models/Tenant.js';
import type {
  MetaPhoneNumber,
  MetaTokenDebug,
} from '../../src/domain/models/MetaConnection.js';
import type { IMetaGraphClient } from '../../src/domain/ports/IMetaGraphClient.js';
import type { ITenantRepo } from '../../src/domain/ports/ITenantRepo.js';
import { proveOwnership } from '../../src/application/tenant/metaOwnership.js';
import { ConnectWhatsAppUseCase } from '../../src/application/tenant/ConnectWhatsAppUseCase.js';
import { CompleteMetaOnboardingUseCase } from '../../src/application/tenant/CompleteMetaOnboardingUseCase.js';
import type { IOAuthStateStore } from '../../src/domain/ports/IOAuthStateStore.js';
import {
  ConflictError,
  MetaApiError,
  MetaOwnershipError,
  OAuthStateError,
} from '../../src/domain/errors.js';
import { masterKeysFromConfig } from '../../src/application/tenant/encryption.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const MASTER_KEY = 'k'.repeat(32);
const MASTER_KEYS = masterKeysFromConfig({ masterKey: MASTER_KEY, masterKeyId: 'k1' });

const PHONE: MetaPhoneNumber = {
  id: 'pn-1',
  displayPhoneNumber: '+1 555 0100',
  verifiedName: 'Acme',
  qualityRating: 'GREEN',
};

function fakeMeta(overrides: Partial<IMetaGraphClient> = {}): IMetaGraphClient {
  const debug: MetaTokenDebug = {
    appId: 'app-123',
    isValid: true,
    scopes: ['whatsapp_business_management'],
    granularScopes: { whatsapp_business_management: ['waba-1'] },
    expiresAt: null,
  };
  return {
    exchangeCodeForToken: jest.fn().mockResolvedValue({
      accessToken: 'tok',
      tokenType: 'bearer',
      expiresInSeconds: null,
    }),
    debugToken: jest.fn().mockResolvedValue(debug),
    listWabas: jest.fn().mockResolvedValue([{ id: 'waba-1', name: 'Acme' }]),
    listPhoneNumbers: jest.fn().mockResolvedValue([PHONE]),
    getPhoneNumber: jest.fn().mockResolvedValue(PHONE),
    subscribeAppToWaba: jest.fn().mockResolvedValue(undefined),
    getSubscribedApps: jest.fn().mockResolvedValue(['app-123']),
    ...overrides,
  };
}

function fakeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ID,
    name: 'Acme',
    slug: 'acme',
    wabaId: null,
    phoneNumberId: null,
    accessToken: null,
    plan: 'free',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeTenantRepo(overrides: Partial<ITenantRepo> = {}): ITenantRepo {
  return {
    findById: jest.fn().mockResolvedValue(fakeTenant()),
    findBySlug: jest.fn().mockResolvedValue(null),
    findByPhoneNumberId: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue(fakeTenant()),
    ...overrides,
  };
}

describe('proveOwnership (audit finding H2)', () => {
  const opts = { requireGranularScope: true, expectedAppId: 'app-123' };

  it('accepts a token that manages the WABA and lists the phone number', async () => {
    const proof = await proveOwnership(
      fakeMeta(),
      'tok',
      'waba-1',
      'pn-1',
      opts,
    );
    expect(proof.phoneNumberId).toBe('pn-1');
  });

  it('rejects an invalid token', async () => {
    const meta = fakeMeta({
      debugToken: jest.fn().mockResolvedValue({
        appId: 'app-123',
        isValid: false,
        scopes: [],
        granularScopes: {},
        expiresAt: null,
      }),
    });
    await expect(proveOwnership(meta, 'tok', 'waba-1', 'pn-1', opts)).rejects.toThrow(
      MetaOwnershipError,
    );
    // Must not even attempt to read the WABA.
    expect(meta.listPhoneNumbers).not.toHaveBeenCalled();
  });

  it('rejects a token issued by a different app', async () => {
    const meta = fakeMeta({
      debugToken: jest.fn().mockResolvedValue({
        appId: 'attacker-app',
        isValid: true,
        scopes: [],
        granularScopes: { whatsapp_business_management: ['waba-1'] },
        expiresAt: null,
      }),
    });
    await expect(proveOwnership(meta, 'tok', 'waba-1', 'pn-1', opts)).rejects.toThrow(
      /not issued by this application/,
    );
  });

  it('rejects a WABA the token does not manage', async () => {
    await expect(
      proveOwnership(fakeMeta(), 'tok', 'someone-elses-waba', 'pn-1', opts),
    ).rejects.toThrow(/does not manage WhatsApp Business Account/);
  });

  it('rejects when the token carries no granular scope at all', async () => {
    const meta = fakeMeta({
      debugToken: jest.fn().mockResolvedValue({
        appId: 'app-123',
        isValid: true,
        scopes: [],
        granularScopes: {},
        expiresAt: null,
      }),
    });
    await expect(proveOwnership(meta, 'tok', 'waba-1', 'pn-1', opts)).rejects.toThrow(
      MetaOwnershipError,
    );
  });

  it('rejects a phone number that is not in the WABA', async () => {
    const meta = fakeMeta({
      listPhoneNumbers: jest.fn().mockResolvedValue([
        { ...PHONE, id: 'pn-other' },
      ]),
    });
    await expect(proveOwnership(meta, 'tok', 'waba-1', 'pn-1', opts)).rejects.toThrow(
      /does not belong to WhatsApp Business Account/,
    );
  });

  it('converts an unreadable WABA into an ownership failure, not a 500', async () => {
    const meta = fakeMeta({
      listPhoneNumbers: jest
        .fn()
        .mockRejectedValue(new MetaApiError('Meta Graph returned HTTP 403', 403)),
    });
    await expect(proveOwnership(meta, 'tok', 'waba-1', 'pn-1', opts)).rejects.toThrow(
      MetaOwnershipError,
    );
  });

  it('lets a transient upstream failure propagate instead of mislabelling it as an ownership problem', async () => {
    const meta = fakeMeta({
      listPhoneNumbers: jest.fn().mockRejectedValue(new Error('socket hang up')),
    });
    await expect(proveOwnership(meta, 'tok', 'waba-1', 'pn-1', opts)).rejects.toThrow(
      'socket hang up',
    );
  });
});

describe('ConnectWhatsAppUseCase', () => {
  function build(repoOverrides: Partial<ITenantRepo> = {}, meta = fakeMeta()) {
    const repo = fakeTenantRepo(repoOverrides);
    const useCase = new ConnectWhatsAppUseCase(repo, meta, { masterKeys: MASTER_KEYS });
    return { repo, meta, useCase };
  }

  it('subscribes the webhook and stores the token encrypted, never in plaintext', async () => {
    const { repo, meta, useCase } = build();

    const result = await useCase.execute(TENANT_ID, {
      wabaId: 'waba-1',
      phoneNumberId: 'pn-1',
      accessToken: 'long-lived-token',
    });

    expect(meta.subscribeAppToWaba).toHaveBeenCalledWith('waba-1', 'long-lived-token');
    expect(result.webhookSubscribed).toBe(true);
    expect(result.displayPhoneNumber).toBe('+1 555 0100');

    const [, update] = (repo.update as jest.Mock).mock.calls[0]!;
    expect(update.accessToken).not.toBe('long-lived-token');
    expect(update.accessToken.length).toBeGreaterThan(0);
  });

  it('refuses a phone number already claimed by another tenant', async () => {
    const { useCase, meta } = build({
      findByPhoneNumberId: jest
        .fn()
        .mockResolvedValue(fakeTenant({ id: OTHER_TENANT_ID, phoneNumberId: 'pn-1' })),
    });

    await expect(
      useCase.execute(TENANT_ID, {
        wabaId: 'waba-1',
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
      }),
    ).rejects.toThrow(ConflictError);

    // Must not take over the binding before refusing.
    expect(meta.subscribeAppToWaba).not.toHaveBeenCalled();
  });

  it('allows re-connecting a number the same tenant already holds', async () => {
    const { useCase } = build({
      findByPhoneNumberId: jest
        .fn()
        .mockResolvedValue(fakeTenant({ id: TENANT_ID, phoneNumberId: 'pn-1' })),
    });

    await expect(
      useCase.execute(TENANT_ID, {
        wabaId: 'waba-1',
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
      }),
    ).resolves.toMatchObject({ phoneNumberId: 'pn-1' });
  });
});

describe('CompleteMetaOnboardingUseCase', () => {
  function build(stateStore: IOAuthStateStore, meta = fakeMeta()) {
    const connect = new ConnectWhatsAppUseCase(fakeTenantRepo(), meta, {
      masterKeys: MASTER_KEYS,
    });
    return new CompleteMetaOnboardingUseCase(stateStore, meta, connect);
  }

  function store(overrides: Partial<IOAuthStateStore> = {}): IOAuthStateStore {
    return {
      issue: jest.fn(),
      consume: jest.fn().mockResolvedValue({
        state: 's',
        tenantId: TENANT_ID,
        userId: 'u1',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      ...overrides,
    };
  }

  it('rejects an unknown or already-consumed state', async () => {
    const useCase = build(store({ consume: jest.fn().mockResolvedValue(null) }));
    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: 'c', state: 'replayed' }),
    ).rejects.toThrow(OAuthStateError);
  });

  it('rejects a state issued to a different tenant', async () => {
    const useCase = build(
      store({
        consume: jest.fn().mockResolvedValue({
          state: 's',
          tenantId: OTHER_TENANT_ID,
          userId: 'u1',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      }),
    );
    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: 'c', state: 's' }),
    ).rejects.toThrow(/different account/);
  });

  it('exchanges the code and discovers the WABA and phone number', async () => {
    const meta = fakeMeta();
    const useCase = build(store(), meta);

    const result = await useCase.execute({ tenantId: TENANT_ID, code: 'c', state: 's' });

    expect(meta.exchangeCodeForToken).toHaveBeenCalledWith('c');
    expect(meta.listWabas).toHaveBeenCalled();
    expect(result.wabaId).toBe('waba-1');
    expect(result.phoneNumberId).toBe('pn-1');
  });

  it('accepts the browser-supplied identifiers as a narrowing hint', async () => {
    const meta = fakeMeta();
    const useCase = build(store(), meta);

    const result = await useCase.execute({
      tenantId: TENANT_ID,
      code: 'c',
      state: 's',
      wabaId: 'waba-1',
      phoneNumberId: 'pn-1',
    });

    // Hinted ids skip discovery, but ownership is still proven downstream.
    expect(meta.listWabas).not.toHaveBeenCalled();
    expect(meta.listPhoneNumbers).toHaveBeenCalled();
    expect(result.phoneNumberId).toBe('pn-1');
  });

  it('refuses to guess when the token exposes several WABAs', async () => {
    const meta = fakeMeta({
      listWabas: jest.fn().mockResolvedValue([
        { id: 'waba-1', name: 'A' },
        { id: 'waba-2', name: 'B' },
      ]),
    });
    const useCase = build(store(), meta);
    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: 'c', state: 's' }),
    ).rejects.toThrow(/specify waba_id explicitly/);
  });
});
