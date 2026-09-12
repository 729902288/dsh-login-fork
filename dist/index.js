// src/index.ts
import { join as join2 } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

// src/config.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  password: z.string().required(),
  distIndex: z.string().default(""),
  dataDir: z.string().default(""),
  sessionTtl: z.natural().default(604800),
  enabled: z.boolean().default(true),
  localAuth: z.boolean().default(true),
  unauthorizedRedirect: z.string().default("/login"),
  takeOverWebRuntime: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  autoTrustHosts: z.boolean().default(true),
  defaultWorkspace: z.boolean().default(true),
  workspaceRoot: z.string().default(""),
  remoteWebUiCompat: z.boolean().default(true),
  remoteWebUiPublicBaseUrl: z.string().default(""),
  quietDenials: z.boolean().default(true)
});

// src/session.ts
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
var SAVE_DEBOUNCE_MS = 200;
var SessionStore = class {
  constructor(ttlSeconds, filePath) {
    this.ttlSeconds = ttlSeconds;
    this.filePath = filePath;
    if (filePath !== void 0) this.load();
  }
  ttlSeconds;
  filePath;
  store = /* @__PURE__ */ new Map();
  saveTimer;
  saving = Promise.resolve();
  /** Generate a 32-byte random token for `user` with its admin flag. */
  create(user, isAdmin) {
    const token = randomBytes(32).toString("hex");
    const createdAt = Date.now();
    const session = { token, user, isAdmin, createdAt, expiresAt: createdAt + this.ttlSeconds * 1e3 };
    this.store.set(token, session);
    this.scheduleSave();
    return session;
  }
  /** Return the live session for a token, or undefined. */
  verify(token) {
    if (token.length === 0) return void 0;
    const session = this.store.get(token);
    if (session === void 0) return void 0;
    if (Date.now() > session.expiresAt) {
      this.store.delete(token);
      this.scheduleSave();
      return void 0;
    }
    return session;
  }
  /** Remove a session. Revoking an unknown token is a no-op. */
  revoke(token) {
    if (this.store.delete(token)) this.scheduleSave();
  }
  /**
   * Revoke every live session belonging to `user` (user removal or password
   * change). Returns the number of sessions removed.
   */
  revokeAllFor(user) {
    let removed = 0;
    for (const [token, session] of this.store) {
      if (session.user === user) {
        this.store.delete(token);
        removed++;
      }
    }
    if (removed > 0) this.scheduleSave();
    return removed;
  }
  /**
   * Count live (unexpired) sessions per username. Used by the admin user
   * list to report online status; expired entries are swept along the way.
   */
  onlineCounts() {
    const counts = /* @__PURE__ */ new Map();
    const now = Date.now();
    let swept = false;
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token);
        swept = true;
        continue;
      }
      counts.set(session.user, (counts.get(session.user) ?? 0) + 1);
    }
    if (swept) this.scheduleSave();
    return counts;
  }
  /** Remove all expired sessions. */
  cleanup() {
    const now = Date.now();
    let swept = false;
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token);
        swept = true;
      }
    }
    if (swept) this.scheduleSave();
  }
  /** Force the pending save; resolves when the queued write settled (teardown). */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    await this.saving;
    await this.writeNow();
  }
  load() {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [];
      const now = Date.now();
      for (const entry of list) {
        if (typeof entry !== "object" || entry === null) continue;
        const s = entry;
        if (typeof s.token !== "string" || typeof s.user !== "string" || typeof s.isAdmin !== "boolean") continue;
        if (typeof s.createdAt !== "number" || typeof s.expiresAt !== "number") continue;
        if (now > s.expiresAt) continue;
        this.store.set(s.token, { token: s.token, user: s.user, isAdmin: s.isAdmin, createdAt: s.createdAt, expiresAt: s.expiresAt });
      }
    } catch {
    }
  }
  scheduleSave() {
    if (this.filePath === void 0 || this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }
  async writeNow() {
    if (this.filePath === void 0) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify([...this.store.values()])}
`, { encoding: "utf8", mode: 384 });
    } catch {
    }
  }
};

// src/users.ts
import { randomBytes as randomBytes2, scryptSync, timingSafeEqual } from "node:crypto";
var USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
var KEY_LEN = 64;
function hashPassword(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, "hex"), KEY_LEN).toString("hex");
}
function constantTimeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
var UserStore = class {
  constructor(credentials, ref) {
    this.credentials = credentials;
    this.ref = ref;
  }
  credentials;
  ref;
  async list() {
    const resolved = await this.credentials.resolve(this.ref);
    if (resolved === void 0) return [];
    try {
      const parsed = JSON.parse(resolved.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  async isEmpty() {
    return (await this.list()).length === 0;
  }
  async create(username, password, isAdmin) {
    if (!USERNAME_PATTERN.test(username)) throw new Error("invalid username");
    if (password.length === 0) throw new Error("password must not be empty");
    const records = await this.list();
    if (records.some((u) => u.username === username)) throw new Error(`user "${username}" already exists`);
    const salt = randomBytes2(16).toString("hex");
    const record = {
      username,
      salt,
      hash: hashPassword(password, salt),
      isAdmin: records.length === 0 ? true : isAdmin,
      createdAt: Date.now()
    };
    await this.credentials.set(this.ref, JSON.stringify([...records, record]));
    return record;
  }
  async verify(username, password) {
    const record = (await this.list()).find((u) => u.username === username);
    if (record === void 0) return void 0;
    if (record.disabled === true) return void 0;
    return constantTimeEqualHex(hashPassword(password, record.salt), record.hash) ? record : void 0;
  }
  /**
   * Set or clear the disabled flag for `username`. The caller (admin API)
   * owns the last-enabled-admin guard and session revocation.
   */
  async setDisabled(username, disabled) {
    const records = await this.list();
    const record = records.find((u) => u.username === username);
    if (record === void 0) throw new Error(`unknown user "${username}"`);
    if (disabled) record.disabled = true;
    else delete record.disabled;
    await this.credentials.set(this.ref, JSON.stringify(records));
  }
  /**
   * Stamp `lastLoginAt` for a verified login. Best-effort audit field:
   * unknown users are a silent no-op so this can never fail a login.
   */
  async touchLastLogin(username) {
    const records = await this.list();
    const record = records.find((u) => u.username === username);
    if (record === void 0) return;
    record.lastLoginAt = Date.now();
    await this.credentials.set(this.ref, JSON.stringify(records));
  }
  async setPassword(username, password) {
    if (password.length === 0) throw new Error("password must not be empty");
    const records = await this.list();
    const record = records.find((u) => u.username === username);
    if (record === void 0) throw new Error(`unknown user "${username}"`);
    record.salt = randomBytes2(16).toString("hex");
    record.hash = hashPassword(password, record.salt);
    await this.credentials.set(this.ref, JSON.stringify(records));
  }
  async remove(username) {
    const records = await this.list();
    const next = records.filter((u) => u.username !== username);
    if (next.length === records.length) throw new Error(`unknown user "${username}"`);
    await this.credentials.set(this.ref, JSON.stringify(next));
  }
};

// src/ownership.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
var SAVE_DEBOUNCE_MS2 = 200;
var OwnershipIndex = class {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      const raw = readFileSync2(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") this.map.set(k, v);
        }
      }
    } catch {
    }
  }
  filePath;
  map = /* @__PURE__ */ new Map();
  saveTimer;
  saving = Promise.resolve();
  record(sessionId, username) {
    this.map.set(sessionId, username);
    this.scheduleSave();
  }
  lookup(sessionId) {
    return this.map.get(sessionId);
  }
  has(sessionId) {
    return this.map.has(sessionId);
  }
  knownUsernames() {
    return new Set(this.map.values());
  }
  /** All recorded [sessionId, username] pairs (snapshot). */
  entries() {
    return [...this.map.entries()];
  }
  /** Force the pending save; resolves when the file write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    await this.saving;
    await this.writeNow();
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.writeNow();
    }, SAVE_DEBOUNCE_MS2);
  }
  async writeNow() {
    try {
      await mkdir2(dirname2(this.filePath), { recursive: true });
      await writeFile2(this.filePath, `${JSON.stringify(Object.fromEntries(this.map))}
`, "utf8");
    } catch {
    }
  }
};

// src/hosts.ts
import { mkdir as mkdir3, writeFile as writeFile3 } from "node:fs/promises";
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
var SAVE_DEBOUNCE_MS3 = 200;
var MAX_HOST_LENGTH = 255;
function canonicalAuthority(host) {
  let entryUrl;
  try {
    entryUrl = new URL(`http://${host}`);
  } catch {
    return void 0;
  }
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${host}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isBareAuthority(host) {
  const c = canonicalAuthority(host);
  return c !== void 0 && c === host.toLowerCase() && host.length <= MAX_HOST_LENGTH;
}
function isLoopbackCanonical(authority) {
  const hostname = (authority.split(":")[0] ?? "").toLowerCase();
  if (hostname === "localhost") return true;
  if (hostname === "::1") return true;
  if (/^127\./.test(hostname)) return true;
  if (hostname === "0.0.0.0") return true;
  if (/^\[?::1\]?/.test(authority)) return true;
  return false;
}
var TrustedHosts = class {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      const raw = readFileSync3(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" ? Object.keys(parsed) : [];
      for (const entry of entries) {
        if (typeof entry === "string") {
          const c = canonicalAuthority(entry);
          if (c !== void 0) this.set.add(c);
        }
      }
    } catch {
    }
  }
  filePath;
  set = /* @__PURE__ */ new Set();
  saveTimer;
  /** Tail of a single serialized write queue; writes never overlap. */
  saving = Promise.resolve();
  /** Canonicalize an authority; undefined when not a bare authority. */
  canonicalize(host) {
    return canonicalAuthority(host);
  }
  /** Whether this authority is currently trusted (canonical comparison). */
  has(authority) {
    const c = canonicalAuthority(authority);
    return c !== void 0 && this.set.has(c);
  }
  /**
   * Add one (auto-learned) Host authority, skipping loopback, invalid and
   * non-bare inputs. Returns true when newly recorded. Idempotent.
   */
  learn(host) {
    if (!isBareAuthority(host)) return false;
    const c = canonicalAuthority(host);
    if (isLoopbackCanonical(c)) return false;
    if (this.set.has(c)) return false;
    this.set.add(c);
    this.scheduleSave();
    return true;
  }
  /** Add a validated authority (admin manual add). Returns true when new. */
  add(authority) {
    if (!isBareAuthority(authority)) return false;
    const c = canonicalAuthority(authority);
    if (isLoopbackCanonical(c)) return false;
    if (this.set.has(c)) return false;
    this.set.add(c);
    this.scheduleSave();
    return true;
  }
  /** Remove an authority; returns true when it existed. Idempotent. */
  remove(authority) {
    const c = canonicalAuthority(authority);
    const key = c ?? authority;
    const existed = this.set.delete(key);
    if (existed) this.scheduleSave();
    return existed;
  }
  /** Snapshot of the currently trusted authorities. */
  list() {
    return [...this.set];
  }
  /** Force the pending save; resolves when the queued write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.saving = this.saving.then(() => this.writeNow());
    await this.saving;
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.saving.then(() => this.writeNow());
    }, SAVE_DEBOUNCE_MS3);
  }
  async writeNow() {
    try {
      await mkdir3(dirname3(this.filePath), { recursive: true });
      await writeFile3(this.filePath, `${JSON.stringify(this.list())}
`, "utf8");
    } catch {
    }
  }
};

// src/boolean-setting.ts
import { mkdir as mkdir4, writeFile as writeFile4 } from "node:fs/promises";
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname4 } from "node:path";
var SAVE_DEBOUNCE_MS4 = 200;
var BooleanSetting = class {
  constructor(filePath, initial) {
    this.filePath = filePath;
    this.enabled = initial;
    try {
      const raw = readFileSync4(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.enabled === "boolean") {
        this.enabled = parsed.enabled;
      }
    } catch {
    }
  }
  filePath;
  enabled;
  saveTimer;
  /** Tail of a single serialized write queue; writes never overlap. */
  saving = Promise.resolve();
  /** Whether the toggle is currently on. */
  get() {
    return this.enabled;
  }
  /** Set the flag and persist it (best-effort). Returns the new value. */
  set(enabled) {
    this.enabled = enabled;
    this.scheduleSave();
    return this.enabled;
  }
  /** Force the pending save; resolves when the queued write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.saving = this.saving.then(() => this.writeNow());
    await this.saving;
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.saving.then(() => this.writeNow());
    }, SAVE_DEBOUNCE_MS4);
  }
  async writeNow() {
    try {
      await mkdir4(dirname4(this.filePath), { recursive: true });
      await writeFile4(this.filePath, `${JSON.stringify({ enabled: this.enabled })}
`, "utf8");
    } catch {
    }
  }
};

// src/workspace-setting.ts
var DefaultWorkspaceSetting = class extends BooleanSetting {
};

// src/remote-web-ui-compat.ts
var REMOTE_WEB_UI_NAMESPACE = "remote-web-ui";
var RemoteWebUiCompat = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  /**
   * Apply the compat document to remote-web-ui's settings namespace.
   * @param compatEnabled - when true, mount the host routes and open the pairing
   * gate; when false, restore the pairing requirement only.
   * @param publicBaseUrl - optional public base URL (e.g. `http://host:port`) to
   * write so remote-web-ui's `/api/pair/*` fence trusts the public origin. Only
   * written when compat is on and the value is a non-empty http(s) URL.
   */
  async apply(compatEnabled, publicBaseUrl) {
    const settings = this.deps.getSettings();
    if (settings === void 0) return "skipped";
    let patch;
    if (compatEnabled) {
      patch = { enabled: true, requirePairingForLan: false };
      if (typeof publicBaseUrl === "string" && isHttpUrl(publicBaseUrl)) patch.publicBaseUrl = publicBaseUrl;
    } else {
      patch = { requirePairingForLan: true };
    }
    try {
      await settings.update(REMOTE_WEB_UI_NAMESPACE, patch);
      return "ok";
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).includes("not registered")) return "unregistered";
      throw error;
    }
  }
};
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}
async function applyWithRetry(compat, enabled, publicBaseUrl, attempts = 60, delayMs = 250) {
  let last = "unregistered";
  for (let i = 0; i < attempts; i++) {
    const result = await compat.apply(enabled, publicBaseUrl);
    if (result === "ok") return "ok";
    last = result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last;
}

// src/gateway.ts
import { readFile } from "node:fs/promises";
import { dirname as dirname5 } from "node:path";
import { serveStatic } from "@deepseek-ai/dsh-host-frontend-static";

// src/auth.ts
var COOKIE_NAME = "dsh_session";
function extractSessionToken(cookieHeader) {
  if (cookieHeader === void 0) return void 0;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return void 0;
}
function buildCookieHeader(token, ttlSeconds) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${String(ttlSeconds)}`;
}
function buildClearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// src/gateway.ts
function indexRenderer(ctx, distIndex) {
  return async () => {
    const body = await readFile(distIndex, "utf8");
    const webServer = ctx.webServer;
    const render = webServer.renderIndex ?? webServer.applyIndexTaps.bind(webServer);
    return render.call(webServer, body);
  };
}
function createAuthorizeIndex(ctx) {
  return (req, res) => {
    const connection = ctx.get("connection");
    if (connection === void 0) return true;
    return connection.authorizeIndex(req, res);
  };
}
function createGatewayHandler(ctx, config, store) {
  const distRoot = dirname5(config.distIndex);
  const renderIndex = indexRenderer(ctx, config.distIndex);
  const authorizeIndex = createAuthorizeIndex(ctx);
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const token = extractSessionToken(req.headers.cookie);
    if (token === void 0 || store.verify(token) === void 0) {
      const target = config.unauthorizedRedirect ?? "";
      if (target === "" || target === "/login") {
        if (config.localAuth === false) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("\u672A\u767B\u5F55\uFF0C\u4E14\u672C\u5730\u767B\u5F55\u5DF2\u5173\u95ED\uFF08localAuth=false\uFF09\u2014\u2014\u8BF7\u628A unauthorizedRedirect \u6307\u5411\u8EAB\u4EFD\u4E2D\u5FC3\u3002");
          return;
        }
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      const rawPath2 = new URL(req.url ?? "/", "http://x").pathname;
      const separator = target.includes("?") ? "&" : "?";
      const location = `${target}${separator}return_to=${encodeURIComponent(rawPath2)}`;
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }
    store.cleanup();
    const rawPath = new URL(req.url ?? "/", "http://x").pathname;
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      config.distIndex,
      () => authorizeIndex(req, res),
      renderIndex
    );
  };
}

// src/http-json.ts
import { homedir } from "node:os";
import { join } from "node:path";
var MAX_JSON_BODY_BYTES = 8192;
async function readBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > maxBytes) {
      throw new Error("body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  return env !== void 0 && env.length > 0 ? env : join(homedir(), ".dsh");
}

// src/login-api.ts
async function parseCredentials(req) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
  return { username: parsed.username, password: parsed.password };
}
function learnRequestHost(req, hosts) {
  const host = req.headers.host;
  if (typeof host === "string" && host.length > 0) hosts.learn(host);
}
function createLoginHandler(deps) {
  return async (req, res) => {
    const creds = await parseCredentials(req);
    if (creds === null) {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    if (await deps.users.isEmpty()) {
      sendJson(res, 500, { error: "no users configured" });
      return;
    }
    const record = await deps.users.verify(creds.username, creds.password);
    if (record === void 0) {
      sendJson(res, 401, { error: "invalid credentials" });
      return;
    }
    await deps.users.touchLastLogin(record.username).catch(() => {
    });
    const session = deps.store.create(record.username, record.isAdmin);
    if (deps.autoTrust === true && deps.hosts !== void 0) learnRequestHost(req, deps.hosts);
    res.setHeader("Set-Cookie", buildCookieHeader(session.token, deps.sessionTtl));
    sendJson(res, 200, { ok: true });
  };
}
function createLogoutHandler(store) {
  return async (req, res) => {
    const token = extractSessionToken(req.headers.cookie);
    if (token !== void 0) store.revoke(token);
    res.setHeader("Set-Cookie", buildClearCookieHeader());
    res.writeHead(200);
    res.end();
  };
}
function createLogoutRedirectHandler(store, location = "/login") {
  return async (req, res) => {
    const token = extractSessionToken(req.headers.cookie);
    if (token !== void 0) store.revoke(token);
    res.setHeader("Set-Cookie", buildClearCookieHeader());
    res.writeHead(302, { Location: location });
    res.end();
  };
}
function createSetupHandler(deps) {
  return async (req, res) => {
    if (!await deps.users.isEmpty()) {
      sendJson(res, 403, { error: "users already exist" });
      return;
    }
    const creds = await parseCredentials(req);
    if (creds === null || creds.password.length === 0) {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    let record;
    try {
      record = await deps.users.create(creds.username, creds.password, true);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    await deps.users.touchLastLogin(record.username).catch(() => {
    });
    const session = deps.store.create(record.username, record.isAdmin);
    if (deps.autoTrust === true && deps.hosts !== void 0) learnRequestHost(req, deps.hosts);
    res.setHeader("Set-Cookie", buildCookieHeader(session.token, deps.sessionTtl));
    sendJson(res, 200, { ok: true });
  };
}

// src/api-filter.ts
var USER_ALLOWED = /* @__PURE__ */ new Set([
  "session.list",
  "session.search",
  "session.create",
  "session.history",
  "session.models",
  "session.selectModel",
  "session.rename",
  "session.fork",
  "session.prompt",
  "session.attachment",
  "session.updateQueue",
  "session.cancel",
  "subagent.list",
  "subagent.history",
  "subagent.prompt",
  "subagent.interrupt",
  "host.describe",
  "workspace.list",
  "workspace.create",
  "workspace.rename",
  "workspace.delete",
  "workspace.insertBefore",
  "workspace.insertSessionBefore",
  "workspace.archiveSession",
  "skill.list",
  "llm.providers",
  "llm.models",
  "goal.create",
  "goal.edit",
  "goal.pause",
  "goal.resume",
  "goal.complete",
  "goal.clear",
  "respond"
]);

// src/capabilities.ts
function userAllowedMethods() {
  return [...USER_ALLOWED];
}
var USER_DOMAINS = [
  "session",
  "workspace",
  "goals",
  "subagents",
  "llm",
  "host",
  "skill",
  "api"
];
var ADMIN_ONLY_UI_PLUGINS = [
  "@linxin666/dsh-client-ui-plugin-manager",
  "@linxin666/dsh-client-ui-skill-explorer",
  "@linxin666/dsh-client-ui-skin-center",
  "@linxin666/dsh-client-ui-market",
  "@linxin666/dsh-client-ui-git-graph",
  "@linxin666/dsh-client-ui-community-plugins",
  "@linxin666/dsh-client-ui-web-ui-settings",
  "@linxin666/dsh-client-ui-aionui-panel",
  "@linxin666/dsh-client-ui-task-board",
  "@linxin666/dsh-desktop-launcher",
  "@linxin666/dsh-doctor",
  "@linxin666/dsh-pet",
  "@linxin666/dsh-ssh",
  "@linxin666/dsh-perf",
  "@linxin666/dsh-liangshen"
];
var CORE_UI_PLUGINS = [
  "@islibaodong/dsh-login"
];
function deriveCapabilities(user) {
  if (user.isAdmin) {
    return {
      methods: userAllowedMethods().concat(adminOnlyMethods()),
      domains: allDomains(),
      uiPlugins: CORE_UI_PLUGINS.concat(allUiPlugins())
    };
  }
  return {
    methods: userAllowedMethods(),
    domains: [...USER_DOMAINS],
    uiPlugins: [...CORE_UI_PLUGINS]
  };
}
function adminOnlyMethods() {
  return [
    "credentials.list",
    "credentials.get",
    "credentials.set",
    "credentials.delete",
    "settings.list",
    "settings.update",
    "settings.reset",
    "agentPreset.list",
    "agentPreset.read",
    "agentPreset.write",
    "host.path",
    "host.system"
  ];
}
function allDomains() {
  return [...USER_DOMAINS, "credentials", "settings", "agentPresets"];
}
function allUiPlugins() {
  return [...CORE_UI_PLUGINS, ...ADMIN_ONLY_UI_PLUGINS];
}

// src/admin-api.ts
function requireSession(deps, req) {
  const token = extractSessionToken(req.headers.cookie);
  return token === void 0 ? void 0 : deps.store.verify(token);
}
async function readJsonObject(req) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function requireAdmin(deps, req, res) {
  const session = requireSession(deps, req);
  if (session === void 0) {
    sendJson(res, 401, { error: "authentication required" });
    return void 0;
  }
  if (!session.isAdmin) {
    sendJson(res, 403, { error: "admin required" });
    return void 0;
  }
  return session;
}
function createAdminRoutes(deps) {
  const me = { kind: "exact", path: "/api/auth/me", handler: async (req, res) => {
    const session = requireSession(deps, req);
    if (session === void 0) return sendJson(res, 401, { error: "authentication required" });
    return sendJson(res, 200, { username: session.user, isAdmin: session.isAdmin, localAuth: deps.localAuth !== false });
  } };
  const capabilitiesRoute = { kind: "exact", path: "/api/auth/capabilities", handler: async (req, res) => {
    const session = requireSession(deps, req);
    if (session === void 0) return sendJson(res, 401, { error: "authentication required" });
    return sendJson(res, 200, {
      username: session.user,
      isAdmin: session.isAdmin,
      capabilities: deriveCapabilities({ username: session.user, isAdmin: session.isAdmin })
    });
  } };
  const usersRoute = { kind: "exact", path: "/api/auth/admin/users", handler: async (req, res) => {
    if (req.method === "GET") {
      if (requireAdmin(deps, req, res) === void 0) return;
      const records = await deps.users.list();
      const online = deps.store.onlineCounts();
      return sendJson(res, 200, {
        users: records.map((record) => ({
          username: record.username,
          isAdmin: record.isAdmin,
          lastLoginAt: record.lastLoginAt ?? null,
          disabled: record.disabled === true,
          onlineSessions: online.get(record.username) ?? 0
        }))
      });
    }
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null) return sendJson(res, 400, { error: "bad request" });
    const { username, password, isAdmin } = body;
    if (typeof username !== "string" || typeof password !== "string" || password.length === 0) {
      return sendJson(res, 400, { error: "bad request" });
    }
    if (isAdmin !== void 0 && typeof isAdmin !== "boolean") return sendJson(res, 400, { error: "bad request" });
    if ((await deps.users.list()).some((u) => u.username === username)) {
      return sendJson(res, 409, { error: "user exists" });
    }
    try {
      await deps.users.create(username, password, isAdmin === true);
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }
    return sendJson(res, 201, { ok: true });
  } };
  const userPassword = { kind: "exact", path: "/api/auth/admin/users/password", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null) return sendJson(res, 400, { error: "bad request" });
    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string" || password.length === 0) {
      return sendJson(res, 400, { error: "bad request" });
    }
    try {
      await deps.users.setPassword(username, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("unknown user")) return sendJson(res, 404, { error: "unknown user" });
      return sendJson(res, 400, { error: "bad request" });
    }
    deps.store.revokeAllFor(username);
    return sendJson(res, 200, { ok: true });
  } };
  const userRemove = { kind: "exact", path: "/api/auth/admin/users/remove", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null || typeof body.username !== "string") return sendJson(res, 400, { error: "bad request" });
    const target = body.username;
    const records = await deps.users.list();
    const record = records.find((u) => u.username === target);
    if (record === void 0) return sendJson(res, 404, { error: "unknown user" });
    if (record.isAdmin && records.filter((u) => u.isAdmin).length === 1) {
      return sendJson(res, 409, { error: "cannot remove the last admin" });
    }
    await deps.users.remove(target);
    deps.store.revokeAllFor(target);
    return sendJson(res, 200, { ok: true });
  } };
  const hosts = deps.hosts;
  const hostsRoute = hosts === void 0 ? void 0 : { kind: "exact", path: "/api/auth/admin/hosts", handler: async (req, res) => {
    if (req.method === "GET") {
      if (requireAdmin(deps, req, res) === void 0) return;
      return sendJson(res, 200, { hosts: hosts.list() });
    }
    if (req.method !== "POST" && req.method !== "DELETE") {
      if (requireAdmin(deps, req, res) === void 0) return;
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null || typeof body.host !== "string" || body.host.length === 0) {
      return sendJson(res, 400, { error: "bad request" });
    }
    const raw = body.host;
    if (raw.length > MAX_HOST_LENGTH || !isBareAuthority(raw)) {
      return sendJson(res, 400, { error: "invalid host" });
    }
    const canonical = hosts.canonicalize(raw);
    if (req.method === "POST") {
      const added = hosts.add(raw);
      return sendJson(res, added ? 201 : 200, { ok: true, host: canonical });
    }
    hosts.remove(canonical);
    return sendJson(res, 200, { ok: true, host: canonical });
  } };
  const userDisable = { kind: "exact", path: "/api/auth/admin/users/disable", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null || typeof body.username !== "string" || typeof body.disabled !== "boolean") {
      return sendJson(res, 400, { error: "bad request" });
    }
    const target = body.username;
    const records = await deps.users.list();
    const record = records.find((u) => u.username === target);
    if (record === void 0) return sendJson(res, 404, { error: "unknown user" });
    if (body.disabled && record.isAdmin && records.filter((u) => u.isAdmin && u.disabled !== true).length === 1) {
      return sendJson(res, 409, { error: "cannot disable the last enabled admin" });
    }
    await deps.users.setDisabled(target, body.disabled);
    if (body.disabled) deps.store.revokeAllFor(target);
    return sendJson(res, 200, { ok: true });
  } };
  const setting = deps.defaultWorkspaceSetting;
  const settingRoute = setting === void 0 ? void 0 : { kind: "exact", path: "/api/auth/admin/settings/default-workspace", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    if (req.method === "GET") return sendJson(res, 200, { enabled: setting.get() });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const body = await readJsonObject(req);
    if (body === null || typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "bad request" });
    setting.set(body.enabled);
    return sendJson(res, 200, { ok: true, enabled: setting.get() });
  } };
  const remoteSetting = deps.remoteWebUiSetting;
  const remoteSettingRoute = remoteSetting === void 0 ? void 0 : { kind: "exact", path: "/api/auth/admin/settings/remote-web-ui-compat", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    if (req.method === "GET") return sendJson(res, 200, { enabled: remoteSetting.get() });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const body = await readJsonObject(req);
    if (body === null || typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "bad request" });
    remoteSetting.set(body.enabled);
    let applied = "skipped";
    if (deps.onRemoteWebUiApply !== void 0) applied = await deps.onRemoteWebUiApply(body.enabled);
    return sendJson(res, 200, { ok: true, enabled: remoteSetting.get(), applied });
  } };
  const routes = deps.localAuth === false ? [me, capabilitiesRoute] : [me, capabilitiesRoute, usersRoute, userPassword, userRemove, userDisable];
  if (hostsRoute !== void 0) routes.push(hostsRoute);
  if (settingRoute !== void 0) routes.push(settingRoute);
  if (remoteSettingRoute !== void 0) routes.push(remoteSettingRoute);
  return routes;
}

// src/login-page.ts
var BASE_CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #16213e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 40px;
      width: 360px;
      max-width: 90vw;
    }
    .card h1 {
      font-size: 1.5rem;
      margin-bottom: 24px;
      text-align: center;
      color: #e0e0e0;
    }
    .card .subtitle {
      font-size: 0.8rem;
      color: #888;
      text-align: center;
      margin-bottom: 24px;
    }
    .card input[type="text"], .card input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      background: #0f0f23;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 1rem;
      margin-bottom: 16px;
      outline: none;
    }
    .card input[type="text"]:focus, .card input[type="password"]:focus {
      border-color: #4a4a6a;
    }
    .card button[type="submit"] {
      width: 100%;
      padding: 12px;
      background: #4a6fa5;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .card button[type="submit"]:hover {
      background: #5a7fb5;
    }
    .card button[type="submit"]:disabled {
      background: #3a3a5a;
      cursor: not-allowed;
    }
    .error {
      color: #ff6b6b;
      font-size: 0.875rem;
      text-align: center;
      margin-bottom: 16px;
      min-height: 1.25rem;
    }
`;
function renderLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Login</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>DSH</h1>
    <div class="error" id="error"></div>
    <form id="loginForm">
      <input type="text" name="username" id="username" placeholder="Username" autocomplete="username" autofocus required>
      <input type="password" name="password" id="password" placeholder="Password" autocomplete="current-password" required>
      <button type="submit" id="submit">Login</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const error = document.getElementById('error');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = '...';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: password.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 401) {
          error.textContent = 'Invalid username or password';
          password.value = '';
          password.focus();
        } else if (res.status === 400) {
          error.textContent = 'Bad request';
        } else if (res.status === 500) {
          error.textContent = 'Server error - no users configured';
        } else {
          error.textContent = 'Unexpected error';
        }
      } catch (err) {
        error.textContent = 'Network error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Login';
      }
    });
  </script>
