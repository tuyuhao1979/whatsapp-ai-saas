import type { MetaOAuthState } from '../../domain/models/MetaConnection.js';
import type { IOAuthStateStore } from '../../domain/ports/IOAuthStateStore.js';

export interface StartMetaOnboardingInput {
  tenantId: string;
  userId: string;
}

export interface StartMetaOnboardingResult {
  state: string;
  appId: string;
  configId: string;
  redirectUri: string;
  /** Seconds the state remains valid; the client should complete within this. */
  stateTtlSeconds: number;
}

/**
 * Step 1 of the Embedded Signup chain.
 *
 * Issues a single-use OAuth `state` bound to the authenticated tenant + user,
 * then hands the frontend everything it needs to launch the Facebook JS SDK
 * `FB.login({ config_id })` popup.
 *
 * The state is what prevents an attacker from completing signup on behalf of a
 * tenant they do not control: `complete` requires the state to have been issued
 * to the same tenant that is now finishing the flow.
 *
 * App id / config id come from deployment configuration, never from the caller.
 */
export class StartMetaOnboardingUseCase {
  constructor(
    private readonly stateStore: IOAuthStateStore,
    private readonly embeddedSignupConfig: {
      appId: string;
      configId: string;
      redirectUri: string;
      stateTtlSeconds: number;
    },
  ) {}

  async execute(input: StartMetaOnboardingInput): Promise<StartMetaOnboardingResult> {
    const record: MetaOAuthState = await this.stateStore.issue(
      input.tenantId,
      input.userId,
    );

    return {
      state: record.state,
      appId: this.embeddedSignupConfig.appId,
      configId: this.embeddedSignupConfig.configId,
      redirectUri: this.embeddedSignupConfig.redirectUri,
      stateTtlSeconds: this.embeddedSignupConfig.stateTtlSeconds,
    };
  }
}
