# Catty v0 — 证明赌注的薄纵切

> 配套 `catty-thesis.md`。v0 唯一目的：**干净地证伪/证实核心赌注**——
> "它会靠自己的反省，越来越会预判你"。不做产品形态（桌宠/语音/多 actor 都不在 v0）。
> 锁定日期：2026-05-24。

## Anti-drift Charter

v0 **不是预测测试框架**。预判、打分、回放、日报只是为了验证一件事：
Catty 是否开始形成"第二自我"，而不是是否能把 judged hit-rate 做高。

硬约束：

- **最小单位是 self hypothesis，不是 prediction label**：每次预判都必须表达 Catty 对"你现在真正想推进什么"的理解。
- **命中率斜率只是核心量化读数，不是北极星本身**：分数上涨但"像我 / 帮到我 / 不操控我"下降，视为失败。
- **memory 只能转正 user prior**：环境共现、app shortcut、提分口诀只能留在 trial heuristic，不能进 self memory。
- **日报是开发期仪表盘，不是产品表面**：它用来审计 v0 是否跑偏，不能成为 Catty 的主要体验。
- **任何新增 runtime / actor / provider 抽象都必须证明它服务于"更像你"**，否则推迟。

> 这些护栏针对的是有名字的失败模式：**Goodhart's law**（指标一旦成为目标就不再是好指标）、**specification gaming / reward hacking**（满足字面目标而非本意）、**goal misgeneralization**（训练里对、本意外）。命中率正是那个"最容易被当成目标"的指标。

## 要证的赌注（可证伪地陈述）

> 给 Catty 你真实的活动流，它在你切换上下文时预判你的下一步；judge agent 对照你实际做了什么打分；
> 夜里它反省失误、写下 memory；**~2 周内，intent-weighted score 的斜率明显向上，
> 且你体感上越来越常"这就是我会想 / 会做的"，visible 情况下也越来越常"这确实帮我顺了一步"。**

斜率平 → kill 或重想。斜率涨但 resonance / helpfulness 不涨，仍然按失败模式处理。
不是"能不能预判"，是"**会不会自己变得更像你地理解、预判和准备**"。

## 范围

**做：** 单 actor 的预判→打分→睡眠反省→写 memory→dogfood 的闭环，跑在你真实 trail 上。

**明确不做（v0 之外）：** 动手执行（只预判不 act）、桌宠、语音、多 actor 裂变、自建 skill、富观测（截屏/OCR）。

## 闭环

```
醒着（事件驱动）:
  observe trail 出现「有意义的上下文切换」(复用 dream 的 app/domain 分段边界)
    → Catty 产出 self hypothesis（意图 + 下一步 + 为什么是现在 + 可准备什么）
    → 分配到 shadow bucket / visible bucket
    → 记录 hypothesis + 当时上下文 + 是否展示
  下一段落定时:
    → judge agent 拿「你实际做了什么」(后续 trail) + 你偶尔的反应，
      按 intent match / action match / usefulness / vagueness penalty / nudge risk 打分

睡着（夜间 / 空闲）:
  → 深度反省当天的失误：为什么没押中？我对「你」的哪条先验错了？
    → 写 1~N 条 provisional memory（claim / evidence / scope / expiry / confidence / failure fixed）
    → dogfood：未来样本里验证 intent-weighted score 是否提升，且没有让预测变宽、变保守或更像 nudging
  → 产出当天开发报告：趋势、hardest misses、过宽预测比例、memory 审计、visible 帮助性、显式负反馈
```

## 组件规格

| 组件 | v0 怎么做 |
|---|---|
| **观测** | 复用 `agent-memory` 现有 observe trail（60s 前台 app / Chrome tab / codex 会话）。原始事件流交给 agent，它自己挑重点，不手工抽特征。 |
| **预判触发** | 复用 ADR-0002 dream 的确定性分段（app/domain 切换 = 边界）。新段开启即触发一次预判。 |
| **预判内容** | `self hypothesis`，至少包含：最可能的**意图**、下一步动作/查看对象/决策、**为什么是现在**、Catty 可先准备/提议什么。不可退化成 `next_app=cursor` 这类标签。 |
| **shadow / visible** | 一部分 hypothesis 不展示给你，只用于评估，估计 visible prediction 对你后续行为的 nudging 污染。visible case 才评帮助性。 |
| **打分（judge）** | 独立的 judge agent（与预判的 Catty 分离，避免自评自欺）。锚：你**实际后续行为**（trail）为主 + 你偶尔的显式反应校准。rubric 至少拆成 intent match、action match、usefulness、vagueness penalty、nudge risk。 |
| **睡眠反省** | 夜间/空闲跑一次。复用 dream 的 consolidation 框架。只产 provisional **memory**（skill 留到斜率证实后）。 |
| **memory 入库** | memory 必须写成可证伪 user prior：`claim`、`evidence episodes`、`scope`、`expiry`、`confidence`、`failure fixed`。只能描述 app/domain 共现的结论留作 trial heuristic，不进入 self memory。 |
| **dogfood 自验证** | 新 memory 进入"试用期"，只能用未来样本验证；同时满足 intent-weighted score 提升、预测没有变宽/变保守、用户体感不下降，才转正。 |
| **反馈入口** | 轻量四格：对不对、像不像我、有没有帮助、有没有被带着走 / 冒犯 / 操控感。负反馈权重大于等量正反馈。 |
| **底座** | v0 以单进程 / 单 actor 近似为准：单 Catty、单 pi brain（`streamFn` 接 cliproxy，模型自由）。Rivet 接口保留为隔离缝，不提前支付分布式 runtime 税。 |

