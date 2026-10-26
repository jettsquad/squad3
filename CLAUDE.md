# Squad 3 — 给 agent 的工作说明

先读 [设计文档](docs/specs/2026-10-20-squad3-design.md) 和 [功能对齐清单](docs/parity.md)。

## 硬规矩

- **不改 2.x。** `J:\project\Squad` 是只读参考。移植时从那里读，写进本仓库。
- **移植要标来源。** 从 2.x 搬来的文件，头部注释写 `移植自 Squad 2.x <包>/<文件> @ <commit>`。
- **测试跟着搬。** 2.x 的测试是移植的验收标准；断言不改，只改 import 和依赖替换。
- **清单驱动。** 功能做完、在界面里真走一遍之后，才在 `docs/parity.md` 里打勾。发现清单漏了 2.x 的行为，先补进清单再做。
- **完成的定义：** `npm run check`（typecheck + test + lint）全绿。
- **不变量**见设计文档 §12，尤其：席位之间没有直接通道；没有模型坐到主持位上；绝不静默失败；能配不等于能用。

## 结构

- 主进程模块只通过各自 `index.ts` 导出的接口互相调用，eslint 拦住伸进内部文件的 import。
- 界面只通过 `window.squad` 与主进程通信；新方法 = `src/shared/wire.ts` 加一行 + 主进程加一个 handler，preload 不改。
- 源码 import 写显式 `.ts` / `.tsx` 扩展名。

## 环境

Windows 优先，macOS 第二。席位 CLI（claude、codex、dsh）在 Windows 上是 `.cmd` 包装，取消时要清理整棵进程树（设计文档 §5.3）。