</body>
</html>`;
}
function renderSetupPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Setup</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>DSH</h1>
    <div class="subtitle">First-time setup: create the administrator account</div>
    <div class="error" id="error"></div>
    <form id="setupForm">
      <input type="text" name="username" id="username" placeholder="Username" autocomplete="username" autofocus required>
      <input type="password" name="password" id="password" placeholder="New password" autocomplete="new-password" required>
      <input type="password" id="confirm" placeholder="Confirm password" autocomplete="new-password" required>
      <button type="submit" id="submit">Create Account</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('setupForm');
    const username = document.getElementById('username');
    const pw = document.getElementById('password');
    const cf = document.getElementById('confirm');
    const error = document.getElementById('error');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (username.value.length < 1) {
        error.textContent = 'Username cannot be empty';
        return;
      }
      if (pw.value.length < 1) {
        error.textContent = 'Password cannot be empty';
        return;
      }
      if (pw.value !== cf.value) {
        error.textContent = 'Passwords do not match';
        cf.value = '';
        cf.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = '...';
      try {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: pw.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 403) {
          error.textContent = 'Setup already completed';
        } else if (res.status === 400) {
          error.textContent = 'Bad request';
        } else {
          error.textContent = 'Unexpected error';
        }
      } catch (err) {
        error.textContent = 'Network error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create Account';
      }
    });
  </script>
</body>
</html>`;
}

