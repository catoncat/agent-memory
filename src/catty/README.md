# src/catty — Catty v0

证明核心赌注的薄纵切。完整设计见 `docs/catty-v0-plan.md` 与 `docs/catty-thesis.md`。

## 现在有什么（Spike A：predict 管道）

```
types.ts        SelfHypothesis 契约（intent ≠ action）、Brain 模型无关隔离缝、TrailEvent
predict.ts      buildPrompt（产品逻辑：怎么形成 self hypothesis）+ predictNextStep
brain.ts        StubBrain（无模型、证明管道）/ PiBrain（真大脑，待接线）
sample-trail.ts 录制的样本 trail（含一次 app 切换 = 预判触发点）
spike.ts        端到端跑一遍：在上下文切换处产出一条 self hypothesis
```

## 跑

```bash
bun src/catty/spike.ts            # StubBrain：无需模型/凭证，验证管道
envchain mom bun src/catty/spike.ts --pi   # PiBrain：真预判（需先接线，见下）
```

`--pi` 现在会抛错（PiBrain 未接线）——这是预期的。

## 还没接的（下一步）

- **PiBrain（脑子）**：`bun add @earendil-works/pi-agent-core @earendil-works/pi-ai`，
  建 Agent / createAgentSession，把 `streamFn` 指向你的 cliproxy（模型自由），跑一轮后从 agent 输出解析 `SelfHypothesis` JSON。
- **接真 trail（Spike B）**：把 `sample-trail.ts` 换成 `agent-memory` 现有 observe trail + 复用 `src/main.ts` 的 thread 分段做真实触发边界。
- **judge + memory（Spike C）**：独立 judge agent（分项 rubric）对照后续 trail 打分；夜间反省写 user-prior memory；dogfood 占位。

## 边界（v0 不做）

只预判不动手、无桌宠/语音、无 Rivet 多 actor、无自建 skill、无富观测。`StubBrain` 不许长出真实预判逻辑——智能属于 PiBrain。
