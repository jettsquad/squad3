# Squad 3 · 功能对齐清单（2.x → 3）

**日期：** 2026-10-20
**上游：** [设计文档 §10](specs/2026-10-20-squad3-design.md)
**用途：** 这是 Squad 3 的**验收清单**。D4 定了「2.x 的全部功能都要有」，这张表把它拆成逐条可勾选的项。一项打勾的条件是：**在 3 的界面里真走一遍做到了**，不是「代码写了」。
**来源：** 2.x 仓库 `J:\project\Squad`（`packages/console/src/client/api.ts` 的方法表、`packages/console/src/index.ts` 的斜杠命令、各包源码与测试）。

**列的含义**

- **2.x 出处**：在 2.x 里由哪里实现，移植时去哪看
- **3 模块**：设计文档 §4 的模块名
- **期**：设计文档 §13 的分期
- 勾选框 `[ ]` 只在验收通过时改成 `[x]`

> 本清单在阶段 0 从代码盘点得出。移植过程中如果发现 2.x 还有没列进来的行为，**补进本表再做**，不要做了不记。

---

## A. 团队

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 建团：起名、选项目文件夹（系统对话框）、从 Agent 库勾成员（2026-10-20 实测） | `api.createTeam`、`client/create.tsx`、`client/folder-picker.tsx` | table + 界面 | 1（最小）/ 3（完整） |
| [ ] | 建团时项目文件夹必须存在且是目录，否则拒 | 席位配置 §8.3 | table | 1 |
| [ ] | 项目文件夹存规范形式（realpath） | 席位配置 §8.2 | table | 1 |
| [x] | 建团时指定秘书：只能从「可当秘书」的成员里单选；第一个候选自动指派（2026-10-20 实测） | 席位配置 §7.7，`table/roster.ts` | table + 界面 | 3 |
| [ ] | 名册校验：重名、空名册、两个秘书都拒，报错落在对应字段下（重名被拒 2026-10-20 已实测；「落在对应字段下」未做，报错在面板底部） | `checkRoster`、`checkTeamDraft` | table | 3 |
| [x] | 团队改名（2026-10-20 实测） | `api.renameTeam` | table | 3 |
| [x] | 团队排序（上移 / 下移）（2026-10-20 实测） | `api.moveTeam` | table | 3 |
| [x] | 解散团队：先确认，说明哪些记录会留下（2026-10-20 实测：重启后不再出现，记录留在磁盘） | `api.disbandTeam`，席位配置 §7.14 | table | 3 |
| [x] | 团队持久化，重启后恢复（含讨论、用量）（2026-10-20 实测：重启后讨论与 2 轮用量都在） | 席位配置 §10.1 | store + table | 1 |
| [ ] | 恢复失败的团队报出来再跳过，不静默丢弃 | 席位配置 §10.1 | table | 2 |
| [ ] | 团队状态一句话（谁在做什么 / 议程第几阶段 / 空闲）（谁在做什么、空闲 2026-10-20 已实测；议程阶段随阶段 4） | `team-view.tsx` 的 `statusLine` | 界面 | 3 |

## B. 席位

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [ ] | 加席位（从模板或手填名字、角色）（从模板 2026-10-20 已实测；手填只有接口，界面没有） | `api.addSeat` | table | 3 |
| [x] | 删席位；删秘书需二次确认（2026-10-20 实测） | `api.removeSeat` | table | 3 |
| [ ] | 改席位的连接与上限（caps）（上限 2026-10-20 已实测：轮数上限 1，第二轮不起子进程、记录里说明原因；改连接未走） | `api.patchSeat`、`client/caps.tsx` | table | 3 |
| [x] | caps 随认证方式变：订阅只给轮数上限，api-key 才给成本上限（2026-10-20 实测） | `meaningfulCaps`，席位配置 §1.4 | shared + 界面 | 3 |
| [x] | 席位重新关联到 Agent 库模板并同步设置（2026-10-20 实测） | `api.relinkSeat`、`seat-sync.ts` | table | 3 |
| [ ] | 名册漂移检测（议程确认后名册变了，按名字说出来）（已做、有测试；未在界面走） | `roster-drift.ts` | table | 3 |
| [x] | 席位条：色标、★秘书、名字、角色、连接名、权限模式（2026-10-20 实测） | `team-view.tsx` 的 `Roster` | 界面 | 3 |
| [ ] | 席位状态：工作中（悬停看本轮指令）/ 待命 / 警告及原因（「工作中 · 已输出 N 字」「排队 N 条」「待命 · 续接会话」2026-10-20 已实测；「警告及原因」待 2c） | `seat-status.ts`，席位配置 §16.3 | table + 界面 | 2 |
| [ ] | 沉默看门狗（首字节线、静默线），卡住时可见可停 | `seat-runtime/silence.ts`，席位配置 §10.4 | seats | 2 |
| [x] | Claude Code 席位：命令行 + stream-json，prompt 走标准输入，工具围栏默认禁委派，`--append-system-prompt` 传 persona（2026-10-20 实测） | `seat-claude-code` | seats | 1 |
| [x] | Codex 席位：`codex exec --json`，prompt 走标准输入（`-`），续接走 `exec resume`，权限模式三档（2026-10-20 实测：真实作答并上报用量） | `seat-codex` | seats | 2 |
| [ ] | dsh 席位：`dsh --profile headless -` + 一次性补丁 + 心跳插件 + 委派围栏（2026-10-20 实测：进程、补丁、心跳过滤、失败原因都通；本机 dsh 缺 DeepSeek key，尚未真正答出一句） | `seat-dsh` | seats | 2 |
| [ ] | dsh 席位心跳 | `seat-dsh/heartbeat.ts` | seats | 2 |
| [x] | 席位活动：正在用什么工具（2026-10-20 实测：Claude 显示「PowerShell：…」，Codex 显示实际命令；Windows 的 powershell 外壳已剥掉） | `seat-runtime/activity.ts`、各后端 `doing.ts` | seats | 2 |
| [ ] | 每席位用量（token、缓存、费用） | `seat-spend.tsx`、`shared/seat-usage.ts` | table | 2 |
| [ ] | 席位会话续接：同一席位下一轮 `--resume` 上一轮的 CLI 会话，省掉常驻前缀的建缓存费用；续接被拒时丢掉 id 重跑；续接时窗口只带新增部分（阶段 0 盘点时漏掉，阶段 1 移植 argv 时发现） | `seat-runtime/sessions.ts`、`table` 的 `resumeIdFor` / `windowForSeat` | seats + context | 2 |

