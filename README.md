# Squad 3

一张**人主持**的圆桌：多个 agent 坐在席位上，由你点名谁发言、看什么、什么时候说。

Squad 3 是独立的桌面应用。Squad 自己当宿主，Claude Code、Codex、DeepSeek Harness（dsh）都是被调用的席位。
它取代 Squad 2.x（DeepSeek Harness 的插件，仓库在 `J:\project\Squad`，继续维护、互不影响）。

## 文档

- [设计文档](docs/specs/2026-10-20-squad3-design.md)：是什么、怎么搭、怎么分期
- [功能对齐清单](docs/parity.md)：2.x 的每项功能在 3 里的对应，也是验收清单
- `docs/squad2-reference/`：2.x 设计文档的副本（不进 git，原件在 2.x 仓库）

## 开发

需要 Node ≥ 22.12 与 npm。

**走代理的机器**（环境变量里有 `HTTPS_PROXY`）：Electron 在安装时从 GitHub 下载二进制，用的是 Node 自带的 `fetch`，它默认**不读** `HTTPS_PROXY`。下载失败时 `npm install` 照样报成功，之后启动才发现 `node_modules/electron/dist` 不存在。先设 `NODE_USE_ENV_PROXY=1` 再装：

```powershell
$env:NODE_USE_ENV_PROXY = "1"; npm install
```

已经装过但缺二进制时，补一次：`node node_modules/electron/install.js`（同样带上这个变量）。

```sh
npm install
npm run dev        # 开发模式启动
npm run check      # typecheck + test + lint，全绿才算完成
npm run build      # 构建到 out/
```

## 目录

```
src/
  shared/      纯函数与 IPC 契约（wire.ts），主进程和界面都用
  main/        Electron 主进程：各模块（table、context、secretary、reasoning、
               library、store、vault、seats、extras）与 ipc 分发
  preload/     唯一的桥：window.squad.invoke / on
  renderer/    React 界面
test/          vitest
```
