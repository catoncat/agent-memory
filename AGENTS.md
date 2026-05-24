# Agent Memory / Catty Repo Rules

本仓库现在是 **Catty 的记忆器官**，不是完整产品本体。后续 agent 进入本仓时，先按下面的 source of truth 判断当前工作属于哪一层，再动代码。

## Source Of Truth

1. 产品本体：[`docs/catty-thesis.md`](docs/catty-thesis.md)。
2. v0 验证切片：[`docs/catty-v0-plan.md`](docs/catty-v0-plan.md)。
3. 记忆器官 runtime：[`docs/agent-memory-runtime-plan.md`](docs/agent-memory-runtime-plan.md)、[`docs/0001-memory-trail-runtime.md`](docs/0001-memory-trail-runtime.md)、[`docs/0002-trail-episode-segmentation.md`](docs/0002-trail-episode-segmentation.md)。
4. Mainline 状态和 signals：先看 hook 注入的 `mainline:context`，必要时跑 `mainline preflight --json` 和 `.ml-cache/mainline-signals/latest.md`。

不要再把旧的 "local agent memory layer" 当成产品北极星；它只是 Catty 的 observe / trail / dream / recall 子系统。
`docs/research/` 下的竞品/技术研究只作为背景和反边界材料；除非同步更新 `catty-thesis.md` / `catty-v0-plan.md`，不要把它提升为 Catty 路线图。

## Runtime Truth First

- 本机权威工作区是 `/Users/envvar/work/repos/agent-memory`；不要回到旧 `mom` 拷贝里继续做产品 runtime 改动。
- 线上/本机运行状态先查 live truth：`bun src/ops.ts status --json --live`、`launchctl print gui/$(id -u)/com.envvar.agent-memory-heartbeat`、`pgrep -af 'agent-memory|agent-memory-ops'`、`~/.agents/memory/runtime/status.json` / `metrics.prom`。
- 当前 runtime 是 launchd heartbeat，不是常驻 daemon。默认轻量 observe 高频跑，`refresh -> dream -> embed -> doctor` 是低频 full pipeline。
- 不读取或回显 `~/.agents/memory/config.json`、API key、token、cookie。`doctor` / `secret_scan` 如果报这个文件，先按 secret 边界处理，不把内容贴出来。

## Old Implementation Map

整理旧实现时按四类处理，不要一刀切删除：

- **Live memory organ**：`src/main.ts`、`src/ops.ts`、`src/lib/ops-runtime.ts`、`src/ui-server.ts`。它们仍负责 CLI、SQLite trail、observe、refresh、dream、embed、context、heartbeat、UI API。
- **Legacy compatibility**：`src/index-cli.ts`、`src/recall.ts`、`src/lib/memory-db.ts`、`src/lib/memory-parser.ts`。这些保留了旧 `mom` / vault / sqlite-vector 索引假设。不要继续扩展；后续要么迁到 `src/legacy/`，要么在确认没有 wrapper/bin 依赖后删除。
- **Catty prototype surface**：`ui/index.html`、`ui/catty.css`、`ui/catty.js`、`ui/assets/`。这是产品形态原型，不等于 runtime 已接入。
- **Legacy UI**：`ui/legacy/`。旧 Agent Memory observability console，可以作为 runtime 调试参考；不要再把它当成 Catty 产品界面。

如果要做结构整理，优先顺序是：

1. 先给 legacy 代码加清晰目录归属或文档说明。
2. 再为 Catty v0 新建独立模块，例如 `src/catty-v0/`，不要继续把 self hypothesis / judge / memory admission / report 逻辑塞进 `src/main.ts`。
3. 最后才考虑删除旧实现；删除前必须验证 bin、launchd、README、UI API、tests 没有引用。

## Catty v0 Boundaries

- v0 的最小单位是 `self hypothesis`：意图、下一步、为什么是现在、可以准备什么。
- 不把 v0 做成 prediction hit-rate harness。命中率斜率只是核心量化读数；高分但不像用户、没帮助或有 nudging 感都算失败。
- predictor 和 judge 必须分离。judge rubric 至少拆成 intent match、action match、usefulness、vagueness penalty、nudge risk。
- memory 只能转正可证伪的 user prior。app/domain 共现、event shortcut、提分口诀只能是 trial heuristic。
- 保留 shadow / visible bucket，用 shadow 估计 visible prediction 是否污染后续行为。
- 每日报告是开发期仪表盘，不是产品主界面；必须包含 hardest misses、过宽预测比例、memory 审计、visible 帮助性和负反馈。
- v0 默认单 actor / 单进程近似；Rivet / pi 只保留隔离缝，不提前支付多 actor 或 provider-platform 成本。

## Bun / Implementation Rules

- 使用 Bun，不使用 Node/npm/pnpm/yarn/vite：
  - `bun <file>`，不要 `node <file>` 或 `ts-node`。
  - `bun test`，不要 `jest` / `vitest`。
  - `bun install`，不要 `npm install` / `yarn install` / `pnpm install`。
  - `bunx <package> <command>`，不要 `npx`。
- 新 runtime SQLite 代码优先用 `bun:sqlite`。不要新增 `better-sqlite3` / Express / dotenv。
- Bun 自动加载 `.env`；不要手动引入 dotenv。
- 新代码先放在小而清楚的模块里；`src/main.ts` 已经是旧 monolith，非必要不要继续扩大。

## Verification

按改动范围选择最小可证明命令：

- 文档/规则：`git diff --check`，必要时读回关键段落。
- TypeScript/runtime：`bun test`；若没有相关测试，跑目标 CLI，例如 `bun src/main.ts doctor --json`、`bun src/ops.ts status --json`。
- Heartbeat/ops：优先 `bun src/ops.ts status --json --live`，再查 launchd 和 runtime files。
- UI：`bun src/ui-server.ts --port 4799` 后用 Browser 检查本地页面；如果只是静态 prototype 文案/CSS，可做 focused visual smoke。

不要声称完成、可提交或可合并，除非已经跑过与本次改动直接相关的验证。

## Git / Mainline

- 这个仓库使用 Mainline。非琐碎编辑前先看 active intent、dirty files 和 `.ml-cache/mainline-signals/latest.md`。
- 当前 worktree 可能包含别人或上一轮留下的 staged / unstaged / untracked 改动。不要 revert、unstage、stage 或 commit 不属于本轮的文件。
- 如果看到 `ui/app.* -> ui/legacy/*` 这类已有 rename，先确认它是否是当前旧实现整理的一部分；不要用格式化或移动命令意外覆盖。
- commit 信息使用 `<type>(scope): <summary>`，summary 用中文动词开头，不加句号。