## C. 斜杠命令（11 条）

在 3 里是输入框命令，走 IPC 方法表（设计文档 §9）。

| ✓ | 命令 | 作用 | 期 |
|---|---|---|---|
| [ ] | `/squad-new 团队名 \| 项目文件夹 \| 甲*=角色, 乙=角色` | 建团，`*` 标秘书 | 3 |
| [x] | `/squad-design [文件夹]`（2026-10-21 实测） | 建组队团队；留空则给当前团队放一份组队议程 | 4 |
| [x] | `/squad-build 文件夹`（答复带到新团队上显示，红队风险不丢）（2026-10-21 实测） | 把当前团队设计出的方案建成真团队 | 4 |
| [ ] | `/squad-teams [teamId]` | 列出团队 / 切换当前团队 | 3 |
| [x] | `/squad-say [甲,乙:] 指令`（2026-10-20 实测：「柯德克斯: …」只问了 Codex） | 发指令，可只问部分席位 | 2 |
| [x] | `/squad-record`（2026-10-20 实测，结果不进记录） | 看团队记录 | 2 |
| [x] | `/squad-window [席位名]`（2026-10-20 实测，结果不进记录） | 看某席位这一轮会看到什么 | 2 |
| [ ] | `/squad-fold` | 立即折叠一次 | 2 |
| [x] | `/squad-criteria` | 看判据与待裁定 | 4 |
| [x] | `/squad-accept <id>` | 采纳判据 | 4 |
| [x] | `/squad-reject <id>`（2026-10-21 实测） | 否掉判据 | 4 |

## D. 发言与讨论

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 发一条指令给全员（2026-10-20 实测：真实 claude 席位两轮作答） | `api.say` | table | 1 |
| [x] | `@` 点名：句中任何位置的 @名字 都算点名、只去掉开头的点名、名字有边界、打错名字即拒（2.x 最新规则；2026-10-20 实测「@甲 …」只问甲，打错即拒由单测覆盖） | `mention.ts`，席位配置 §8.8 | 界面 + table | 2 |
| [ ] | `@` 点名候选菜单 | `mention-picker` 测试 | 界面 | 3 |
| [x] | 引用旧发言（勾选后随下一条发出）（2026-10-20 实测：席位收到的提示词里有「主持人特别指出的几段」） | `api.select` kind=quote、`shared/quotes.ts` | table + 界面 | 3 |
| [x] | 附材料随下一条发出（2026-10-20 实测：两个席位都按 PDF、Markdown、图片答对；发出后勾选清空） | `api.select` kind=material | table + 界面 | 3 |
| [x] | 独立作答（本阶段开始时的快照，测试覆盖） / 累积（串行，2026-10-20 实测）——2.x 已把它移到议程阶段的 `contextMode`，随议程做 | 技术设计 §6.1、`agenda.ts` | table | 4 |
| [x] | 取消一条指令，或在任何席位开始前撤回（2026-10-20 实测：指令栏「叫停」1.5 秒停下、无残留进程；撤回由单测覆盖） | `api.cancelCommand` | table | 2 |
| [x] | 重发被中断的指令（2026-10-20 实测：运行中关掉 Squad，重启后显示「中断」并可重发） | `api.resendCommand` | table | 2 |
| [ ] | 叫停：有议程停议程，没议程停当前一轮；被叫停的席位自己说明（「没议程停当前一轮」与「自己说明」2026-10-20 已实测：1.1 秒停下，进程树清理干净；议程部分待阶段 4） | `api.stop`，席位配置 §8.6 | table | 2 |
| [x] | 指令队列（取代 2.x 早期的「一桌只跑一轮」守卫）：不同席位并行，同一席位按发出顺序一条条答（2026-10-20 实测两席位并行；顺序由单测覆盖） | `table/commands.ts` | table | 2 |
| [ ] | 输入框按下即清空，失败时放回原文 | 席位配置 §10.3 | 界面 | 2 |
| [ ] | 席位失败时说明原因：解析器所知 → stderr 末几行 → 退出码；被信号杀与非零退出区分 | `shared/seat-failure.ts`，席位配置 §9.9 | seats | 2 |
| [ ] | think 内容不进记录、不进任何人的上下文 | 需求 C8，`agent-reply-text.ts` | seats + table | 1 |
| [x] | 讨论记录：Markdown（GFM 表格、代码高亮与复制、KaTeX）、发言人色标（2026-10-20 实测） | `client/discussion.tsx`，席位配置 §15 | 界面 | 3 |
| [x] | 每条回复显示「带了几行讨论」（2026-10-20 实测：第一轮 0 行，第二轮 2 行，第三轮 4 行） | `SeatReply.contextLines` | table + 界面 | 2 |
| [x] | 向前翻页加载更早的记录（2026-10-20 实测：173 条，先给最新 150 条，「看更早的」补齐） | `api.earlierLines` | table + 界面 | 3 |
| [x] | 最后一条不被输入框挡住（2026-10-20 实测） | 席位配置 §15.3 | 界面 | 3 |
| [x] | 秘书单次协助：产出是草稿，不是一轮（2026-10-20 实测：草稿出来、记录没变、可放进输入框） | `api.assist`、`secretary/assist.ts` | secretary | 3 |

