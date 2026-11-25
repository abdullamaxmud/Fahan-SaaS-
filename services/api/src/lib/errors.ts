export interface ErrorDetail {
  path?: string;
  message: string;
}

/** Business error rendered as the spec §8.3 envelope. Internal details never reach the browser. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: ErrorDetail[] = [],
  ) {
    super(message);
  }
}

export const Errors = {
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue'),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect'),
  mfaRequired: () => new AppError(401, 'MFA_REQUIRED', 'Complete multi-factor verification to continue'),
  reauthRequired: () => new AppError(401, 'REAUTH_REQUIRED', 'Confirm your authenticator code to make this change'),
  invalidCode: () => new AppError(401, 'INVALID_MFA_CODE', 'That code is not valid. Check your authenticator and try again'),
  forbidden: (message = 'You do not have permission for this action') => new AppError(403, 'PERMISSION_DENIED', message),
  csrf: () => new AppError(403, 'CSRF_REJECTED', 'Request was missing a valid CSRF token. Reload the page and try again'),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  validation: (details: ErrorDetail[]) => new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', details),
};
