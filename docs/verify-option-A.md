# dsh-login — DSH 0.1.5-alpha.1 adaptation: behavioral-verification handoff

Status of the goal `Re-adapt dsh-login to DSH 0.1.5-alpha.1 (option A)`: the **host source
loads against the built 0.1.5 harness** (`scripts/verify-imports.mjs` → exit 0). The items
below could **not** be completed or verified from an agent session, because an agent session
does not host the web composition (`webServer` / `connection` / `clientModules` are web-plane).
Each requires a real `dsh web` boot plus a browser. This is the precise checklist a person
with a bootable DSH must run.

## Setup required before any check

```bash
# 1. install the plugin into a real DSH web profile
dsh plugin --profile web add PATH_TO_THIS_REPO      # or `github:islibaodong/dsh-login`
# 2. build the frontend dist (the gateway serves it):
cd <deepseek-harness checkout> && pnpm run build:web
# 3. rebuild the plugin's host bundle (package.json main -> dist/index.js):
cd <this repo> && npm install && npm run build:host
# 4. start
dsh web
```

> **Update 2026-09-08 (correcting an earlier blocker claim):** this session is itself a locally
> built DSH web at `E:\code\deepseek-harness`. The harness checkout has a working toolchain
> (`node_modules/.bin/tsc`, `pnpm`, the built `connection` lib) and this plugin's
> `npm run build:host` **succeeded** (`dist/index.js`, 46.2kb, and the built bundle imports and
> exports `Config/apply/inject/name`). `webServer` is a **live, injectable service** in the
> runtime (`ctx.get("webServer")` / `inject:["webServer"]`), and `typertGateway` is live with
> `invoke({namespace,method,args})` / `stream`. So the plugin's `gateway.spec.ts` and
> `plugin-entry.spec.ts` already exercise the login wall + admin routes over a **real
> `webServer`** in-process (they pass). The only seam not yet implemented is per-user isolation
> at the Remote layer — see §B.

## A. Login wall + upstream `/api` handshake (P0)

```dsh-ui
{"gap":10,"items":[
 {"type":"list","items":[
  "Open http://127.0.0.1:3080 → first visit shows the create-administrator page (no users yet); create it.",
  "Log out → visiting / and any static asset (e.g. /assets/*.js) must 302 → /login.",
  "Log in → the SPA must fully load (chat UI, history, composer).",
  "Check DevTools → Network: after login, index should carry the upstream browser-session cookie (dsh-auth-*) so /api/* calls succeed (200, not 401/404).",
  "The 设置 panel must show 用户管理 for admin, 账户 for ordinary users (set-ting panel client re-home, item iii)."
 ]}
]}
```
Failure signals: `/api/*` returns 401/404 after login → the gateway is serving index without
the upstream `connection.authorizeIndex` completing (check `gateway.ts` / the `connection`
row). A blank shell / "bootstrap facade missing" → `renderIndex` not running (check
`indexRenderer`).

## B. Per-user conversation/workspace isolation — the security seam (P1, the core)

Option A removed the `/api` takeover that physically filtered per user, so isolation must be
re-established at the Remote layer. **Live-contract decision (2026-09-08):** the Remote layer is
**agent-keyed, not browser-user-keyed** — `typertGateway.invoke({namespace, method, args})`
resolves the caller via the Typert `Context`/`agentId`, and there is **no browser-user field on
`InvokeRemoteRequest`**. `connection` is not even a catalogued service in this runtime
(it is the web-profile's transport row). Therefore per-user isolation in option A is best
achieved by **construction**: each dsh-login user acts exclusively within their own
agent/session subtree (recorded in the `ownership` sidecar), so `session/workspace/subagent/goal`
reads and writes are naturally scoped per user without a byte-fiddling gateway filter. This
reuses the existing per-user default-workspace + ownership model.

**Implementation (in progress):** a `typertGateway` guard (`src/remote-guard.ts`) that wraps
`invoke`/`stream` for non-admin users — (a) deny admin-only namespaces wholesale
(`credentials`, `settings`, `agentPresets`), (b) reject a Remote call whose `args` name a
`sessionId`/`workspaceId`/`parentSessionId` not in the caller's owned set (reusing the
`USER_ALLOWED` / ownership predicates kept in `api-filter.ts`/`capabilities.ts`), (c) pass
everything else through. Unit-covered against a fake `typertGateway` (including array/nested
id-arg ownership and admin session resolution); behavioral sign-off below
needs a two-user web boot because the caller-agent mapping (agentId → dsh-login user) is a
deployment fact this runtime cannot host (no `connection` / multiple real agents on line).

