# ADR 0002: Trail Episode Segmentation

将原始活动轨迹（60s 前台采样 + Chrome 标签 + Codex 对话）自动分割为有意义的
"episode"（情节），并为每个 episode 生成结构化摘要。

## Status

Accepted — 验证完成，按调整后的方案实施。

## Constraints

| 约束 | 值 | 来源 |
|---|---|---|
| 数据采样间隔 | 60s | launchd heartbeat |
| Gemini API 限频 | ~55 batch/min/key | free tier |
| 当前 2 把 key 轮询 | ~110 batch/min | config.json |
| Dream 周期 | 30 min | ops.ts full pipeline |
| 事件总量 | ~500 raw events/day | trail.rawEvents |
| Episode 持久化 | 新增 `episodes` + `episode_threads` 表 | 不与现有 events 表混用 |

## 验证结论

2026-05-22 对 469 条 trail events + Gemini 768d embedding 做了 sliding window cosine 验证：

| 指标 | 值 |
|---|---|
| Cosine 整体分布 | 0.779 ~ 0.998 |
| P25 / P50 / P75 | 0.914 / 0.943 / 0.968 |
| 纯 app/domain change 检测 | 255 次 → 256 raw segments（avg 2 events/segment） |

**关键发现：**

1. **Embedding cosine 不足以做为主分割信号** — 最低也有 0.78，跨 app 切换（Codex → 微信 → Slack）多次跑到 0.99+。事件文本太短（"Codex" / "微信"），768d 向量拉不开差距。
2. **Deterministic gate（app/domain change）更准但太碎** — 255 处边界全部是真实切换，但平均 2 个事件就切一次，需要合并而不是分割。
3. **Embedding 的应用场景是合并，不是分割** — 连续同一 app 的事件 cosine > 0.97，可以直接合并成一段。

因此原有方案推翻，调整为以下方向。

## 核心设计原则（调整后）

1. **60s heartbeat 不做 LLM 调用** — 不变
2. **Episode 边界首先是确定性的** — app/domain 变化是边界的第一决定因素，embedding 只用来合并过分割的片段
3. **Thread 分配靠三元组** — `(app_change, time_gap, cosine_similarity)` 三个信号综合判断
4. **增量收敛** — 每次 dream 只处理新事件和未收敛的 open threads

## 架构

### 数据流

```
60s heartbeat:
  observe → app/window change detected → insert raw_event
  embed (if unembedded) → store 768d vector

30min dream (full pipeline):
  step 1: 收集本轮新 raw_events
  step 2: 按 app/domain/time 做粗分（raw segments）
  step 3: 用 embedding cosine 合并过碎的相邻段
  step 4: thread assignment（新段归入 open thread 或开新 thread）
  step 5: thread merge（embedding centroid + LLM 判断）
  step 6: LLM summarize（仅对 closed thread）
  step 7: 持久化
```

### 分段算法（调整后）

#### 第一道：Deterministic Segmentation

以 app/domain 变化做主要边界：

```
raw_segments = []

for each event[i]:
  prev_app = app(i-1)
  cur_app  = app(i)

  if prev_app != cur_app:
    # app 变化 → 绝对边界
    close current segment at i-1
    start new segment at i
  elif time_gap(i, i-1) > 30min:
    # 超时 → 弱边界
    close current segment at i-1
    start new segment at i
  else:
    continue current segment
```

#### 第二道：Embedding Merge（合并过碎片段）

对 raw segments，计算相邻段的 embedding centroid cosine：

```
for each adjacent pair (segA, segB):
  centroidA = avg(vectors of events in segA)
  centroidB = avg(vectors of events in segB)
  score = cosine(centroidA, centroidB)

  if score > 0.95:
    # 同一应用下的连续活动 → 安全合并
    merge segA and segB
  elif score > 0.90 AND time_gap < 5min:
    # 短期内相关性高 → 合并
    merge segA and segB
  else:
    keep separate
```

阈值 0.95/0.90 是初始值，基于验证数据：
- 同一 app 的相邻事件 cosine 通常在 0.97+（如持续使用 Slack）
- 跨 app 的 cosine 虽然也高（~0.85），但第一步已经切开了

