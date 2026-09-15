import z from '@deepseek-ai/schemastery'

/** Plugin configuration for the dsh-login authentication gateway. */
export interface Config {
  /** Credential reference name for the password (e.g. 'DSH_LOGIN_PASSWORD'). */
  password: string
  /** Absolute path to index.html in the frontend dist directory. When empty,
   * resolved automatically from @deepseek-ai/dsh-web-frontend's exports. */
  distIndex: string
  /** Directory for dsh-login-owned data files (ownership index). When empty,
   * resolved to `<dshHome>/.dsh-login` at apply time. */
  dataDir: string
  /** Session lifetime in seconds (default: 604800 = 7 days). */
  sessionTtl: number
  /** Whether the gateway is active (default: true). When false, the plugin
   * registers no routes and the usual frontend fallback serves as usual. */
  enabled: boolean
  /**
   * Whether this plugin's OWN identity surface is active (default: true).
   *
   * Set it to false when authentication is outsourced to an external identity
   * center (pair it with `unauthorizedRedirect`): the plugin then registers no
   * local identity at all — no `/login` page, no `POST /api/auth/login`, no
   * `POST /api/auth/setup` (first-admin creation) and no local user
   * administration routes (`/api/auth/admin/users*`). What remains is exactly
   * what a session store needs: the login wall, the cookie session store,
   * `ctx.dshLogin` (the external-identity seam), `/logout`,
   * `/api/auth/me` and `/api/auth/capabilities`.
   *
   * Why it matters: with an empty password store, `/login` renders the
   * first-admin SETUP form and `POST /api/auth/setup` is gated only on "no
   * user exists yet" — an unauthenticated visitor could mint an admin account
   * and bypass the identity center completely.
   */
  localAuth: boolean
  /**
   * Where an unauthenticated page request is sent (default `/login`, this
   * plugin's own login page). Set it to an external authorization URL to run
   * the SPA behind an external identity provider: the gateway 302s there with
   * the original path preserved in `?return_to=`, and an external plugin is
   * expected to establish the session (see `ctx.dshLogin`).
   *
   * Keeping the default is the emergency path: if the identity provider is
   * unreachable, set this back to `/login` (and restart) to log in locally.
   */
  unauthorizedRedirect: string
  /**
   * Where the browser goes after "log out" (default `''` = old behaviour:
   * `/login` with local auth, `/` with an identity center).
   *
   * Why this exists: with an identity center the session that actually matters
   * lives on the provider's domain, and only the provider can clear it. Our own
   * `/api/auth/logout` clears this process's cookie only — so a plain bounce to
   * `/` re-enters the gateway, the gateway starts SSO again, and the still-alive
   * provider session logs the person right back in (symptom: "click log out,
   * refresh, and you are inside again"). Pointing this at the provider's logout
   * endpoint makes one navigation land on the login page.
   */
  logoutUrl: string
  /** Whether dsh-login takes over the `webRuntime` service and the fallback
   * seat from the dsh-web-app `web-runtime` row (default: true). The shipped
   * cordis.patch.yml disables that row; enabling this without disabling it
   * makes the second fallback registration fail the boot. */
  takeOverWebRuntime: boolean
  /** Explicit trusted authorities (from --trusted-host), appended after the
   * LAN literals, exactly like dsh-web-app's resolveLanTrust. */
  trustedHosts: string[]
  /** Automatically learn the Host of any successful login and trust it for
   * the /api fence (persisted under <dataDir>/trusted-hosts.json). Default
   * true; set false to keep only loopback + trustedHosts (+ the LAN literals
   * when takeOverWebRuntime is on). */
  autoTrustHosts: boolean
  /** Provision a per-user default workspace for non-admin users on their
   * first /api access, so they get a usable workspace without the privileged
   * host.pickDirectory dialog. Enabled by default; an admin can toggle it at
   * runtime from the 设置-用户管理 panel (persisted separately, see
   * src/workspace-setting.ts). Each user's sandbox lives under
   * workspaceRoot/<username>; a blank starter session is seeded there so the
   * workspace is immediately visible in workspace.list (which only shows
   * workspaces holding that user's sessions). */
  defaultWorkspace: boolean
  /** Filesystem root that holds each user's default-workspace sandbox. Empty
   * resolves to `<dshHome>/workspaces`. Only used when defaultWorkspace is on. */
  workspaceRoot: string
  /**
   * Compatibility with `@linxin666/dsh-remote-web-ui` (default true). When on,
   * dsh-login writes that plugin's settings to `{ enabled: true,
   * requirePairingForLan: false }` (live + persisted, merged — so its host
   * routes mount while the device-pairing gate stays off). Non-loopback
   * desktop traffic — e.g. a public FRP host — then rides the ordinary /api
   * channel dsh-login gates by the dsh_session cookie instead of remote-web-ui's
   * pairing gate (which otherwise 401s a model-dialog / history request).
   * No-op when remote-web-ui is not installed or not in the composition.
   * An admin can toggle it live from 设置-用户管理.
   */
  remoteWebUiCompat: boolean
  /** Public base URL of a tunnel / FRP host in front of this server (e.g.
   * `http://your.host:13080`), written into remote-web-ui's `publicBaseUrl`
   * so its `/api/pair/*` fence trusts that ordinary-user origin. Only applied
   * when remoteWebUiCompat is on; empty disables it. No-op when remote-web-ui
   * is not installed. */
  remoteWebUiPublicBaseUrl: string
  /**
   * Quietly deny side-effect-free discovery probes for ordinary users (default
   * true). When on, the physical layer answers an unauthorized read probe
   * (`list`/`status`/`describe`/… or a QUIET_DENY_METHODS method) with 204 No
   * Content instead of 403, so UI-plugin startup enumeration does not splash
   * errors into the browser console or trigger retries. Side-effecting writes
   * always keep 403. When off, every unauthorized method returns 403 as before.
   * This never loosens authorization — only the shape of the denial for
   * side-effect-free calls.
   */
  quietDenials: boolean
}

export const Config: z<Config> = z.object({
  password: z.string().required(),
  distIndex: z.string().default(''),
  dataDir: z.string().default(''),
  sessionTtl: z.natural().default(604800),
  enabled: z.boolean().default(true),
  localAuth: z.boolean().default(true),
  unauthorizedRedirect: z.string().default('/login'),
  logoutUrl: z.string().default(''),
  takeOverWebRuntime: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  autoTrustHosts: z.boolean().default(true),
  defaultWorkspace: z.boolean().default(true),
  workspaceRoot: z.string().default(''),
  remoteWebUiCompat: z.boolean().default(true),
  remoteWebUiPublicBaseUrl: z.string().default(''),
  quietDenials: z.boolean().default(true),
})