// src/web-runtime.ts
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
var ALL_INTERFACES_HOST = "0.0.0.0";
function resolveLanTrust(bindHost, extra) {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST ? Object.values(networkInterfaces()).flat().filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal).map((iface) => iface.address) : [];
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] };
}
function resolveDistIndex() {
  const require2 = createRequire(import.meta.url);
  try {
    return require2.resolve("@deepseek-ai/dsh-web-frontend/dist/index.html");
  } catch {
    throw new Error("dsh-login: frontend dist not found; run pnpm run build from the deepseek-harness repository root first, or set config.distIndex explicitly");
  }
}
var DSH_WEB_URL = "DSH_WEB_URL";
var LOOPBACK_HOST = "127.0.0.1";
function printWebUrl(ctx, runtime) {
  const print = () => {
    const webServer = ctx.get("webServer");
    if (webServer === void 0) return;
    const lanCandidate = runtime.lanAddresses[0];
    const suffix = lanCandidate === void 0 ? "" : ` (LAN: http://${lanCandidate}:${String(webServer.port)})`;
    console.log(`dsh web: http://${LOOPBACK_HOST}:${String(webServer.port)}${suffix}`);
  };
  const settled = ctx.get("loader")?.await();
  if (settled === void 0) print();
  else void settled.then(() => print(), () => {
  });
}
function provideWebRuntime(ctx, trustedHosts) {
  const runtime = resolveLanTrust(ctx.webServer.host, trustedHosts);
  ctx.provide("webRuntime", runtime);
  printWebUrl(ctx, runtime);
  const shellEnv = ctx.get("shellEnv");
  if (shellEnv !== void 0) {
    ctx.effect(() => shellEnv.register({
      name: "web-runtime",
      variables: {
        [DSH_WEB_URL]: { description: "Canonical local URL of the DeepSeek Harness Web GUI serving this session." }
      },
      resolve: () => {
        const port = ctx.get("webServer")?.port;
        return { [DSH_WEB_URL]: port === void 0 ? "" : `http://127.0.0.1:${String(port)}` };
      }
    }), "dsh-login: DSH_WEB_URL shell variable");
  }
  return runtime;
}

