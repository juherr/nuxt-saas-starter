// SPDX-License-Identifier: MIT
// Audit log helpers for the better-auth hooks.after middleware.

// Paths whose request body carries the email the action targets.
const EMAIL_TARGET_PATHS = ['/sign-in/email', '/sign-up/email', '/request-password-reset']

// Paths logged on success; failures are logged for every path.
export const AUDITED_SUCCESS_PATHS = [...EMAIL_TARGET_PATHS, '/reset-password', '/admin/remove-user']

interface AuditRequest {
  path: string
  // True when the request has a session or created one.
  hasSession: boolean
  sessionUserId?: string
  email?: string
  // Raw request body `userId`: hooks.after sees the body before zod coerces it.
  bodyUserId?: unknown
}

const toUserId = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return undefined
}

export const resolveAuditTarget = ({ path, hasSession, sessionUserId, email, bodyUserId }: AuditRequest) => {
  // The session is the acting admin's; the target is the user being removed.
  if (path === '/admin/remove-user') {
    return { targetType: 'user', targetId: toUserId(bodyUserId) }
  }
  if (hasSession) {
    return { targetType: 'user', targetId: sessionUserId }
  }
  if (EMAIL_TARGET_PATHS.includes(path)) {
    return { targetType: 'email', targetId: email || '' }
  }
  return { targetType: undefined, targetId: undefined }
}
