import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Who a session belongs to, when the identity was established elsewhere (an
 * external identity center / SSO provider).
 *
 * This plugin never authenticates anyone in that mode — it only *stores* the
 * identity the provider asserted. `id` is the provider's subject and is the
 * primary key (an email is a display label that can change; the subject
 * cannot). Everything else is carried along for display and for downstream
 * authorization decisions.
 */
export interface SessionIdentity {
  /** Provider subject id — the stable primary key for this person. */
  id: string
  /** Display/contact email, if the provider sent one. */
  email?: string
  /** Human-readable name, if the provider sent one. */
  name?: string
  /** Roles as asserted by the provider (`app` = which application they belong to). */
  roles?: Array<{ name: string; app?: string }>
}

/** One created login session: token, owning user, and expiry timestamps. */
export interface Session {
  token: string
  /** Display label for the session owner (an email, for an SSO session). */
  user: string
  isAdmin: boolean
  createdAt: number
  expiresAt: number
  /** Present when the identity came from an external provider (SSO). */
  identity?: SessionIdentity
}

/** Debounce window for coalescing disk writes (ms), mirroring the sidecar files. */
const SAVE_DEBOUNCE_MS = 200

/**
 * Validate an identity blob read back from disk. Fail-closed: a malformed
 * record yields no identity (the session stays valid, it just carries no
 * external subject) — never a half-trusted id.
 */
function readIdentity(raw: unknown): SessionIdentity | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Partial<SessionIdentity>
  if (typeof r.id !== 'string' || r.id === '') return undefined
  const identity: SessionIdentity = { id: r.id }
  if (typeof r.email === 'string' && r.email !== '') identity.email = r.email
  if (typeof r.name === 'string' && r.name !== '') identity.name = r.name
  if (Array.isArray(r.roles)) {
    const roles: Array<{ name: string; app?: string }> = []
    for (const entry of r.roles) {
      if (entry === null || typeof entry !== 'object') continue
      const role = entry as { name?: unknown; app?: unknown }
      if (typeof role.name !== 'string' || role.name === '') continue
      roles.push(typeof role.app === 'string' && role.app !== '' ? { name: role.name, app: role.app } : { name: role.name })
    }
    identity.roles = roles
  }
  return identity
}

/**
 * Session token store with automatic TTL expiry.
 *
 * In-memory map is authoritative for the running process. When a `filePath` is
 * supplied (production — `<dataDir>/sessions.json`), sessions are persisted on
 * every mutation with a debounced, best-effort write, and restored on boot, so
 * a process restart (or a plugin reload while testing) does not silently
 * invalidate every existing login cookie — which previously turned an already-
 * loaded SPA's next `/api` call into a 401 while the page itself redirected to
 * /login only on a full reload. Tokens are written with `0o600`; the file is
 * fail-closed on boot (unreadable/corrupt → start empty).
 */
export class SessionStore {
  private readonly store = new Map<string, Session>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly ttlSeconds: number,
    private readonly filePath?: string,
    private readonly onRevoke?: (token: string) => void,
  ) {
    if (filePath !== undefined) this.load()
  }

  /**
   * Drop one token and tell whoever cares. Every removal path funnels through
   * here so an out-of-process identity holder (a plugin keeping a longer-lived
   * credential per session) hears about it no matter which route revoked it:
   * logout, admin removal, password change, expiry sweep.
   */
  private drop(token: string): boolean {
    const removed = this.store.delete(token)
    if (removed) this.onRevoke?.(token)
    return removed
  }

  /** Generate a 32-byte random token for `user` with its admin flag. */
  create(user: string, isAdmin: boolean, identity?: SessionIdentity): Session {
    const token = randomBytes(32).toString('hex')
    const createdAt = Date.now()
    const session: Session = { token, user, isAdmin, createdAt, expiresAt: createdAt + this.ttlSeconds * 1000 }
    if (identity !== undefined) session.identity = identity
    this.store.set(token, session)
    this.scheduleSave()
    return session
  }

  /** Return the live session for a token, or undefined. */
  verify(token: string): Session | undefined {
    if (token.length === 0) return undefined
    const session = this.store.get(token)
    if (session === undefined) return undefined
    if (Date.now() > session.expiresAt) {
      this.drop(token)
      this.scheduleSave()
      return undefined
    }
    return session
  }

  /** Remove a session. Revoking an unknown token is a no-op. */
  revoke(token: string): void {
    if (this.drop(token)) this.scheduleSave()
  }

  /**
   * Revoke every live session belonging to `user` (user removal or password
   * change). Returns the number of sessions removed.
   */
  revokeAllFor(user: string): number {
    let removed = 0
    for (const [token, session] of this.store) {
      if (session.user === user) {
        this.drop(token)
        removed++
      }
    }
    if (removed > 0) this.scheduleSave()
    return removed
  }

  /**
   * Count live (unexpired) sessions per username. Used by the admin user
   * list to report online status; expired entries are swept along the way.
   */
  onlineCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    const now = Date.now()
    let swept = false
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.drop(token)
        swept = true
        continue
      }
      counts.set(session.user, (counts.get(session.user) ?? 0) + 1)
    }
    if (swept) this.scheduleSave()
    return counts
  }

  /** Remove all expired sessions. */
  cleanup(): void {
    const now = Date.now()
    let swept = false
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.drop(token)
        swept = true
      }
    }
    if (swept) this.scheduleSave()
  }

  /** Force the pending save; resolves when the queued write settled (teardown). */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.saving
    await this.writeNow()
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath!, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const list = Array.isArray(parsed) ? parsed : []
      const now = Date.now()
      for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue
        const s = entry as Partial<Session>
        if (typeof s.token !== 'string' || typeof s.user !== 'string' || typeof s.isAdmin !== 'boolean') continue
        if (typeof s.createdAt !== 'number' || typeof s.expiresAt !== 'number') continue
        if (now > s.expiresAt) continue // already expired: drop on load
        const identity = readIdentity(s.identity)
        this.store.set(s.token, {
          token: s.token, user: s.user, isAdmin: s.isAdmin, createdAt: s.createdAt, expiresAt: s.expiresAt,
          ...(identity === undefined ? {} : { identity }),
        })
      }
    } catch { /* absent or corrupt: start empty (fail-closed) */ }
  }

  private scheduleSave(): void {
    if (this.filePath === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saving = this.writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeNow(): Promise<void> {
    if (this.filePath === undefined) return
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, `${JSON.stringify([...this.store.values()])}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch { /* persistence is best-effort; memory stays authoritative */ }
  }
}