#### 第三道：Thread Assignment

```
open threads = last dream 的 open threads（2h 内活跃）

for each merged segment:
  best_match = null
  best_score = 0

  for each open thread:
    app_match = (segment.main_app == thread.main_app) ? 1 : 0
    time_close = segment.start 在 thread 的 end ± 30min 内 ? 1 : 0
    centroid_sim = cosine(segment.centroid, thread.centroid)

    combined = app_match * 0.5 + time_close * 0.2 + centroid_sim * 0.3

    if combined > best_score:
      best_score = combined
      best_match = thread

  if best_score > 0.5:
    assign segment to best_match, update thread centroid
  else:
    create new thread
```

#### 第四道：Thread Merge & Summary（LLM 参与）

当两个 open thread 的 centroid cosine > 0.85 且发生在相近时间段时，标记
为合并候选。下次 dream 时做轻量 LLM 判断。

**只有这一步和摘要生成需要 LLM。**

### LLM 调用预算

| 阶段 | 每次 dream 调用数 | Token/次 | 日成本 |
|---|---|---|---|
| Thread merge 判断 | 1-3 | ~200 | ~200-600 tokens |
| Episode 摘要 | 2-5（已关闭 thread） | ~500 | ~1000-2500 tokens |
| **合计** | **3-8 次** | | **~1200-3100 tokens/天** |

注：实际上目前 30min 跑一次 full pipeline 有点频繁（46 次/天），但大部分
周期 `fullPipelineThrottled` 会跳过；实际跑通约 24 次/天。且每次增量事件
很少时，大部分步骤直接跳过。实际 LLM 成本接近于零。

### Schema

```sql
CREATE TABLE episode_threads (
  id TEXT PRIMARY KEY,
  label TEXT,
  status TEXT DEFAULT 'open',     -- open | closed | merged
  main_app TEXT,                   -- 该 thread 的主要 app 标识
  count INTEGER DEFAULT 0,         -- 包含事件数
  centroid_json TEXT,              -- centroid vector (JSON)
  event_ids TEXT,                  -- JSON array of event_ids
  start_ts TEXT,
  end_ts TEXT,
  merged_into TEXT REFERENCES episode_threads(id),
  score REAL DEFAULT 0,
  created_at TEXT,
  closed_at TEXT
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES episode_threads(id),
  title TEXT,
  summary TEXT,
  tags TEXT,                       -- JSON array
  event_ids TEXT,                  -- JSON array
  start_ts TEXT,
  end_ts TEXT,
  score REAL DEFAULT 0,
  model TEXT,                      -- LLM model used for summary
  created_at TEXT
);
```

### Thread 生命周期

```
created (open) → 分配新事件 → 保持 open
               → 与另一个 thread 的 centroid > 0.85 → 标记 merge 候选
               → 超过 2h 无新事件 → closed → LLM summary → episode
               → events < 3 且 score < 10 → discarded（不生成 episode）
```

## 与当前系统的关系

| 组件 | 改动 | 风险 |
|---|---|---|
| `main.ts` dream 函数 | 完全重写 | 中 — 当前 dream 只做 domain 聚合 |
| `events` 表 | 不修改 | 低 |
| 新增 `episodes` / `episode_threads` | 新表 | 低 |
| `ops.ts` full pipeline | 无改动（已有 embed --wait） | 无 |
| recall / context | 后续接 episode 作为搜索源 | 低（不在本次范围） |
| doctor | 跟踪新表数据 | 低 |

## 实施顺序

1. 建表（episode_threads + episodes）
2. 重写 dream 中的 segmentation 逻辑（deterministic + embedding merge + thread assignment）
3. 接入 LLM summary（thread merge + episode title/summary）
4. 第一个 dream 全量回算所有历史事件
5. 验证输出质量
6. doctor 跟踪新表

## Open Questions

1. ~~Embedding 区分度~~ — **已验证**。不足做主分割，但够做合并判断。已调整方案。
2. 初次全量回算的节奏 — 可能触发 Gemini 限频。可用 `--wait` 分批跑。
3. 是否需要 dream 完成后自动 `doctor` 检查 — 可以用 ops.ts 的 status 看。