**Activation is a composition decision, not a runtime hot-swap.** `typertGateway` is a live
harness service; dsh-login cannot re-provide a wrapped copy (duplicate-service error). A
deployment that wants the guard must **compose `wrapRemoteGateway` in place of the native
`typertGateway` row** (or register it as the sole Remote gateway), supplying `resolveUser`
(via `ctx.agents.currentInitiator().id` → `OwnershipIndex` → username) and an `owns`
predicate. `createRemoteIsolation` in the same module builds that glue. This is the step a
booted multi-session deployment still needs to do — the guard logic itself is written and
tested.

Verify with **two browsers**:
- Browser A: ordinary user `alice`, Browser B: ordinary user `bob`:
  - `alice` creates + uses a chat; `bob`'s history/conversations must NOT list it.
  - `alice`'s `session.list` / `workspace.list` must only return her own; `bob` sees neither her session nor her workspace.
  - `bob` trying admin domains (`credentials.*`, `settings.*`, `agentPresets.*`) must be refused (403 or quiet 204/404), never executed.
  - `bob` must not `session.history`/`rename`/`fork`/`prompt` a session he does not own.
- Browser C: admin: sees all sessions/workspaces and full config.
- Subagent lineage: a child of `alice`'s session is owned by `alice` (follows `parentSessionId`).

## C. Remote-web-ui compat (P1)

Install `@linxin666/dsh-remote-web-ui`, open from a non-loopback (FRP/tunnel) host:
- The compat toggle must write `enabled:true` + `requirePairingForLan:false` (+
  `publicBaseUrl` when configured) into the `remote-web-ui` settings namespace under the new
  string-literal namespace API (`remote-web-ui-compat.ts`), so non-loopback traffic rides
  `/api` behind the dsh-login cookie instead of the dead `/remote` wall.

## D. Capability discovery + quiet denials surface (P2)

After login as ordinary user, third-party UI plugins (e.g. `@linxin666/dsh-pet`,
plugin-manager, doctor) must not render forbidden walls on startup read probes:
`GET /api/auth/capabilities` returns the per-identity surface; `window.__DSH_SESSION__`
carries the conservative baseline injected at index render. Confirm the quiet 204/404 shape
for read probes once the seam (B) lands.

## E. Engineering items — done in-session

- **(i)** Settings-panel client re-home — **done**: `src/settings-panel.client.js` is now a
  standalone `dsh.client` (the stale `@islibaodong/dsh-login/connection` re-export and the
  `connection` provision were removed — the native `connection` row owns /api).
  `scripts/build-client.mjs` rebuilds `dist/client.js` as a single-registration
  `__ModuleLoader__.load({ id:"@islibaodong/dsh-login", factory })` closure. `package.json`
  `build` = `build:host && build:client`.
- **(ii)/(iii)** Host bundle + build pipeline — **done/verified**: `build-host.mjs` bundles
  `src/index.ts` → `dist/index.js`; stale `dist/connection*.js` removed; `vendor/` and removed
  deps dropped. `npm run build` succeeds in-session (`dist/index.js` 46.2kb,
  `dist/client.js` 37KB).
- **(iv)** Test-suite rewrite — **done for the loadable suite**: the 3 obsolete
  `dsh-host-apiproxy` takeover specs were removed; gateway/plugin-entry/client-bundle/
  settings-panel specs updated to option-A; `remote-guard.spec.ts` covers the isolation guard
  end-to-end (ownership scoping, admin passthrough, array/nested arg ownership). Suite **green:
  17 files / 189 tests**. What still awaits the composed seam (B) is only the live
  two-browser behavioral sign-off, not the tests themselves.

## Outcome gate (definition of done)

1. `scripts/verify-imports.mjs` exit 0 (done).
2. `npx vitest run` green under option A (done — 17 files / 189 tests).
3. `npm run build` produces a working `dist` (done — `dist/index.js` + `dist/client.js`).
4. Fresh `dsh web` boot with dsh-login installed: first-visit admin bootstrap + login wall +
   SPA fully loading + the settings panel visible per role (needs a browser boot to confirm).
5. Two-browser isolation passing (B) with the composed seam (needs the multi-user boot).