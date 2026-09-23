import type {
  MetaPhoneNumber,
  MetaTokenDebug,
  MetaTokenInfo,
  MetaWaba,
} from '../models/MetaConnection.js';

/**
 * Port — the subset of the Meta Graph API needed to onboard a tenant.
 *
 * Implementations must:
 *  - never log or echo the access token,
 *  - bind the token into the request as a header, never a URL query string,
 *  - reject on non-2xx and surface Meta's error message/code.
 */
export interface IMetaGraphClient {
  /**
   * Exchange an Embedded Signup OAuth `code` for an access token.
   * This is the "Access Token Exchange" step of the onboarding chain.
   */
  exchangeCodeForToken(code: string): Promise<MetaTokenInfo>;

  /**
   * Inspect a token: app id, scopes and — critically — the granular scopes that
   * name the WABA ids the token may administer. Used as the ownership proof.
   */
  debugToken(inputToken: string): Promise<MetaTokenDebug>;

  /** WABAs visible to the given token. */
  listWabas(token: string): Promise<MetaWaba[]>;

  /** Phone numbers belonging to a WABA. */
  listPhoneNumbers(wabaId: string, token: string): Promise<MetaPhoneNumber[]>;

  /** A single phone number's public profile. */
  getPhoneNumber(phoneNumberId: string, token: string): Promise<MetaPhoneNumber>;

  /**
   * Subscribe this app to the WABA's webhooks. Without this call Meta never
   * delivers messages, so a connection is not usable until it succeeds.
   */
  subscribeAppToWaba(wabaId: string, token: string): Promise<void>;

  /** App ids currently subscribed to the WABA's webhooks. */
  getSubscribedApps(wabaId: string, token: string): Promise<string[]>;
}
