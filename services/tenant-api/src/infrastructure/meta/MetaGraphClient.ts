import { MetaApiError } from '../../domain/errors.js';
import type {
  MetaPhoneNumber,
  MetaTokenDebug,
  MetaTokenInfo,
  MetaWaba,
} from '../../domain/models/MetaConnection.js';
import type { IMetaGraphClient } from '../../domain/ports/IMetaGraphClient.js';

export interface MetaGraphClientOptions {
  baseUrl: string;
  appId: string;
  appSecret: string;
  timeoutMs?: number;
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; type?: string };
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  token?: string;
  query?: Record<string, string>;
  form?: Record<string, string>;
}

/**
 * Meta Graph API adapter.
 *
 * Secrets and access tokens are sent in the request *body* or as an
 * Authorization header — never as URL query parameters — so they cannot leak
 * into access logs, proxies, or error traces. Meta's own error text is
 * surfaced verbatim as a MetaApiError.
 */
export class MetaGraphClient implements IMetaGraphClient {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly timeoutMs: number;

  constructor(options: MetaGraphClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  // -------------------------------------------------------------------
  // Onboarding chain
  // -------------------------------------------------------------------

  async exchangeCodeForToken(code: string): Promise<MetaTokenInfo> {
    const body = await this.request<{
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    }>('/oauth/access_token', {
      method: 'POST',
      form: {
        client_id: this.appId,
        client_secret: this.appSecret,
        code,
      },
    });

    if (!body.access_token) {
      throw new MetaApiError('Meta did not return an access token for the code');
    }

    return {
      accessToken: body.access_token,
      tokenType: body.token_type ?? 'bearer',
      expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : null,
    };
  }

  async debugToken(inputToken: string): Promise<MetaTokenDebug> {
    // input_token must be supplied by the caller; the app token authenticates
    // the call. Both go in the body so neither lands in a URL.
    const body = await this.request<{
      data?: {
        app_id?: string;
        is_valid?: boolean;
        scopes?: string[];
        granular_scopes?: Array<{ scope?: string; target_ids?: string[] }>;
        expires_at?: number;
      };
    }>('/debug_token', {
      method: 'POST',
      form: {
        input_token: inputToken,
        access_token: `${this.appId}|${this.appSecret}`,
      },
    });

    const data = body.data ?? {};
    const granularScopes: Record<string, string[]> = {};
    for (const entry of data.granular_scopes ?? []) {
      if (entry?.scope) {
        granularScopes[entry.scope] = entry.target_ids ?? [];
      }
    }

    return {
      appId: data.app_id ?? null,
      isValid: data.is_valid === true,
      scopes: data.scopes ?? [],
      granularScopes,
      expiresAt: typeof data.expires_at === 'number' ? data.expires_at : null,
    };
  }

  async listWabas(token: string): Promise<MetaWaba[]> {
    const debug = await this.debugToken(token);
    const ids = new Set<string>();
    for (const targetIds of Object.values(debug.granularScopes)) {
      for (const id of targetIds) ids.add(id);
    }

    const wabas: MetaWaba[] = [];
    for (const id of ids) {
      try {
        const info = await this.request<{ id?: string; name?: string }>(`/${id}`, {
          token,
          query: { fields: 'id,name' },
        });
        wabas.push({ id: info.id ?? id, name: info.name ?? null });
      } catch {
        // A target id may not be a WABA (e.g. a page id). Skip it rather than
        // failing the whole listing.
        continue;
      }
    }
    return wabas;
  }

  async listPhoneNumbers(wabaId: string, token: string): Promise<MetaPhoneNumber[]> {
    const body = await this.request<{ data?: Array<Record<string, unknown>> }>(
      `/${wabaId}/phone_numbers`,
      {
        token,
        query: { fields: 'id,display_phone_number,verified_name,quality_rating' },
      },
    );
    return (body.data ?? []).map(mapPhoneNumber);
  }

  async getPhoneNumber(phoneNumberId: string, token: string): Promise<MetaPhoneNumber> {
    const body = await this.request<Record<string, unknown>>(`/${phoneNumberId}`, {
      token,
      query: { fields: 'id,display_phone_number,verified_name,quality_rating' },
    });
    return mapPhoneNumber(body);
  }

  async subscribeAppToWaba(wabaId: string, token: string): Promise<void> {
    const body = await this.request<{ success?: boolean }>(`/${wabaId}/subscribed_apps`, {
      method: 'POST',
      token,
    });
    if (body.success === false) {
      throw new MetaApiError(`Meta refused the webhook subscription for WABA ${wabaId}`);
    }
  }

  async getSubscribedApps(wabaId: string, token: string): Promise<string[]> {
    const body = await this.request<{ data?: Array<Record<string, unknown>> }>(
      `/${wabaId}/subscribed_apps`,
      { token },
    );
    return (body.data ?? [])
      .map((entry) => {
        const apiData = entry['whatsapp_business_api_data'] as
          | { id?: string }
          | undefined;
        return apiData?.id;
      })
      .filter((id): id is string => typeof id === 'string');
  }

  // -------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', token, query, form } = options;

    let url = `${this.baseUrl}${path}`;
    if (query && Object.keys(query).length > 0) {
      url += `?${new URLSearchParams(query).toString()}`;
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let payload: string | undefined;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MetaApiError(`Meta Graph request failed: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const graphError = (parsed as GraphErrorBody | undefined)?.error;
      throw new MetaApiError(
        graphError?.message ?? `Meta Graph returned HTTP ${response.status}`,
        response.status,
      );
    }

    return (parsed ?? {}) as T;
  }
}

function mapPhoneNumber(row: Record<string, unknown>): MetaPhoneNumber {
  const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  return {
    id: asString(row['id']) ?? '',
    displayPhoneNumber: asString(row['display_phone_number']),
    verifiedName: asString(row['verified_name']),
    qualityRating: asString(row['quality_rating']),
  };
}
