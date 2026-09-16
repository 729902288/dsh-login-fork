# 在这个仓库里干活（给 AI 助手的施工说明）

> 这份是**开发用的**：怎么在这个仓库里改代码、有哪些坑。
> **不进交付物**（`build.sh` 只铺 package.json + cordis.patch.yml + dist）。
> 设计依据与平台分层不在这个仓库里维护 —— 见 wiki `sources/IT/经验/aiplat.md`。

## 归属四件事

1. **运行宿主**：dsh 容器内（开发档 3091）的 dsh 插件。
2. **依赖的契约**：只依赖 dsh **宿主服务**（`webServer`、`connection`、`credentials`）；不 import dsh 内部文件。
3. **投放形态**：镜像构建时由 `build.sh` 拷进 `vendor/` 随镜像发出去（开发档用软链）。
4. **改完生效链**：改代码 → 构建 → 重建镜像 → 容器重建（三步，缺一步客户拿到的还是旧的）。

## 是什么 / 怎么跑起来

多用户登录网关：接管 web 服务器的 **fallback 位**，只把前端页面发给已登录会话；
同时接管 `/api` 载体（prefix 路由 + WS 升级），按用户分发并做归属过滤。

- 入口：`src/index.ts`（`name='dsh-login'`，`inject=['webServer','credentials']`，`apply()`）
- 子插件：`src/connection.ts` 的 `createConnectionPlugin()`（`inject=['webServer']`），
  由 index.ts 挂载 —— 这样 SessionStore / OwnershipIndex 活在本插件的 fiber 里。
- 目录：`src/` 源码；`scripts/build-client.mjs` 生成 `dist/client.js`；`tests/` vitest；
  `cordis.patch.yml` 负责插入本插件、并关掉 dsh-web-app 的 `web-runtime` 行与随包的 `connection` 行。

## 数据流（改之前先看这个）

1. `apply()` 建 SessionStore、UserStore（凭据 ref `${password}_USERS`）、
   OwnershipIndex（`<dshHome>/.dsh-login/ownership.json`）、网关配置；
2. 注册命名路由：`/login`、`/api/auth/setup|login|logout`、`/logout`、`/api/auth/me`、
   `/api/auth/admin/users[|/password|/disable|/remove]`；
3. 注册 **fallback**（网关）：未登录 GET → 302 `/login`；已登录 → 从 `distIndex` 发静态页；
4. 挂载 connection 子插件：`/api` prefix（trust 围栏 → cookie 认证 → 按用户过滤的分发）
   + `/api/events.mux`、`/api/events.host` 两条 WS 升级；卸载时把归属文件刷盘；
5. 首次使用（没有任何用户）`/login` 显示管理员初始化表单，`POST /api/auth/setup` 建强制管理员。

## 关键接法（最容易踩的）

- 网关用 `registerFallback`，**不能**用 prefix `/` —— WebServer 的 prefix 匹配会把 `/` 变成 `//`，只匹配精确的 `/`。
- `takeOverWebRuntime: true` 会重新 provide `webRuntime`（LAN 信任 + `DSH_WEB_URL` 变量），
  因为 `cordis.patch.yml` 关掉了 dsh-web-app 的 `web-runtime` 行。**两边的 fallback 同时启用会起不来。**
- 随包的 `connection` 行**必须保持关闭**：WebServer 拒绝重复注册 `/api` prefix（启动即抛）。
  关掉它同时把随包的浏览器半边从启动图里摘掉 —— 这半边的职责由本包自己的
  `dsh.client` 声明 + 构建出的 `dist/client.js` 承担。

## 坑（都踩过）

- `isUserAllowed` / `USER_ALLOWED` 的键必须和 RpcMethodMap **拼写完全一致**（例如是单数 `session.list`）；
  拼错会静默 403 掉一个正常方法。
- 关掉 `connection` 行会连带停掉它提供的 `connection` 服务 —— 没有它，Typert Remote 网关就不会注册
  共享的 `/api` 拦截器，登录后所有 UI 插件的主机 RPC（`POST /api/<namespace>/<method>`）全死。
  接管时会重新 provide（`HostConnectionService`）；两段式端点走 `createSharedFetchHandler`
  （原生、不按用户包一层；cookie 认证仍然生效；没人认领的 `a/b` 形状 404）。
- `frameVisible` 会把全局的 `host/remote-event` 推送给普通用户
  （commands/change、llm/adapters-updated 之类；没有它们 UI 插件的前端缓存会僵住），
  但 `cordis/*` 生命周期帧只给管理员。
- 升级 `@deepseek-ai/dsh-client-connection` 之后**必须重新生成 `dist/client.js`**
  （`npm run build:client`）：脚本会重打模块加载器 id 的横幅，横幅对不上会大声失败。
- Ownership sidecar 的落盘是尽力而为：内存里的 map 才是权威，文件坏了就当空的启动
  （fail-closed → 在会话被重新归属之前只剩管理员可用）。
- 老的单口令流程已经死了：`password` 这个 ref 还配着，但谁也认证不过（它只用来给 `${password}_USERS` 起命名空间）。
- `tests/runner.mjs` / `integration-runner.mjs` 早于多用户改造；以 `.spec.ts` 为准。

## 别手改

- `package-lock.json`（npm 生成）
- `dist/client.js`（`scripts/build-client.mjs` 生成）

## 环境与测试

- 测试：`npm run test`（vitest）。
- `DSH_HARNESS_CHECKOUT`：跑测试/构建客户端时用别处的 harness 检出（默认路径见 `vitest.config.ts` 里的别名）。
- `DSH_HOME`：数据目录解析用。
