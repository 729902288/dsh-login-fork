import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { MemoryCredentials } from './memory-credentials.ts'
import * as DshLogin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(extraConfig: readonly string[] = []): Promise<{ ctx: Context; port: number; distIndex: string; dataDir: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-plugin-entry-'))
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<html><body>shell</body></html>')
  const dataDir = join(root, 'data')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    // dsh-login takes over the fallback seat; frontend-static is not
    // included because both would try to claim the fallback handler.
    "- id: login",
    "  name: '@islibaodong/dsh-login'",
    '  config:',
    '    password: DSH_LOGIN_PASSWORD',
    `    distIndex: '${distIndex}'`,
    `    dataDir: '${dataDir}'`,
    '    sessionTtl: 3600',
    '    enabled: true',
    ...extraConfig,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@islibaodong/dsh-login', DshLogin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  await context.plugin(MemoryCredentials)
  return { ctx: context, port: context.webServer.port, distIndex, dataDir }
}

async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { ...init, redirect: 'manual' })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

async function postJson(port: number, path: string, body: unknown, cookie?: string): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie !== undefined) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers }
}

/** First-time setup: create the root admin through the setup endpoint. */
async function setupAdmin(port: number, password: string): Promise<string> {
  const res = await postJson(port, '/api/auth/setup', { username: 'root', password })
  if (res.status !== 200) throw new Error(`setup failed: ${String(res.status)}`)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('dsh-login plugin (full composition)', () => {
  it('protects the root with a redirect to /login when unauthenticated', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const res = await request(port, '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('shows the setup form at /login while no user exists', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const res = await request(port, '/login')
    expect(res.status).toBe(200)
    expect(res.body).toContain('/api/auth/setup')
    expect(res.body).toContain('name="username"')
  })

  it('shows the login form (with username field) once users exist', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    await setupAdmin(port, 's3cret')
    const res = await request(port, '/login')
    expect(res.status).toBe(200)
    expect(res.body).toContain('/api/auth/login')
    expect(res.body).toContain('name="username"')
    expect(res.body).not.toContain('/api/auth/setup')
  })

  it('completes setup -> logout -> username login -> access -> logout', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()

    const setupCookie = await setupAdmin(port, 's3cret')
    expect(setupCookie).toContain('dsh_session=')
    expect((await request(port, '/', { headers: { Cookie: setupCookie } })).status).toBe(200)

    // End the setup session, then log in through the normal flow.
    await postJson(port, '/api/auth/logout', {}, setupCookie)
    expect((await request(port, '/', { headers: { Cookie: setupCookie } })).status).toBe(302)

    const bad = await postJson(port, '/api/auth/login', { username: 'root', password: 'wrong' })
    expect(bad.status).toBe(401)

    const missing = await postJson(port, '/api/auth/login', { password: 's3cret' })
    expect(missing.status).toBe(400)

    const login = await postJson(port, '/api/auth/login', { username: 'root', password: 's3cret' })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!

    const after = await request(port, '/', { headers: { Cookie: cookie } })
    expect(after.status).toBe(200)
    expect(after.body).toContain('shell')

    expect((await postJson(port, '/api/auth/logout', {}, cookie)).status).toBe(200)
    expect((await request(port, '/', { headers: { Cookie: cookie } })).status).toBe(302)
  })

  it('serves /api/auth/me for the live session', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const cookie = await setupAdmin(port, 's3cret')
    const me = await request(port, '/api/auth/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(JSON.parse(me.body)).toEqual({ userId: 'root', username: 'root', email: '', name: '', roles: [], isAdmin: true, localAuth: true })
    const anon = await request(port, '/api/auth/me')
    expect(anon.status).toBe(401)
  })

  it('serves the admin JSON routes for admins; the standalone /admin page is gone', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    // The exact /admin route was removed (user management moved into the
    // GUI settings panel); anonymous hits fall through to the gateway
    // fallback, which redirects to /login.
    const anon = await request(port, '/admin')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/login')

    const cookie = await setupAdmin(port, 's3cret')

    const created = await postJson(port, '/api/auth/admin/users', { username: 'alice', password: 'apw' }, cookie)
    expect(created.status).toBe(201)

    const list = await request(port, '/api/auth/admin/users', { headers: { Cookie: cookie } })
    expect(list.status).toBe(200)
    const body = JSON.parse(list.body) as { users: Array<{ username: string }> }
    expect(body.users.map(u => u.username).sort()).toEqual(['alice', 'root'])
  })

  it('no longer mounts an /api takeover (option A: upstream connection owns /api)', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const cookie = await setupAdmin(port, 's3cret')

    // Under option A (DSH ≥ 0.1.5-alpha.1) dsh-login does not claim the /api
    // prefix — the native `connection` row does. In this test composition there
    // is no connection row either, so a POST to /api reaches the gateway
    // fallback, which answers 405 (fallback-only semantics). A 405 (rather than
    // the old takeover's 404 api===undefined arm) proves no duplicate /api
    // prefix route is mounted here.
    const anon = await request(port, '/api/sessions.list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(anon.status).toBe(405)
    const authed = await request(port, '/api/sessions.list', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })
    expect(authed.status).toBe(405)
  })
})

