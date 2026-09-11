import { timingSafeEqual } from 'node:crypto'

/** The HTTP cookie name carrying the session token. */
export const COOKIE_NAME = 'dsh_session'

/**
 * Constant-time password comparison. Returns false for empty input or
 * different-length strings without touching the timing of the comparison.
 */
export function verifyPassword(input: string, expected: string): boolean {
  if (input.length === 0 || input.length !== expected.length) return false
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  return timingSafeEqual(a, b)
}

/**
 * Parse the session token from a Cookie header value.
 * Returns undefined when the header is missing or the cookie is absent.
 */
export function extractSessionToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1)
    }
  }
  return undefined
}

/** Build a Set-Cookie header value that sets the session token.
 *
 * `SameSite=Lax` (not `Strict`): the gateway's login redirect can arrive from a
 * cross-site authorization server, and a `Strict` cookie is withheld on the
 * first top-level navigation of such a chain — the browser would bounce back
 * unauthenticated. Lax still withholds the cookie from cross-site POSTs, which
 * is the CSRF property that matters here. */
export function buildCookieHeader(token: string, ttlSeconds: number): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${String(ttlSeconds)}`
}

/** Build a Set-Cookie header value that clears the session token. */
export function buildClearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}