## E. 上下文与折叠

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 窗口切片：有检查点从 `coversUpTo` 之后，无则全部（2026-10-20 实测：折叠后窗口只剩检查点 1 行） | `context/window.ts` | context | 2 |
| [x] | 时间线：渲染 / 故意不渲染，未知类型抛错（「禁止」表随主持人节点一起消失，见 context/timeline.ts 头注） | `context/timeline.ts` | context | 2 |
| [ ] | 引用穿透：被引用的旧发言并入窗口并标记 | `context/merge.ts` | context | 2 |
| [x] | 每席位的尾部窗口（2026-10-20 实测：续接的甲只拿到乙的 1 行新发言） | `tail-for-seat` 测试 | context | 2 |
| [x] | 折叠进度（累计 / 上限，CJK 逐字计）（2026-10-20 实测：面板显示，折叠后归零、作废后复原） | `team-checkpoint-threshold.ts` | context + 界面 | 2 |
| [ ] | 自动折叠：不阻塞、只在无人工作时开始、`coversUpTo` 开始时钉死 | `context/plan.ts` | context | 2 |
| [x] | 手动折叠（2026-10-20 实测：秘书乙 15 秒写完，席位会话随之丢弃） | `api.fold` | context | 2 |
| [x] | 作废检查点（说明原文会重新进入上下文）（2026-10-20 实测：作废后下一轮带回全部 8 行） | `api.revokeCheckpoint` | context | 2 |
| [x] | 检查点四个固定标题，缺一即拒；分歧不压成共识（2026-10-20 实测：真实检查点四节齐全、两种立场分列） | `secretary/checkpoint.ts` | secretary | 2 |
| [ ] | 折叠阈值系数按团队设置（接口与界面已做，界面未走） | 需求 C6 | context | 3 |
| [ ] | 上下文面板：进度、次数、当前检查点正文、两个动作 | `client/context-panel.tsx` | 界面 | 3 |
| [x] | **新增**：每回合发给席位的完整 prompt 写进日志（设计文档 §6.3）（2026-10-20 实测：界面「看它这一轮拿到了什么」从日志读出原文） | — | store + table | 1 |

