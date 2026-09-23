import { MetaGraphClient } from '../../src/infrastructure/meta/MetaGraphClient.js';
import { MetaApiError } from '../../src/domain/errors.js';

const OPTS = {
  baseUrl: 'https://graph.facebook.com/v21.0',
  appId: 'app-123',
  appSecret: 'app-secret',
  timeoutMs: 1000,
};

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responses: Array<{ status: number; body: unknown }>,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  let index = 0;
  global.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const spec = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const status = spec?.status ?? 200;
    const body = spec?.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('MetaGraphClient — access token exchange', () => {
  it('sends client_id, client_secret and code in the request BODY, never the URL', async () => {
    const calls = mockFetch([
      { status: 200, body: { access_token: 'tok', token_type: 'bearer', expires_in: 3600 } },
    ]);

    const client = new MetaGraphClient(OPTS);
    const info = await client.exchangeCodeForToken('the-code');

    expect(info.accessToken).toBe('tok');
    expect(info.expiresInSeconds).toBe(3600);

    const call = calls[0]!;
    // The app secret must never appear in a URL (logs, proxies, referrers).
    expect(call.url).not.toContain('app-secret');
    expect(call.url).not.toContain('the-code');
    expect(String(call.init.body)).toContain('client_secret=app-secret');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('raises MetaApiError when Meta omits the access token', async () => {
    mockFetch([{ status: 200, body: {} }]);
    await expect(new MetaGraphClient(OPTS).exchangeCodeForToken('c')).rejects.toThrow(
      MetaApiError,
    );
  });
});

describe('MetaGraphClient — token debug', () => {
  it('flattens granular_scopes into scope -> target ids', async () => {
    mockFetch([
      {
        status: 200,
        body: {
          data: {
            app_id: 'app-123',
            is_valid: true,
            scopes: ['whatsapp_business_management'],
            granular_scopes: [
              { scope: 'whatsapp_business_management', target_ids: ['waba-1', 'waba-2'] },
            ],
            expires_at: 1893456000,
          },
        },
      },
    ]);

    const debug = await new MetaGraphClient(OPTS).debugToken('user-token');

    expect(debug.isValid).toBe(true);
    expect(debug.appId).toBe('app-123');
    expect(debug.granularScopes['whatsapp_business_management']).toEqual([
      'waba-1',
      'waba-2',
    ]);
  });

  it('keeps the token being debugged out of the URL', async () => {
    const calls = mockFetch([{ status: 200, body: { data: { is_valid: true } } }]);
    await new MetaGraphClient(OPTS).debugToken('secret-user-token');

    expect(calls[0]!.url).not.toContain('secret-user-token');
    expect(String(calls[0]!.init.body)).toContain('input_token=secret-user-token');
  });
});

describe('MetaGraphClient — webhook subscription', () => {
  it('POSTs to /{waba}/subscribed_apps with the token as a bearer header', async () => {
    const calls = mockFetch([{ status: 200, body: { success: true } }]);
    await new MetaGraphClient(OPTS).subscribeAppToWaba('waba-1', 'tok');

    const call = calls[0]!;
    expect(call.url).toBe('https://graph.facebook.com/v21.0/waba-1/subscribed_apps');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(call.url).not.toContain('tok');
  });

  it('treats success:false as a failure', async () => {
    mockFetch([{ status: 200, body: { success: false } }]);
    await expect(
      new MetaGraphClient(OPTS).subscribeAppToWaba('waba-1', 'tok'),
    ).rejects.toThrow(MetaApiError);
  });
});

describe('MetaGraphClient — error surfacing', () => {
  it('surfaces Meta error text and status instead of a bare HTTP failure', async () => {
    mockFetch([
      {
        status: 401,
        body: { error: { message: 'Invalid OAuth access token', code: 190 } },
      },
    ]);

    await expect(
      new MetaGraphClient(OPTS).getPhoneNumber('pn-1', 'bad-token'),
    ).rejects.toThrow('Invalid OAuth access token');
  });
});

describe('MetaGraphClient — phone numbers', () => {
  it('maps the phone number profile fields', async () => {
    mockFetch([
      {
        status: 200,
        body: {
          data: [
            {
              id: 'pn-1',
              display_phone_number: '+1 555 0100',
              verified_name: 'Acme',
              quality_rating: 'GREEN',
            },
          ],
        },
      },
    ]);

    const numbers = await new MetaGraphClient(OPTS).listPhoneNumbers('waba-1', 'tok');
    expect(numbers).toEqual([
      {
        id: 'pn-1',
        displayPhoneNumber: '+1 555 0100',
        verifiedName: 'Acme',
        qualityRating: 'GREEN',
      },
    ]);
  });
});
