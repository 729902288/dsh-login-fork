import type { ServerResponse, IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import { extractSessionToken } from './auth.ts'
import type { Config } from './config.ts'

/**
 * Render index.html through the webserver's injection pipeline.
 *
 * Harness 0.1.1-rc.1 moved the boot manifest (the window.__ModuleLoader__ queue
 * facade, its parser preloads, and window.__DSH_BOOT__) from raw tapIndex
 * transforms into the structured injection table rendered only by
 * webServer.renderIndex. applyIndexTaps still exists but runs just the raw
 * taps, so calling it alone would serve an index with no module loader - the
 * shell then fails with "web boot: window.__ModuleLoader__ bootstrap facade is
 * missing". Prefer renderIndex and fall back to applyIndexTaps on harness
 * 0.1.0-rc.x, where it is the full pipeline.
 */
function indexRenderer(ctx: Context, distIndex: string): () => Promise<string> {
  return async (): Promise<string> => {
    const body = await readFile(distIndex, 'utf8')
    const webServer = ctx.webServer as {
      renderIndex?: (html: string) => string
      applyIndexTaps: (html: string) => string
    }
    const render = webServer.renderIndex ?? webServer.applyIndexTaps.bind(webServer)
    return render.call(webServer, body)
  }
}

/**
 * The index `authorizeIndex` callback handed to `serveStatic` (DSH ≥
 * 0.1.5-alpha.1 requires it). dsh-login validates its login wall in the
 * handler, so this only forwards to the upstream Connection service's
 * `authorizeIndex`, which hands the browser its /api browser-session cookie
 * (the now-enabled `connection` row owns /api transport). When Connection is
 * absent from the fiber we accept, so a boot without it still serves.
 *
 * @returns true when the SPA index may be served; false when an upstream
 *   redirect/401 has already been written.
 */
function createAuthorizeIndex(ctx: Context): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const connection = ctx.get('connection') as
      | { authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean }
      | undefined
    if (connection === undefined) return true
    return connection.authorizeIndex(req, res)
  }
}

/**
 * Create the gateway handler used as the webserver fallback. The dsh-login
 * login wall runs first: no valid dsh-login cookie → 302 to /login for any
 * fallback path (pages, assets, SPA routes). Authenticated requests are served
 * static files via the frontend-static `serveStatic`, whose `authorizeIndex`
 * runs the upstream Connection browser-session handshake so the restored
 * `connection` row accepts the SPA's /api calls.
 *
 * Uses registerFallback (not prefix /) because the WebServer's prefix match
 * checks 'pathname.startsWith(prefix + '/')' - for prefix '/' that becomes
 * '//', which no normal path starts with. A prefix '/' route only matches the
 * exact path '/'. The fallback handler catches everything no named route
 * claims, which is the correct catch-all behavior for the gateway.
 */
export function createGatewayHandler(
  ctx: Context,
  config: Config,
  store: SessionStore,
): WebRoute['handler'] {
  const distRoot = dirname(config.distIndex)
  const renderIndex = indexRenderer(ctx, config.distIndex)
  const authorizeIndex = createAuthorizeIndex(ctx)

  return async (req: IncomingMessage, res: ServerResponse) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const token = extractSessionToken(req.headers.cookie)
    if (token === undefined || store.verify(token) === undefined) {
      // Unauthenticated page request → where the config says. Default is this
      // plugin's own `/login`; an external authorization URL runs the SPA
      // behind an identity provider (the original path rides along in
      // `?return_to=` so the callback can send the browser back here).
      const target = config.unauthorizedRedirect ?? ''
      if (target === '' || target === '/login') {
        // The local login page only exists while `localAuth` is on. Without it
        // this branch would 302 to a page nobody serves — and because the
        // fallback owns every unregistered path, that is an endless redirect
        // loop. Fail visibly instead of looping.
        if (config.localAuth === false) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('未登录，且本地登录已关闭（localAuth=false）——请把 unauthorizedRedirect 指向身份中心。')
          return
        }
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const separator = target.includes('?') ? '&' : '?'
      const location = `${target}${separator}return_to=${encodeURIComponent(rawPath)}`
      res.writeHead(302, { Location: location })
      res.end()
      return
    }
    store.cleanup()
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      config.distIndex,
      // 认证这步可能已经把响应写掉了（401/303）。写过了就绝不能再往下走：
      // serveStatic 在取不到文件时会再 writeHead 一次，头已发就会抛错，
      // 请求随之被中断，浏览器只看到空白页。
      () => {
        if (authorizeIndex(req, res)) return true
        if (!res.headersSent) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('未登录：请重新打开 dsh 打印的地址。')
        }
        return false
      },
      renderIndex,
    )
  }
}