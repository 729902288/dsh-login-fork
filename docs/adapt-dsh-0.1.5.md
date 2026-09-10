# Re-adapting dsh-login to DSH `dsh-v0.1.5-alpha.1`

Status: **draft / analysis-complete**. This maps every compatibility break the upstream
`dsh-v0.1.5-alpha.1` (2026-09-08) introduces for this plugin against the architecture this
plugin was built for, and proposes the redesign. **Do not treat any code here as verified.**
The `connection.ts` / `api-filter.ts` port to the new transport is security-critical and must
be built and DRY-run against a genuinely built DSH before release — this workspace has no
build/test path (the harness `lib/` artifacts for `apiproxy`/`connection` are absent, and the
plugin's `connection.ts` cannot typecheck without them).

Reference commit for the break: `dcddaa1a6e` "refactor(client): replace legacy Host event
carriers" (upstream replaced the WebSocket downlink event transport).

---

## What changed upstream that breaks dsh-login

| dsh-login dependency | In 0.1.5-alpha.1 | Impact |
|---|---|---|
| `@deepseek-ai/dsh-client-connection/src/websocket-downlink.ts` (`WebSocketDownlinks`, `rejectWebSocketUpgrade`) | **Deleted** | `src/connection.ts` does not load |
| `@deepseek-ai/dsh-client-connection/src/api-path.ts` `HOST_EVENTS_PATH` / `MUX_EVENTS_PATH` | **Removed** (only `API_PATH` remains) | `src/connection.ts` does not load |
| `@deepseek-ai/dsh-client-connection` `HostConnectionService` ctor | Now `(ctx, trustedHosts, browserAuth: BrowserAuth)` | `new HostConnectionService(ctx, hosts)` is wrong arity |
| `HostConnectionService.createSharedFetchHandler(channel)` | Returns `ConnectionFetchHandler` `{requestBodyMode, fetch}`; second arg gone | Old `(API_PATH, {fetch})` call is wrong |
| `@deepseek-ai/dsh-host-apiproxy` (`ApiProxy`, `toFetchHandler`) | **Package gone**; replaced by `@deepseek-ai/dsh-api-gateway` + `dsh-api-remotes` | The whole per-user `ApiProxy` wrapper layer in `api-filter.ts`/`connection.ts` has no replacement type |
| `dsh-client-connection` browser bundle | New wire client (`src/client/*`), events ride the Gateway WebSocket mux | `dist/client.js` (re-stamp) must be rebuilt |
| webserver `registerFallback` / `index-inject` / `WebRoute` | **Unchanged** | Host gateway side compatible |
| `dsh-host-frontend-static` `serveStatic`/`renderIndex` | **Unchanged** | Gateway static serving compatible |
| `dsh-host-webserver` `registerUpgrade` | Still present | — |

### What the new transport looks like (0.1.5)

- **Unary `/api`**: `@deepseek-ai/dsh-client-connection` owns the `/api` prefix route and the
  `connection` service. `HostConnectionService.createSharedFetchHandler('/api')` composes exact
  Fetch routes + a **single shared RPC interceptor** that the API layer registers.
- **Live Remote streams (session follow, host events, …)**: owned by `@deepseek-ai/dsh-api-gateway`
  (`TypertGateway`). The gateway registers a `ConnectionRpcHandler` on `connection.rpc.intercept`,
  owns a **WebSocket mux** (`RemoteStreamMuxServer`, `rejectRemoteStreamUpgrade`, `REMOTE_STREAM_MUX_PATH`),
  and pushes event frames to the browser over that mux. Add `dsh-api-remotes` row registers the
  concrete Cordis event source into the gateway. This is where the old per-user
  `WebSocketDownlinks` (mux/host) filtering lived — it moved into the gateway.
- **Auth**: `@deepseek-ai/dsh-client-connection` now ships `BrowserAuth`
  (`packages/client/connection/src/browser-auth.ts`): a persistent per-browser-session HMAC
  cookie stored in the credentials system + a process launch-token exchange via
  `authorizeIndex`. It is **single-shared-session**, not multi-user. `ConnectionConfig`
  gained `cookieMaxAgeDays`; the `/api` route applies `requestRejection` = trust fence + auth.

### Why the old takeover cannot be patched

1. The plugin took over `/api` by wrapping a **per-user `ApiProxy`** (`dsh-host-apiproxy`) and
   streaming through per-user `WebSocketDownlinks`. Both constructs are gone from 0.1.5.
2. The events stream now lives on a **Gateway-owned WebSocket mux**, and the `/api` unary path
   is a shared `ConnectionFetchHandler`. The plugin's "replace the connection row and re-mount
   its own carrier + upgrades" strategy collides with the rework instead of composing with it.

---

## Proposed redesign direction

The goal is preserved: every request/session/event is resolved from the **dsh-login cookie
session**, ordinary users see/act on only their own sessions/workspaces, admins see all, and the
plugin's own settings panel stays per-user. The mechanism changes from "re-implement the
carrier" to "**compose a per-user authorization/ownership layer on top of the native
`connection` + `api-gateway` stack**."

### 1. Keep the auth gateway (already compatible)

`src/index.ts` routes, `gateway.ts` (fallback + `serveStatic`), `web-runtime.ts`,
`login-api.ts`, `admin-api.ts`, `users.ts`, `session.ts`, `ownership.ts`, `hosts.ts`,
`capabilities.ts`, `remote-web-ui-compat.ts`, `workspace-setting.ts`, `boolean-setting.ts`,
`provision.ts`, `api-filter.ts`'s allow-list/ownership predicates — all keep working as-is.

### 2. Replace the `/api` takeover (`src/connection.ts`)

Instead of `register({ prefix: '/api' })` + per-user `ApiProxy` + WebSocket downlinks:

- Construct the native `HostConnectionService` **with the upstream `BrowserAuth`**, and
  re-provide `connection` so `dsh-api-gateway`/`dsh-api-remotes` register their interceptor and
  mux on it (the plugin already re-provides `connection` today — do the same shape).
- **Do not** register a competing `/api` prefix route or WebSocket upgrade route (the gateway
  owns the mux). Let the native `connection` row own `/api` transport.
- Insert dsh-login's per-user gate **by wrapping the shared handler**: build the
  `ConnectionFetchHandler` from `connection.createSharedFetchHandler('/api')` and wrap its
  `fetch` so the request is first resolved from the dsh-login cookie session:
  - no session → 401 (login wall), trust fence → 403;
  - single-segment RPC method not in the ordinary-user allow-list → quiet 204 / loud 403
    (reuse `capabilities.ts` `isUserAllowed` / `isReadProbe`);
  - admin-only two-segment domains → quiet 204 / loud 403 (`isUserDeniedTwoSegment`);
  - physical `session.export` query target → ownership guard;
  - otherwise delegate to the underlying shared handler (which runs the gateway interceptor).
- **`cordis.patch.yml` change**: because the plugin no longer mounts a competing `/api`
  carrier, it should **stop disabling the `connection` row** (or must do so carefully and
  re-provide `ConnectionHandler`); the api-gateway/remotes rows need the native connection
  around. This is the riskiest part — it changes the composition contract and must be
  validated by a real boot.

### 3. Event-stream ownership filtering (the hard part)

Per-user filtering of live Remote streams moved into the **Gateway**. Determine whether the
gateway exposes a per-request / per-session identity hook you can key remotes off. Two options:

- **(a) Preferred** — filter at the RPC/remote-controller layer: the ownership predicates in
  `api-filter.ts` continue to govern which session/workspace the **controllers** (`session-controller`,
  `workspace-controller`, …) read, so the stream a user subscribes to only ever contains their own
  sessions. Keep top-level event dispatch scoped by `parentSessionId` ownership.
- **(b) If gateway frames must be filtered physically** — wrap the gateway's event source
  registration (`typertGateway.registerRemoteEvents`) with an ownership check keyed by the
  upstream session identity, mirroring the old `frameVisible`.

### 4. Browser bundle

Rebuild `dist/client.js` against the new `dsh-client-connection` 0.1.5 wire client
(`npm run build:client`, `scripts/build-client.mjs` unchanged in shape) and re-check the
`settings-panel.client.js` wrapper still composes.

### 5. Dependency metadata

- `peerDependencies`: drop `@deepseek-ai/dsh-host-apiproxy` (gone); the plugin now consumes
  `@deepseek-ai/dsh-client-connection` (keep range) and may need `@deepseek-ai/dsh-api-gateway`
  / `@deepseek-ai/dsh-api-remotes` peers depending on how section 3 resolves.
- `vitest.config.ts` / `tsconfig.json` aliases for `dsh-host-apiproxy` must be removed; add the
  gateway source if tests exercise it.

### 6. Tests

The `connection.spec.ts`, `api-filter.spec.ts`, `multiuser-e2e.spec.ts` suites were written
against the old carrier and will need a rewrite for the wrapper-shape takeover + the gateway
integration. Rebuild the harness `lib/` for `connection`, `api/gateway`, `api/remotes` first.

---

## Option A implementation status (2026-09-08)

Decision: **option A** — stop taking over the `/api` carrier; compose a per-user
layer on the native `connection` + `api-gateway` stack.

**Done and host-verified (loads against the built 0.1.5 harness via
`scripts/verify-imports.mjs` → exit 0):**

- `src/api-filter.ts` reduced to pure predicates (`AuthUser`, `USER_ALLOWED`,
  `isUserAllowed`); the per-user `ApiProxy` decorator is gone with the removed
  package.
- `src/connection.ts` (the `/api` takeover + WebSocket downlinks) **deleted**.
- `src/connection.client.ts` (re-stamp of the shipped connection client)
  **deleted**; the enabled `connection` row restores the browser client itself.
- `src/provision.ts` no longer imports `dsh-host-apiproxy` (structural
  `ProvisionSessionCreateApi`); `DefaultWorkspaceProvisioner` kept loadable but
  its attachment mechanism needs the upstream session controller to re-bind.
- `src/gateway.ts` updated to the 0.1.5 `serveStatic` 6-arg signature and runs
  `ctx.get('connection')?.authorizeIndex` on index responses (upstream DNS /
  browser-session handshake), preserving the dsh-login login wall.
- `src/remote-web-ui-compat.ts` adapted: `settingsNamespace('remote-web-ui')` →
  the `'remote-web-ui'` string-literal namespace (new settings API).
- `src/index.ts` no longer mounts the takeover child plugin nor the now-unused
  takeover deps.
- `src/capabilities.ts` keeps the pure capability discovery + two-segment /
  read-probe predicates.
- `cordis.patch.yml`: the `connection` row is no longer disabled; `web-runtime`
  stays disabled (dsh-login owns the fallback login wall + re-provides
  `webRuntime`).
- `package.json`: dropped the removed `@deepseek-ai/dsh-host-apiproxy`
  peer/dev dependency and the `ws` runtime dependency (the takeover's only
  consumers).

**NOT yet done — each needs a real `dsh web` boot + browser to verify
behavior (cannot be confirmed from an agent session, which does not host the
web composition / webServer):**

1. **Per-user isolation seam (the security core).** The old takeover enforced
   conversation/workspace ownership at the `/api` carrier. With upstream
   `connection` owning `/api` and Remote controllers resolving per-`agent`
   (`agent: Agent`), per-user ownership must be re-homed into the controllers /
   `typertGateway` / a `connection.rpc.intercept` layer keyed to the dsh-login
   user. This is the design+boot spike — isolation is currently **not**
   re-established and must not be assumed.
2. **Client / settings-panel re-home.** `dist/client.js` (the old re-stamped
   connection bundle + settings-section wrapper) is stale. The 设置→用户管理/账户
   settings section must become a normal `dsh.client` contribution over the
   enabled connection client, and be rebuilt.
3. **Host bundle rebuild.** `package.json` `main` is `dist/index.js`; rebuild it
   (`build:host`) with the installed toolchain against the new source.
4. **Test-suite rewrite.** `connection.spec.ts`, `api-filter.spec.ts`,
   `provision.spec.ts`, `multiuser-e2e.spec.ts` are architecture-locked to the
   removed takeover.

## Verification requirement (blocker)

This workspace cannot compile or run the plugin today:

- harness `packages/client/connection/lib` and the former `apiproxy lib` are not built (only
  `settings`, `frontend-static`, `webserver` are);
- the plugin's `tsconfig` resolves `dsh-client-connection` / `dsh-host-apiproxy` through the
  harness checkout `src`, and `websocket-downlink.ts` is gone;

so any `connection.ts` rewrite here is **unverified**. The security gate is too high to ship a
blind login/isolation change. Proceed only against a checkout with the relevant packages built
(`pnpm --filter` the connection/gateway/remotes packages and their app peers), then run
`vitest` and a real `dsh web` DRY-run as non-admin and admin.

---

## Immediate non-code follow-ups

- [ ] Decide section 2 `cordis.patch.yml`: whether `connection` row stays disabled + plugin
      re-provides `connection`, or the plugin stops disabling it.
- [ ] Spike section 3 option (a) vs (b) against a built gateway to confirm which identity hook
      exists.
- [ ] Rebuild harness `lib` for `connection`/`gateway`/`remotes`, then port + `vitest`.