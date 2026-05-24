# src/catty — Catty v0

证明核心赌注的薄纵切。完整设计见 `docs/catty-v0-plan.md` 与 `docs/catty-thesis.md`。

## 现在有什么（Spike A：predict 管道）

```
types.ts        SelfHypothesis 契约（intent ≠ action）、Brain 模型无关隔离缝、TrailEvent
predict.ts      buildPrompt（产品逻辑：怎么形成 self hypothesis）+ predictNextStep
brain.ts        StubBrain（无模型、证明管道）/ PiBrain（真大脑，走 pi-ai + cliproxy）
trail.ts        Spike B 的真实 raw_events 读取 + app/domain 边界触发
sample-trail.ts 录制的样本 trail（含一次 app/domain 切换 = 预判触发点）
spike.ts        端到端跑一遍：在上下文切换处产出一条 self hypothesis
```

## 跑

```bash
bun src/catty/spike.ts                    # StubBrain + sample trail：无需模型/凭证，验证管道
bun src/catty/spike.ts --real             # StubBrain + 真实 raw_events：验证 Spike B 输入
envchain mom bun src/catty/spike.ts --real --pi   # PiBrain + 真实 raw_events：真预判
```

`--pi` 已接通 `@earendil-works/pi-ai`。它只从环境读取 cliproxy/OpenAI-compatible 配置：
`AI_BASE_URL`/`OPENAI_API_BASE`、`AI_API_KEY`/`OPENAI_API_KEY`、`CATTY_MODEL`/`AI_MODEL_BALANCED`/`AI_MODEL`。
不在代码或日志里写 key。

`--real` 默认读取 `~/.agents/memory/indexes/events.sqlite` 的最近 `observer.active_focus`
事件；可用 `--db <path>` 和 `--limit <n>` 覆盖。

## 还没接的（下一步）

- **Spike B hardening**：把真实 trail 触发从手动 CLI 变成可记录的 hypothesis event，保留 shadow / visible bucket。
- **judge + memory（Spike C）**：独立 judge agent（分项 rubric）对照后续 trail 打分；夜间反省写 user-prior memory；dogfood 占位。

## 边界（v0 不做）

只预判不动手、无桌宠/语音、无 Rivet 多 actor、无自建 skill、无富观测。`StubBrain` 不许长出真实预判逻辑——智能属于 PiBrain。