## F. 议程

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [ ] | 秘书起草议程（阶段、任务、执行者、独立/累积、产出路径、出口检查）（接口 agenda.draft 已做；界面按 2.x 走「在对话里问秘书 → 转成议程」，没有单独入口） | `api.draftAgenda`、`secretary/agenda.ts` | secretary | 4 |
| [x] | 从秘书的某条回复转成议程（2026-10-20 实测） | `api.agendaFromReply` | secretary | 4 |
| [x] | 草案卡片：逐项可改，确认 / 丢弃（2026-10-20 实测；3 的草案存在 team.json 里，2.x 后来也改成了落盘） | `client/draft-card.tsx`、`plan-card.tsx`，席位配置 §13 | table + 界面 | 4 |
| [x] | 确认前后各校验一次名册；议程指纹与修订号（2026-10-20 实测） | `agenda-identity.ts`、`agenda-check.ts` | table | 4 |
| [x] | 议程编辑合法性（测试覆盖） | `agenda-verdict.ts` | table | 4 |
| [x] | 状态机：`needs` 依赖、一次跑一个节点、出口检查命令（超时、只留输出末尾）、重试带检查输出（2026-10-20 实测；2026-10-21 跟 2.x 8e96d9c 改成本机 shell 后再测：Windows 上秘书写 PowerShell 检查，Squad 用 PowerShell 跑通过） | `shared/agenda-machine.ts`，议程图 §2 | table | 4 |
| [x] | 节点状态：pending / running / checking / retrying / deciding / passed / unresolved / skipped（2026-10-20 实测） | 同上 | table + 界面 | 4 |
| [x] | 席位自报【结果】行解析（2026-10-20 实测：Codex 报「被卡住：出口检查配置错误」，议程停下等决定） | 议程图 §2.5 | table | 4 |
| [x] | 决策卡片四个动作：重做（附指示）/ 点人清障 / 视为通过 / 放弃（「视为通过」2026-10-20 实测；其余测试覆盖） | `api.decideNode` | table + 界面 | 4 |
| [x] | 退回到某阶段之前（不自动开始）（2026-10-20 实测） | `api.rewindAgenda` | table | 4 |
| [x] | 续跑被停止、暂停或被重启打断的议程（2026-10-20 实测） | `api.resumeAgenda`、`table/reopen.ts` | table | 4 |
| [x] | 放弃议程（2026-10-20 实测） | `api.abandonAgenda` | table | 4 |
| [x] | 议程中断时产出终止交接文档（2026-10-20 实测：秘书写进 .squad/reports/；2.x 有实现没接线） | `secretary/termination.ts` | secretary | 4 |
| [ ] | 产出文件由程序写入：原文一字不差、路径不冲突、不跳出项目文件夹、失败明确报错（已接线、有共享测试；带 artifactPath 的议程未在界面走） | `shared/team-artifact.ts`，需求 O1–O4 | table | 4 |
| [x] | 议程消息在讨论区的渲染（测试覆盖 agendaInText；界面里议程步骤显示为「（阶段）指令」） | `client/agenda-message.tsx`、`agenda-text.ts` | 界面 | 4 |
| [x] | 议程侧栏：每个节点的状态、次数、最近一次检查输出（2026-10-20 实测） | `client/agenda.tsx` | 界面 | 4 |

## G. Lil X 代理与验收

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 确认议程时的「由 Lil X 代理」开关（2026-10-21 实测） | `api.resolveAgenda` 的 `proxy` | table | 4 |
| [x] | 代理的四种动作：重做 / 清障 / 代答 / 定方案（与席位讨论一轮）（实测走到的是「放下」并写进报告；四种动作由 `table-agenda-run`、`reasoning-proxy` 测试覆盖） | 议程图 §3.2，`reasoning/proxy` | reasoning | 4 |
| [x] | 每节点决策上限 3，用完记 unresolved（测试覆盖；实测里 Lil X 第一次就放下了） | 议程图 §3.5 | table | 4 |
| — | 验收基线：追溯表路径、验收人（2.x 代码里没有：出自 2.x 议程图设计文档，2.x 的完成报告明说「需求是否满足不在这里」。不算对齐缺口，留给以后单独立项） | 议程图 §3.8 | table | 4 |
| — | 证据由 Squad 跑（`run_evidence.py`），验收人复核【证据不足】（2.x 代码里没有：出自 2.x 议程图设计文档，2.x 的完成报告明说「需求是否满足不在这里」。不算对齐缺口，留给以后单独立项） | 议程图 §3.8 | table | 4 |
| — | 未满足的需求变成补做节点（2.x 代码里没有：出自 2.x 议程图设计文档，2.x 的完成报告明说「需求是否满足不在这里」。不算对齐缺口，留给以后单独立项） | 议程图 §3.6、§3.8 | table + reasoning | 4 |
| [x] | 程序汇编完成报告，写入 `<项目>/.squad/reports/` 并在讨论里发一条（2026-10-21 实测） | 议程图 §3.8 | table | 4 |
| [x] | Lil X 的每个决定以「Lil X（代主持人）」名义出现在讨论里（3 里是「Lil X（代{主持人名}）」；（2026-10-21 实测）） | 议程图 §3.3 | table | 4 |

## H. Lil X 判据库

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 把某条发言标记为判据来源 → 提炼出主张（另：改过的草案确认时自动记一次否决，出口检查和换席位也算改动；议程替你发的指令上没有「记下来」）（2026-10-21 实测） | `api.markCriterion`、`reasoning/distil.ts` | reasoning | 4 |
| [x] | 待裁定队列：主张、边界、触发条件、证据条数；采纳 / 否掉（3 里采纳前可以改措辞和边界）（2026-10-21 实测） | `api.resolveCriterion`、`client/criteria.tsx` | reasoning + 界面 | 4 |
| [x] | 已生效判据退役 / 恢复（2026-10-21 实测） | `api.setCriterionStatus` | reasoning | 4 |
| [x] | 三个刻度的健康度（2026-10-21 实测） | `reasoning/usage.ts`、`status` 测试 | reasoning | 4 |
| [ ] | 按处境召回与投放（只投给主持人节点 / 代理，不进席位） | `reasoning/activation.ts`、`deliver.ts` | reasoning | 4 |
| [x] | 去情景化（抽象可导出，实例永不外流）（2.x 只有服务层、没有界面——smoke 和测试调用；3 同样移植了服务与测试） | `reasoning/decontextualise.ts` | reasoning | 4 |
| [x] | 共享池（2.x 只有服务层、没有界面——smoke 和测试调用；3 同样移植了服务与测试） | `reasoning/pool.ts` | reasoning | 4 |
| [ ] | 提炼所用连接可在设置里选 | `api.saveSettings` 的 `distilConnectionId` | library | 4 |
| [x] | 判据库存在用户选的目录，纯文本可 git 管（2026-10-21 实测） | `reasoning/store.ts` | reasoning | 4 |
| [x] | 证据只显示条数，不显示实例（2026-10-21 实测） | 席位配置 §7.10 | 界面 | 4 |