## intent 怎么定义、judge 怎么比意图（堵住 action-label 坍缩的洞）

整套护栏都压在 "intent match" 上，所以必须先说清意图是什么、怎么判——且**全程靠 judge agent 的语义判断，不写硬规则表（那就又掉回 if-else）**：

- **`intent` 字段 = 你此刻在推进的*目标 / 为什么*，不是动作本身。**
  - 好：「在给 dream merge 的 bug 收口，想确认 embedding 合并这条路走不走得通」。
  - 坏：「下一步会打开 dream.ts」（这是 action，不是 intent）。
- **judge 把意图和动作分开评，意图权重更高（intent-weighted）：**
  - 意图对、动作错（你转去读 sqlite-vec rust 源码、没直接改 dream.ts，但仍在推进同一个 merge 目标）→ **算抓到了你**，记"意图命中 / 动作偏"。
  - 动作对、意图错（猜中你打开了 dream.ts，却以为你在写新功能，其实你在排回归 bug）→ **不算懂你**，记"动作命中 / 意图错"，按浅层 continuation 处理，不给高分。
- judge 还要显式判：意图是否**可证伪**（太宽如"你会继续工作"一律扣分）、理由是否**站得住**（正确但理由明显错 = 蒙对，不算）。

## 落点

**先在 `agent-memory` 仓库内起一个新模块**（最大复用 trail / 分段 / dream / memory 机制），
Rivet + pi 作为新依赖按需引入；近 headless——**一份开发期每日报告**给你看趋势、hardest misses、memory 审计和 visible 帮助性，
再配一个轻量四格反馈入口校准 judge。
跑通、斜率为正后再考虑抽成独立 repo、上 Rivet 多 actor、加桌宠/语音。

## 赢 / kill 判准

**五支柱，不看单一曲线**：

- held-out / future 的 intent-weighted score 斜率明显向上；
- confidence calibration 没有恶化，过宽/保守预测比例不升；
- provisional memory 的 canary dogfood 证明是 user prior 带来的 uplift；
- visible case 的 helpfulness 上升，且 shadow / visible 差异没有显示 nudging 污染；
- 你主观体感上升：更像我、更顺、不冒犯、不操控。

任一失败模式出现就 kill 或 pivot：分数升但"像我"不升；prediction 逐周变宽/模板化；
转正 memory 大多是 event shortcut；visible prediction 改变了你的行为；团队主要工作被 judge/report/replay/runtime plumbing 吞掉。

## 开放执行细节 / 风险

- **judge 自欺**：judge 与 Catty 必须分离，且以"你实际行为"为硬锚，否则斜率是假的。
- **proxy capture**：命中率只能做读数，不能变成事实上的产品目标；高分但不像你就是失败。
- **冷启动**：头几天没 memory、命中率低很正常；看的是斜率不是起点。
- **预判粒度漂移**：predict 太宽则无法判命中、太窄又掉回 if-else——rubric 显式惩罚过宽、不可证伪、理由明显不对。
- **visible 污染**：显示出来的预判可能改变你的下一步；必须保留 shadow bucket 估计污染。
- **memory shortcut**：能提分的 app/domain 共现不等于 user prior；未证明是"关于这个人"的东西不得转正。
- **成本**：事件驱动已控住大头；夜间反省是重头，限定每日预算。
- **pi / Rivet 都年轻**：锁版本，接口留隔离层，别深耦合；v0 不为 provider switching / actor 拓扑 / 编排平台付主战场成本。

## 决策日志（本次 grill 锁定）

1. ~~第一用户 = agent~~ → **产品用户 = 你本人（"第二个我"）**。"agent 优先"是产品重构前的旧判断，**作废**；agent-as-consumer 只是接口、不是优先级。
2. 自主度 = 分级，默认你拍板。
3. 引擎 = 开放 + 模型无关 → pi（大脑）+ Rivet（actor 底座）+ agent-memory（自我）。
4. 拓扑 = 一只猫在前 + 领域 sub-actor 在后；v0 先单 actor。
5. 自我进化 = 睡眠飞轮（反省/记忆/建技能/dogfood）；v0 只产 memory。
6. v0 观测 = 复用现有 trail。
7. v0 节拍 = 事件驱动预判 + 夜间睡眠。
8. v0 最小单位 = self hypothesis，不是 action label。
9. v0 赢/kill = 五支柱：未来样本斜率、校准、memory canary、visible 帮助性、主观 resonance。
