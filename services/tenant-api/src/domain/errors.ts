// ---------------------------------------------------------------------------
// Domain errors — typed, not generic Error subclasses
// ---------------------------------------------------------------------------

export class DomainError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} '${id}' not found` : `${resource} not found`, 'NOT_FOUND');
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}

export class ValidationError extends DomainError {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message, 'VALIDATION_ERROR');
    this.details = details;
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN');
  }
}

export class QuotaExceededError extends DomainError {
  constructor(resource: string, limit: number) {
    super(`Quota exceeded: maximum ${limit} ${resource} allowed`, 'QUOTA_EXCEEDED');
  }
}

export class ExternalServiceError extends DomainError {
  constructor(service: string, message: string) {
    super(`External service error (${service}): ${message}`, 'EXTERNAL_SERVICE_ERROR');
  }
}

/**
 * A non-2xx response from the Meta Graph API.
 *
 * The message carries Meta's own error text (which is safe — it never contains
 * the access token, because the token is sent as a bearer header).
 */
export class MetaApiError extends DomainError {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message, 'META_API_ERROR');
    this.status = status;
  }
}

/**
 * The supplied token cannot prove ownership of the WABA / phone number being
 * claimed. Raised instead of silently trusting caller-supplied identifiers
 * (audit finding H2: phone-number hijacking).
 */
export class MetaOwnershipError extends DomainError {
  constructor(message: string) {
    super(message, 'META_OWNERSHIP_UNVERIFIED');
  }
}

/** The OAuth `state` was missing, unknown, expired, or already used. */
export class OAuthStateError extends DomainError {
  constructor(message = 'Invalid, expired, or already-used OAuth state') {
    super(message, 'OAUTH_STATE_INVALID');
  }
}