## I. 组队团队

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 一键建组队团队：5 席 + 5 阶段种子议程（种子本身是一份 TeamPlan）（新建团队页上一个文件夹框；实跑第一阶段：需求澄清先问目标再停下）（2026-10-21 实测） | `console/team-designer.ts` | table + library | 4 |
| [x] | 给已有团队放一份组队议程（组队团队侧栏，3 没有「场次」，直接放在这支团队上）（2026-10-21 实测） | `api.designerAgenda` | table | 4 |
| [x] | 从秘书回复预览 TeamPlan（回复本身渲染成可读的方案，原始 JSON 折叠）（2026-10-21 实测） | `api.previewTeamPlan` | table | 4 |
| [x] | `checkTeamPlan` 一次报全部问题，每条点名哪一项（读不成方案的回复下面照实说为什么，并可一键发回秘书）（2026-10-21 实测） | `shared/team-plan.ts` | shared | 4 |
| [x] | 带意见让秘书重拟（这条请求在记录里标「程序代发」，不算主持人的话，Lil X 不从它学）（2026-10-21 实测） | `api.redraftTeamPlan` | table | 4 |
| [x] | 用当前种子刷新组队团队的席位提示词（2026-10-21 实测） | `api.refreshDesigner` | table | 4 |
| [x] | 实例化：先模板后建团、不覆盖已有模板（同名加后缀）、首场议程落成草案、部分成功照实说（另：已有团队住的文件夹拒收并点名；部分成功由测试覆盖）（2026-10-21 实测） | `api.buildTeamPlan`，组队团队 §4 | table + library | 4 |
| [x] | 确认页逐项可改（2.x 没做完，组队团队 §8 列为差距）（团队名、每席的名字/角色/后端/联网/提示词；改过的整份重查）（2026-10-21 实测） | — | 界面 | 4 |

## J. Agent 库

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 增删改，软删除（2026-10-20 实测） | `api.saveAgent` / `removeAgent`、`client/agents.tsx` | library | 3 |
| [x] | 排序（2026-10-20 实测） | `api.moveAgent` | library | 3 |
| [x] | 字段：名字、角色、提示词、颜色、能否当秘书、后端、连接、权限模式、上限、推理强度、联网（2026-10-20 实测） | `shared/agent-template.ts` | library | 3 |
| [ ] | 表单里只列同后端的连接；换后端时清掉不匹配的选择；保存时拒不一致 | 席位配置 §9.6 | library + 界面 | 3 |
| [x] | 测试：5 项（后端就绪、命令行工具、密钥、地址可达、真的问一句），结论三值，`skipped` 与 `unknown` 分开（2026-10-20 实测：claude、codex 全过；dsh 找到了，真问一句报 MISSING_CREDENTIAL） | `api.testAgent`、`shared/agent-check.ts` | seats | 3 |
| [x] | 联网能力按后端如实说明（codex 上不了网）（2026-10-20 实测） | `webAccessNote`，组队团队 §3.3 | seats + 界面 | 3 |

## K. 连接与凭据

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 增删改；编辑保留 id（2026-10-20 实测） | `api.saveConnection` / `removeConnection`、`client/connections.tsx` | library | 3 |
| [x] | 认证方式：订阅 / api-key；端点只在 api-key 下出现（2026-10-20 实测） | 席位配置 §7.1 | library | 3 |
| [ ] | 订阅模式下模型名限制在后端自家命名空间，保存前提示 | `shared/connection.ts`，席位配置 §1.3 | shared | 3 |
| [ ] | 按后端注入的环境变量：claude-code 三样 / codex `CODEX_API_KEY` / dsh `DEEPSEEK_API_KEY` | 席位配置 §9.2 | seats | 2 |
| [ ] | token 头选项：`ANTHROPIC_API_KEY`（x-api-key）或 `ANTHROPIC_AUTH_TOKEN`（Bearer） | 席位配置 §14.2 | library + seats | 3 |
| [ ] | 密钥只显示已配置 / 未配置，值不进界面；编辑时空框表示不动（「已配置」徽标与 DPAPI 加密落盘 2026-10-20 已实测；编辑未走） | 席位配置 §9.8 | vault | 3 |
| [ ] | 「这把 key 已经在环境变量里了」：填变量名不存值 | 席位配置 §7.6 | vault | 3 |
| [ ] | 被只读来源占住的名字直说「这里改不了」 | `credentialWritable` | vault | 3 |

## L. 提示词片段

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 片段增删改（2026-10-20 实测） | `api.saveBlock` / `removeBlock`、`client/blocks.tsx` | library | 3 |
| [ ] | 片段排序 | `api.reorderBlocks` | library | 3 |
| [x] | 团队共享提示词：片段、全员选择、分组（2026-10-20 实测：全员片段进了席位提示词，席位照做；集合未在界面走） | `api.setTeamPrompts`、`client/team-prompts.tsx` | library + table | 3 |
| [ ] | 提示词集合校验 | `checkPromptSet`、`shared/prompt-blocks.ts` | shared | 3 |