// src/remote-guard.ts
var ADMIN_ONLY_NAMESPACES = /* @__PURE__ */ new Set(["credentials", "settings", "agentPresets"]);
var GUARDED_ID_FIELDS = [
  "sessionId",
  "sessionIds",
  "parentSessionId",
  "parentSessionIds",
  "childSessionId",
  "childSessionIds",
  "agentId",
  "workspaceId",
  "beforeSessionId"
];
function collectIds(value) {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (typeof value === "object" && value !== null) {
    const record = value;
    for (const key of ["id", "sessionId", "sessionIds", "agentId", "workspaceId"]) {
      const nested = record[key];
      if (nested !== void 0) return collectIds(nested);
    }
    for (const [k, v] of Object.entries(record)) {
      if (GUARDED_ID_FIELDS.includes(k)) {
        return collectIds(v);
      }
    }
  }
  return [];
}
function forbidden(namespace, method) {
  return Object.assign(new Error(`dsh-login: forbidden: ${namespace}.${method}`), { code: "forbidden" });
}
function wrapRemoteGateway(gateway, resolveUser, owns = () => false) {
  const allowed = (user, namespace, method) => {
    if (user.isAdmin) return true;
    if (ADMIN_ONLY_NAMESPACES.has(namespace)) return false;
    return USER_ALLOWED.has(`${namespace}.${method}`);
  };
  const ownershipGuarded = (user, request) => {
    if (user.isAdmin) return true;
    for (const field of GUARDED_ID_FIELDS) {
      for (const id of collectIds(request.args[field])) {
        if (id !== "" && !owns(id)) return false;
      }
    }
    return true;
  };
  const refuse = (user, request) => user === void 0 || !allowed(user, request.namespace, request.method) || !ownershipGuarded(user, request);
  return {
    async invoke(request) {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method);
      return gateway.invoke(request);
    },
    async stream(request) {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method);
      return gateway.stream(request);
    }
  };
}
function createRemoteIsolation(options) {
  const resolveUser = () => {
    const sid = options.currentSessionId();
    if (sid === void 0) return void 0;
    const adminUser = options.isAdminSession?.(sid);
    if (adminUser !== void 0 && adminUser !== "") {
      return { username: adminUser, isAdmin: true };
    }
    const username = options.ownership.lookup(sid);
    if (username === void 0 || username === "") return void 0;
    return { username, isAdmin: options.isAdmin?.(username) ?? false };
  };
  const owns = (id) => {
    const user = resolveUser();
    if (user === void 0) return false;
    if (user.isAdmin) return true;
    return options.ownership.lookup(id) === user.username;
  };
  return { resolveUser, owns };
}

