/**
 * Domain models for the Meta WhatsApp onboarding chain.
 *
 * The chain is:
 *   Embedded Signup (FB JS SDK, config_id)
 *     -> OAuth `code`
 *       -> Access Token Exchange (client_id + client_secret + code)
 *         -> token debug (which WABAs does the token actually manage?)
 *           -> WABA ID + Phone Number ID (ownership proven, not asserted)
 *             -> webhook subscription (POST /{waba_id}/subscribed_apps)
 */

export interface MetaTokenInfo {
  accessToken: string;
  tokenType: string;
  /** Null means the token does not expire (system-user token). */
  expiresInSeconds: number | null;
}

export interface MetaTokenDebug {
  appId: string | null;
  isValid: boolean;
  scopes: string[];
  /**
   * scope -> target ids. `whatsapp_business_management` maps to the WABA ids
   * the token can administer; this is the ownership proof used to prevent
   * phone-number hijacking.
   */
  granularScopes: Record<string, string[]>;
  /** Unix seconds, or null when the token never expires. */
  expiresAt: number | null;
}

export interface MetaWaba {
  id: string;
  name: string | null;
}

export interface MetaPhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

/** Short-lived, single-use OAuth `state` bound to the initiating tenant/user. */
export interface MetaOAuthState {
  state: string;
  tenantId: string;
  userId: string;
  createdAt: string;
}

/** Everything the caller may ask Meta for at Embedded Signup completion. */
export interface CompleteOnboardingInput {
  code: string;
  state: string;
  /** Handed to the browser by the Embedded Signup postMessage event. */
  wabaId?: string;
  phoneNumberId?: string;
}

export interface MetaConnectionResult {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  webhookSubscribed: boolean;
}

export interface MetaConnectionStatus {
  connected: boolean;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  webhookSubscribed: boolean | null;
  /** Populated when the live Meta check failed; the tenant is still reported. */
  checkError: string | null;
}