## M. 材料

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [ ] | 上传文档：PDF（pdf-parse）、Word（mammoth）解析成文本，有大小上限（PDF、Markdown 经同一条主进程路径 2026-10-20 已实测；系统文件对话框和 .docx 未在界面走） | `api.addMaterial`、`console/extract.ts` | extras | 3 |
| [x] | 图片存进项目文件夹，按路径交给席位（2026-10-20 实测：存进 squad-images，席位读图答对颜色） | `console/image.ts`、`shared/local-media.ts` | extras | 3 |
| [x] | 在面板里预览项目文件夹里的图片（2026-10-20 实测：squad-media 协议，资料面板和记录里都显示） | `api.fileUrl` | extras + 界面 | 3 |
| [ ] | 置顶 / 取消置顶 | `api.pinMaterial` | table | 3 |
| [x] | 删除（2026-10-20 实测） | `api.removeMaterial` | table | 3 |
| [ ] | 材料进席位提示词的格式 | `material-prompt` 测试、`shared/material.ts` | table | 3 |

## N. 朗读与听写

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 朗读：按连接与声音合成，可调语速（2026-10-21 实测，对着本机的替身服务：MiniMax 形状的 t2a_v2；真实 MiniMax 账号未走）；Agent 库里选声音、试听 | `api.speak`、`console/tts.ts`、`shared/voices.ts` | extras | 5 |
| [x] | 朗读没设置好时 ▶ 念 仍可点，点了说明缺什么并给「去设置」；设置里没填密钥的连接标「（密钥未配置）」，选中这种连接时提示去「连接」填（2026-10-22 实测；原先按钮是灰的、原因只在悬停提示里，被当成「没有朗读功能」） | `Voice.tsx`、`SettingsPage.tsx` | 界面 | 5 |
| [x] | 可读文本切分（测试覆盖，随朗读一起走） | `shared/speakable.ts` | shared | 5 |
| [x] | 听写栏（2.x 的 ListenBar 是朗读设置：连接与语速；3 挪进设置页、存进设置）（2026-10-21 实测） | `client/listen.tsx` | 界面 | 5 |
| [x] | 语音停顿检测（即朗读的暂停/继续状态机：测试覆盖；界面里有 ⏸ / ▶ / ■，长回复的暂停未在界面走） | `speech-pause` 测试、`client/speech.ts` | 界面 | 5 |
| [x] | 听写输入：**换实现**，走连接库里的语音转文字服务（设计文档 Q3）（2026-10-21 实测：本机替身服务 + Chromium 假麦克风，录音送出、文字填进输入框不发送；真实服务商未走） | `client/dictate.tsx`（Web Speech，Electron 下不可用） | extras | 1 实测 / 5 实现 |

## O. 通知与在场

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 议程或长轮次结束时系统通知（Windows / macOS）（2026-10-21 实测：Windows 上一轮答完，Electron 报告通知已弹出；从源码跑时 Windows 要求开始菜单里有带 AppUserModelID 的快捷方式，安装包在阶段 6 建；点通知回到那支团队未在界面走） | `console/notify.ts` | extras | 5 |
| [x] | 窗口在前台时不发通知（3 由主进程直接问窗口，不靠页面报在场；2026-10-21 实测发现 Electron 把最小化的窗口报成「有焦点」，改成最小化或隐藏都算不在前台） | `api.reportPresence`、`client/presence.tsx` | extras | 5 |
| [x] | 完成通知开关（2026-10-21 实测：设置页开关两向都存得下） | `api.saveSettings` 的 `notifyOnFinish` | library | 5 |
| [ ] | 安静状态检测（已接上：秘书判断、记录与审计、「请你看」弹通知；测试覆盖。界面未走——要一条十几分钟不出声的命令） | `console/quiet-watch.ts`、`secretary/quiet.ts` | table | 5 |

## P. 后端工具

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [x] | 显示 claude / codex / dsh 已装版本、最新版本、升级方式（2026-10-21 实测：Claude Code 2.1.305 有新版 2.1.306、Codex 与 dsh 已是最新；Windows 上从 npm 的 .cmd 包装认出 npm 安装） | `api.tools`、`console/backend-tools.ts` | extras | 5 |
| [ ] | 一键升级，并验证升级后还能跑（已做、有测试；界面里点到「确认升级」就停——它会改你机器上正在用的 CLI，留给你自己点） | `api.upgradeTool` | extras | 5 |
| [x] | 下载 MCP 与工具（2026-10-21 实测：允许联网的 Claude Code 席位用 WebFetch 取页面、用下载工具把 PDF 存进 squad-downloads/；顺带修了 3 的 Claude 适配器从没把 WebFetch/WebSearch 预先批准的漏洞） | `seat-runtime/download*.ts` | seats | 5 |
| [ ] | skill 交付：`~/.agents/skills/`，Claude Code 经 `--plugin-dir`（已接上，单测通过；本机没有共享 skill 目录，未实测） | `seat-claude-code/skills-plugin.ts` | seats | 2 |

