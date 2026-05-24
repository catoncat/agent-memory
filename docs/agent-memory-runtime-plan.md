# Agent Memory Runtime Plan

> **2026-05-24 更新 — 定位已重构。** 本仓库不再是"产品"，而是 **Catty** 的**记忆器官**：
> Catty 是一个实时、不断逼近你本人的"更好的我"agent。产品本体见
> [`catty-thesis.md`](catty-thesis.md)，首个验证切片见 [`catty-v0-plan.md`](catty-v0-plan.md)。
> 下面这份原始 runtime plan 仍准确描述记忆器官（observe → trail → signals → dream → recall）这一子系统。

## Product Thesis（记忆器官子系统，非整体产品）

The product is a local Agent memory layer for this Mac. It should help an agent answer:

- What was the user working on?
- What evidence did they look at?
- Why is this memory relevant now?
- What can the agent safely do next?

It is not a bookmark reader, a full screen recorder, or an Obsidian note generator.

## Evaluation Dimensions

Every feature must pass these checks:

1. Agent usefulness: reduces re-explanation or improves continuity.
2. Signal quality: captures intent, not just activity volume.
3. Resource cost: bounded CPU, disk, and battery impact.
4. Recoverability: raw data and indexes can be rebuilt or traced.
5. Observability: user and agent can see why memory was kept, recalled, or forgotten.
6. Local-first: usable without cloud quota.

## Target Modules

### Observer

One-shot and scheduled capture of current usage state:

- foreground app
- focused window title
- active Chrome tab URL/title
- later: keyframe screenshot, OCR, copy/search/download/save hooks

The observer is lightweight and scheduled frequently enough to be useful: the launchd heartbeat runs every 60 seconds and performs one observe pass. It must not become a busy watcher.

### Raw Trail Store

Append-only source of usage truth:

- `raw_events`: observed actions and context
- `artifacts`: screenshots, OCR, DOM text, and other payloads with TTL
- JSONL recovery mirror for rebuilds

### Signal Engine

Converts raw trail into behavior weights:

- dwell time
- active focus
- revisit count
- copy/search/save/download signals
- source reliability
- salience score

### Dream Engine

Consolidates raw trail into episodes:

- session boundaries
- topic/entity clustering
- evidence URLs/artifacts
- summary and next-action candidates
- decay candidates

### Recall Engine

Retrieves compact context for agents:

- FTS + local embedding baseline
- optional model rerank
- recall reason
- evidence pointer
- freshness/confidence

### UI

Observability console:

- Now: current observer state
- Trail: recent raw events and scores
- Dream: episodes and decay candidates
- Recall: query, match reason, evidence
- Health: heartbeat, observe cadence, full-pipeline cadence, storage, index, doctor

## MVP Scope

### Build Now

1. Observer one-shot CLI for foreground app/window and daily Chrome active tab.
2. Runtime schema for `raw_events`, `artifacts`, `signals`, `episodes`, and `memories`.
3. Dwell/session state for active focus.
4. Signal rows for dwell, active focus, observed count, and score.
5. Heartbeat calls observer every 60 seconds, but only runs refresh/dream/embed/doctor when the 30-minute full-pipeline throttle is due.
6. Doctor verifies trail schema and observer state.

### Build Next

1. Keyframe screenshot capture with TTL.
2. Apple Vision OCR or equivalent local OCR.
3. Dream v2 based on signal scores and session boundaries.
4. Recall explanations and evidence pointers.
5. UI `Now / Trail / Dream / Recall / Health`.

### Do Not Build Yet

- Full 24/7 recording.
- Cloud sync or D1.
- Mobile consumption.
- Obsidian auto-publishing.
- Platform-specific readers beyond data-source adapters.

## Resource Budgets

- Observer one-shot target: under 300 ms when permissions are healthy.
- Launchd cadence: 60-second light observe heartbeat.
- Full pipeline cadence: refresh -> dream -> embed --local -> doctor at most once every 30 minutes.
- Heartbeat target: under 60 seconds total.
- Idle CPU: no persistent busy process.
- Memory root target for MVP: under 200 MB.
- Raw screenshot TTL target: 24 hours by default, max 7 days.

## Validation

- `agent-memory observe --json` returns one current focus event.
- Repeated observe calls on same focus increase dwell and observed count.
- `agent-memory stats` includes observer events.
- `agent-memory doctor --json` reports trail schema and observer state checks.
- `agent-memory-ops status --live --json` includes last observe state, last full-pipeline state, next full-pipeline due time, or a `fullPipelineSkipped` reason.
- `agent-context "<current task>" --semantic --local` can recall relevant trail or Dream evidence.