// src/index.ts
var name = "dsh-login";
var inject = ["webServer", "credentials"];
function apply(ctx, config) {
  if (!config.enabled) return;
  const dataDir = config.dataDir === "" ? join2(resolveDshHome(), ".dsh-login") : config.dataDir;
  const store = new SessionStore(config.sessionTtl, join2(dataDir, "sessions.json"));
  const users = new UserStore(ctx.credentials, credentialRef(`${config.password}_USERS`));
  const ownership = new OwnershipIndex(join2(dataDir, "ownership.json"));
  const hosts = new TrustedHosts(join2(dataDir, "trusted-hosts.json"));
  const defaultWorkspaceSetting = new DefaultWorkspaceSetting(join2(dataDir, "settings.json"), config.defaultWorkspace);
  const remoteWebUiSetting = new BooleanSetting(join2(dataDir, "settings-remote-web-ui.json"), config.remoteWebUiCompat);
  const remoteWebUiCompat = new RemoteWebUiCompat({
    getSettings: () => ctx.get("settings")
  });
  const distIndex = config.distIndex === "" ? resolveDistIndex() : config.distIndex;
  const gatewayConfig = { ...config, distIndex };
  const loginDeps = { users, store, sessionTtl: config.sessionTtl, hosts, autoTrust: config.autoTrustHosts };
  const runtime = config.takeOverWebRuntime ? provideWebRuntime(ctx, config.trustedHosts) : void 0;
  ctx.provide("dshLogin", {
    /** Create a session for an externally authenticated user. */
    createSession: (user, isAdmin) => {
      const session = store.create(user, isAdmin);
      return {
        token: session.token,
        cookie: buildCookieHeader(session.token, config.sessionTtl),
        isAdmin: session.isAdmin,
        expiresAt: session.expiresAt
      };
    },
    /** Live session for a cookie token, or undefined. */
    verify: (token) => store.verify(token),
    /** Revoke one session token (logout from an external flow). */
    revoke: (token) => store.revoke(token)
  });
  const loginPageRoute = {
    kind: "exact",
    path: "/login",
    handler: async (_req, res) => {
      const html = await users.isEmpty() ? renderSetupPage() : renderLoginPage();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }
  };
  const gatewayHandler = createGatewayHandler(ctx, gatewayConfig, store);
  if (config.localAuth) {
    ctx.effect(() => ctx.webServer.register(loginPageRoute), "dsh-login: /login");
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/auth/setup",
      handler: createSetupHandler(loginDeps)
    }), "dsh-login: /api/auth/setup");
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/auth/login",
      handler: createLoginHandler(loginDeps)
    }), "dsh-login: /api/auth/login");
  } else {
    ctx.logger.info("[dsh-login] localAuth=false\uFF1A\u4E0D\u6CE8\u518C /login\u3001/api/auth/setup\u3001/api/auth/login\uFF08\u672C\u5730\u8EAB\u4EFD\u5DF2\u4EA4\u7ED9\u8EAB\u4EFD\u4E2D\u5FC3\uFF09");
  }
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/auth/logout",
    handler: createLogoutHandler(store)
  }), "dsh-login: /api/auth/logout");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/logout",
    handler: createLogoutRedirectHandler(store, config.localAuth ? "/login" : "/")
  }), "dsh-login: /logout");
  for (const route of createAdminRoutes({ users, store, hosts, defaultWorkspaceSetting, remoteWebUiSetting, remoteWebUiCompat, localAuth: config.localAuth, onRemoteWebUiApply: (enabled) => applyWithRetry(remoteWebUiCompat, enabled, config.remoteWebUiPublicBaseUrl, 3, 50) })) {
    ctx.effect(() => ctx.webServer.register(route), `dsh-login: ${route.path}`);
  }
  const bootCompat = applyWithRetry(remoteWebUiCompat, remoteWebUiSetting.get(), config.remoteWebUiPublicBaseUrl);
  void bootCompat;
  ctx.effect(() => ctx.webServer.registerFallback(gatewayHandler), "dsh-login: gateway fallback");
  const cap = deriveCapabilities({ username: "", isAdmin: false });
  const sessionBaselineScript = `window.__DSH_SESSION__={username:null,isAdmin:false,capabilities:${JSON.stringify(cap)}};`;
  ctx.effect(() => ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "script", placement: "head", text: sessionBaselineScript });
  }), "dsh-login: capability baseline injection");
  ctx.effect(() => () => Promise.all([store.flush(), ownership.flush(), hosts.flush(), defaultWorkspaceSetting.flush(), remoteWebUiSetting.flush()]), "dsh-login: sessions + ownership + hosts + settings flush");
}
export {
  Config,
  apply,
  createRemoteIsolation,
  inject,
  name,
  wrapRemoteGateway
};
//# sourceMappingURL=index.js.map