## Q. 用量、审计、设置、其它

| ✓ | 功能 | 2.x 出处 | 3 模块 | 期 |
|---|---|---|---|---|
| [ ] | 团队用量一行（各列由 `usage-figures` 定义），每轮写盘（「每轮写盘」2026-10-20 已实测；`usage-figures` 的列定义待移植） | `client/usage-figures.ts` | table + 界面 | 2 |
| [x] | 审计日志与面板（2026-10-20 实测） | `table/audit.ts`、`client/audit.tsx` | table + 界面 | 3 |
| [x] | 建团来源写进审计（含 TeamPlan 指纹；2.x 没做完）（改过的写两个指纹）（2026-10-21 实测） | 组队团队 §8 | table | 4 |
| [ ] | 导出（每条指令结束后写 .squad/discussions/<teamId>.md；测试覆盖，界面里只有一句说明） | `table/export.ts` | table | 3 |
| [x] | 项目记忆（2026-10-20 实测；2026-10-21 跟 2.x 改成 Squad 只建最小模板、记录里说一句） | `secretary/project-memory.ts`、`shared/project-memory.ts` | secretary | 3 |
| [x] | 设置：主持人名称（2026-10-20 实测） | `api.saveSettings`、`client/me.tsx` | library | 3 |
| [x] | 界面中英两套词典（2026-10-20 实测：设置里切英文，各页面无报错；斜杠命令的回显仍是中文） | `client/locale.ts`、`locales.ts` | 界面 | 3 |
| [x] | 推理强度选项（2026-10-20 实测） | `shared/reasoning-effort.ts`、`seat-runtime/effort.ts` | seats | 3 |
| [ ] | 数字输入框行为 | `number-field` 测试 | 界面 | 3 |

## R. 3 新增（不是 2.x 的功能，但设计文档要求）

| ✓ | 功能 | 设计文档 | 期 |
|---|---|---|---|
| [x] | 桌面窗口，不需要浏览器（2026-10-20 实测：窗口打开，IPC 往返通，渲染进程无 Node） | §3 | 1 |
| [x] | 单实例：第二次启动聚焦已有窗口（2026-10-20 实测：第二个进程以 0 退出，第一个仍在） | §6.1 | 1 |
| [x] | 启动画面：找到各后端 CLI、拿到锁、恢复团队（2026-10-21 实测：一切正常时自己让开；把 dsh 路径改坏后停住、说明原因，点「知道了」进去） | 草图 3 | 5 |
| [ ] | 托盘菜单：打开主窗口、暂停所有席位、打开数据目录、退出（已做；「叫停所有席位」走的同一段代码实测过；托盘图标在 Windows 默认收在 ^ 里，菜单本身要在桌面上点，未走） | 草图 3 | 5 |
| [x] | 关闭行为：退出时中止所有正在跑的席位并清理进程树（2026-10-20 实测：0 残留；被打断的指令记为「中断」而不是「叫停」） | §5.3 | 2 |
| [x] | 设置里填 dsh 的位置（dsh 常不在 PATH 上）；每轮开跑时读，Agent 测试按同一路径找（2026-10-20 实测：填 bin.js 后测试找到 dsh） | §16（阶段 3a） | 3 |
| [x] | 密钥用系统加密（Windows DPAPI / macOS 钥匙串）存本机；加密不可用时拒存而不明文落盘（2026-10-20 实测：vault.json 里只有名字和密文；删连接时密钥一起删） | §7 | 3 |
| [x] | 从 2.x 导入数据：试运行、按团队拒绝、回读、保留 turnId 与作废状态（2026-10-21 实测：本机 ~/.dsh 试运行 5 支团队无拒绝，真导入 5 支、读回通过、重启后都在、再跑一次全是「已经在 3 里」；导入前后 2.x 的 51 个文件一个字节没变） | §11 | 6 |
| [x] | Windows 安装包（2026-10-21 实测：装到自选目录（`/S /D=<目录>` 静默安装），开始菜单和桌面快捷方式带应用 id com.squad.desktop，「应用和功能」里有卸载项；装好的程序能跑、托盘图标出现。系统通知：Windows 在把新快捷方式登记进应用列表之前会静默丢掉它的通知；2026-10-22 改成安装时把应用 id 写进 HKCU\Software\Classes\AppUserModelId（卸载时删），重装后实测：最小化窗口跑一轮，弹出「3c验证 · 这一轮完成了」；通知标题栏显示的是应用 id 而不是「Squad」；没有代码签名） | §13 | 6 |
| [x] | 外观：跟随系统 / 浅色 / 暗色（暗色是暖黑底加琥珀色强调；窗口标题栏跟着变）（2026-10-22 实测：设置里两向切换，页面与标题栏都跟着变） | 用户反馈 2026-10-22 | 6 |
| [x] | 一支团队下开多场会话（2.x 的「场次」）：名册、项目文件夹、提示词、资料、团队名、折叠阈值全队共用，改哪一场都同步到其他场；讨论记录、用量、CLI 会话、议程、折叠各场各算；任何一场在跑时不能改名册；左栏「团队 → 会话」两层，「＋ 新会话」、给这场起名、关掉这场（最后一场不能关，整队用「解散」）；2.x 场次导入后归到所属团队下，之前已作为单独团队导入的场次在启动时归回一次并记一条（2026-10-22 实测：本机两支从 2.x 导入的团队分别归回 3 场、2 场；在 3c验证 上点「＋ 新会话」，新会话讨论为空、成员和资料相同，起名、关掉都对） | 用户反馈 2026-10-22；2.x `table/sitting.ts` | 6 |
| [x] | 归档与删除：「解散」改叫「归档」，「关掉这场」改叫「归档这场」；左栏「🗄 归档」页列出归档的团队（连同一起归档的各场）和团队还在用时单独归档的会话，可以恢复或永久删除；删除只在归档页里，先问一句，只删 Squad 数据目录里的那份，项目文件夹不动；恢复一场会话时带上团队现在的名册等共用设置；恢复整队只带回跟它一起归档的场次；归档一场后其他场的编号不变（2026-10-22 实测：3c验证 开新会话→归档这场→归档页里出现→恢复→回到左栏并打开；永久删除只在单测里走，界面上留给你点） | 用户反馈 2026-10-22 | 6 |
| [x] | 窗口整体不滚动，各栏各自滚；左栏团队名过长时截断加「…」，悬停看全名（2026-10-22 实测：窗口缩到 1000×620，只剩各栏自己的滚动条，左栏不再横向溢出） | 用户反馈 2026-10-22 | 6 |
| [ ] | macOS 安装包（配置已写好：dmg、麦克风用途说明；要在 Mac 上跑 `npm run dist:mac`，Windows 上出不了 dmg） | §13、Q4 | 6 |

