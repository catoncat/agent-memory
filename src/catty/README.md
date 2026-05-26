# src/catty — Catty v0

证明核心赌注的薄纵切。完整设计见 `docs/catty-v0-plan.md` 与 `docs/catty-thesis.md`。

## 现在有什么（Spike A：predict 管道）

```
types.ts        SelfHypothesis 契约（intent ≠ action）、Brain 模型无关隔离缝、TrailEvent
predict.ts      buildPrompt（产品逻辑：怎么形成 self hypothesis）+ predictNextStep
brain.ts        StubBrain（无模型、证明管道）/ PiBrain（真大脑，走 pi-ai + cliproxy）
trail.ts        Spike B 的真实 raw_events 读取 + app/domain 边界触发
judge.ts        Spike C 的独立 judge seam + intent-weighted rubric
runtime.ts      record/judge/report/admission runtime seam + store port
sqlite-store.ts bun:sqlite 持久化 catty_predictions / catty_memory_audit
shadow.ts       手动记录当前 shadow prediction；默认 dry-run，显式 --write 才写库
sample-trail.ts 录制的样本 trail（含一次 app/domain 切换 = 预判触发点）
spike.ts        端到端跑一遍：在上下文切换处产出一条 self hypothesis
```

## 跑

```bash
bun src/catty/spike.ts                    # StubBrain + sample trail：无需模型/凭证，验证管道
bun src/catty/spike.ts --real             # StubBrain + 真实 raw_events：验证 Spike B 输入
envchain mom bun src/catty/spike.ts --real --pi   # PiBrain + 真实 raw_events：真预判
envchain mom bun src/catty/spike.ts --real --pi --judge   # PiBrain + PiJudge：预判后对照后续 trail 打分
bun src/catty/shadow.ts                   # dry-run：读取真实 raw_events，不写库、不调模型
bun src/catty/shadow.ts --write           # StubBrain：写一条 shadow prediction 到 events.sqlite
envchain mom bun src/catty/shadow.ts --pi --write  # PiBrain：显式写真实模型 shadow prediction
```

`--pi` 已接通 `@earendil-works/pi-ai`。它只从环境读取 cliproxy/OpenAI-compatible 配置：
`AI_BASE_URL`/`OPENAI_API_BASE`、`AI_API_KEY`/`OPENAI_API_KEY`、`CATTY_MODEL`/`AI_MODEL_BALANCED`/`AI_MODEL`。
不在代码或日志里写 key。

`--real` 默认读取 `~/.agents/memory/indexes/events.sqlite` 的最近 `observer.active_focus`
事件；可用 `--db <path>` 和 `--limit <n>` 覆盖。

`shadow.ts` 默认读取同一个 live events DB，并把 Catty 表写入 `--store-db`（默认同 `--db`）。
它不接 launchd heartbeat；没有 `--write` 时只是 dry-run，不会创建 `catty_predictions`。

## 还没接的（下一步）

- **Spike B hardening**：把 shadow 手动写入扩成受控调度策略，仍保留 shadow / visible bucket。
- **Spike C hardening**：把 judgement 写成可回放的记录，并让 shadow / visible bucket 进入评分统计。
- **memory（Spike D）**：夜间反省写 user-prior memory；dogfood 占位。

## 边界（v0 不做）

只预判不动手、无桌宠/语音、无 Rivet 多 actor、无自建 skill、无富观测。`StubBrain` 不许长出真实预判逻辑——智能属于 PiBrain。