/**
 * `localAuth: false` is the identity-center shape: this plugin is a SESSION
 * STORE only. These tests pin the security property that motivates the flag —
 * with an empty password store, the local surface would otherwise render the
 * first-admin SETUP form and mint that admin for anyone who asks.
 */
describe('dsh-login with an external identity center (localAuth: false)', () => {
  const external: readonly string[] = ["    unauthorizedRedirect: '/sso/start'", '    localAuth: false']

  it('registers no local identity surface', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition(external)

    // The wall now points at the provider.
    const root = await request(port, '/')
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/sso/start?return_to=%2F')

    // /login is not a page any more: it falls through to the wall.
    const login = await request(port, '/login')
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/sso/start?return_to=%2Flogin')

    // Both account-minting endpoints are gone (the fallback owns GET/HEAD
    // only, so a POST is answered 405 instead of creating anything).
    expect((await postJson(port, '/api/auth/setup', { username: 'evil', password: 'evil' })).status).toBe(405)
    expect((await postJson(port, '/api/auth/login', { username: 'evil', password: 'evil' })).status).toBe(405)
    // ...and so is local account administration.
    expect((await postJson(port, '/api/auth/admin/users', { username: 'evil', password: 'evil' })).status).toBe(405)

    // Logout goes back to the gateway (which bounces to the provider), not to
    // a /login page that no longer exists.
    const out = await request(port, '/logout')
    expect(out.status).toBe(302)
    expect(out.headers.get('location')).toBe('/')
  })

  it('still stores a session for an externally authenticated identity', { timeout: 60_000 }, async () => {
    const { ctx, port } = await loadComposition(external)
    const seam = (ctx as unknown as { get(name: string): { createSession(user: string, isAdmin: boolean, identity?: unknown): { token: string; cookie: string } } }).get('dshLogin')
    const session = seam.createSession('alice@example.com', false, {
      id: 'base-uuid-1',
      email: 'alice@example.com',
      name: '爱丽丝',
      roles: [{ name: 'admin', app: 'dsh' }, { name: '采购部', app: 'global' }],
    })
    const cookie = `dsh_session=${session.token}`

    // A session created through the seam is a real session, and the identity
    // the provider asserted comes back intact: the base subject id is the
    // primary key, email/name are display labels. (Serving the SPA shell
    // itself is covered by the gateway suite — this composition's stub dist
    // only answers the named routes.)
    const me = await request(port, '/api/auth/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(JSON.parse(me.body)).toEqual({
      userId: 'base-uuid-1',
      username: 'alice@example.com',
      email: 'alice@example.com',
      name: '爱丽丝',
      roles: [{ name: 'admin', app: 'dsh' }, { name: '采购部', app: 'global' }],
      isAdmin: false,
      localAuth: false,
    })

    // Capability discovery stays (it is identity, not local accounts).
    expect((await request(port, '/api/auth/capabilities', { headers: { Cookie: cookie } })).status).toBe(200)

    // A session created without an identity (the pre-existing shape) still
    // reads back: userId falls back to the display user.
    const legacy = seam.createSession('bob@example.com', false)
    const legacyMe = await request(port, '/api/auth/me', { headers: { Cookie: `dsh_session=${legacy.token}` } })
    expect(JSON.parse(legacyMe.body)).toEqual({
      userId: 'bob@example.com', username: 'bob@example.com', email: '', name: '', roles: [], isAdmin: false, localAuth: false,
    })
  })
})