---

## S. 不移植的 2.x 功能

它们只为适配 dsh 而存在，3 里没有对应的问题，不算功能缺失。

| 2.x | 原因 |
|---|---|
| `client/use-sitting.ts`、`client/team-sessions.ts`（场次与 dsh 会话的对应） | dsh 会话；场次本身已作为「会话」做回来，见 §R |
| 团队进入 dsh Workspaces、`client/land-on-team.ts` | dsh 侧栏 |
| 接管 dsh 输入框（`conversation.composer` chain slot） | dsh 插槽 |
| `api.browse`（逐级浏览目录） | 3 直接用系统对话框 |
| `scripts/link-dsh.mjs`、`switch-dsh.mjs`、`try-dsh.mjs`、`install-profile.mjs`、`ui.mjs` | dsh profile 与启动 |
| `packages/conn-probe`、`packages/smoke` | dsh 组合的探针与冒烟 |
| 客户端构建的纯度闸与平台表漂移闸 | dsh 客户端模块体系 |
| `bundle/`（`@jettsquad/roundtable` 包与 `cordis.patch.yml`） | dsh 插件分发 |

---

## T. 测试移植清单

2.x 有 91 个测试文件。处理方式：

- **原样**：纯函数测试，改 import 路径即可，断言不改
- **改写**：测试的行为要保留，但依赖了 dsh 的类型或服务，要换成 3 的对应物
- **不移植**：被测的东西在 3 里不存在（见 §S）

| 包 | 测试文件 | 处理 |
|---|---|---|
| shared | agenda-identity、agenda、agenda-check、agenda-machine、agent-check、agent-reply-text、artifact-and-json、capture-window、connection、host-name、local-media、material、project-memory、prompt-blocks、seat-failure、seat-provider、seat-usage、speakable、team-artifact、team-checkpoint-threshold、team-plan（21） | 原样；`seat-provider` 改写（provider 名字拼法是为 dsh 注册表服务的，3 里换成适配器选择） |
| context | merge、plan、tail-for-seat、timeline、window（5） | 改写：事件形状从 dsh SessionEvent 换成 3 的事件词汇；三张表的测试改为对 3 的闭合事件列表 |
| secretary | agenda、assist、checkpoint、persona、quiet、tasks、termination（7） | 原样为主；调用子 agent 的部分改走 `SeatAdapter` |
| reasoning | activation、criterion、decontextualise、deliver、distil、distil-provider、pool、proxy、status、store、usage（11） | 原样为主；`distil-provider` 改写 |
| table | agenda、audit、commands、export、hash、log、material-prompt、record、record-store、reopen、roster、seat（12） | 改写：存储从 storage domain / dsh session 换成 3 的 JSONL + JSON |
| table | sitting（1） | 做回来（§R「一支团队下开多场会话」） |
| seat-runtime | activity、download、failure、sessions、silence（5） | 原样；子进程部分加 Windows 进程树用例 |
| seat-claude-code | argv、config-dir、doing、skills-plugin、stream、stream-fallback（6） | 原样 |
| seat-codex | argv、doing、stream（3） | 原样 |
| seat-dsh | dsh、heartbeat、patch（3） | 原样 |
| console | agenda-text、agenda-verdict、backend-tools、earlier-lines、image、mention、mention-picker、notify、number-field、parse、roster-drift、seat-status、seat-sync、speech-pause、team-designer（15） | 原样为主；`notify` 改写（Electron Notification） |
| console | team-sessions（1） | 不移植 |
| migrate | read（1） | 改写：变成 3 的「从 2.x 导入」测试 |
