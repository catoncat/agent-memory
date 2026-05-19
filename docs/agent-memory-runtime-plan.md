# Agent Memory Runtime Plan

## Product Thesis

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

The observer is event-driven or low-frequency. It must not become a busy watcher.

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
- Health: heartbeat, storage, index, doctor

## MVP Scope

### Build Now

1. Observer one-shot CLI for foreground app/window and daily Chrome active tab.
2. Runtime schema for `raw_events`, `artifacts`, `signals`, `episodes`, and `memories`.
3. Dwell/session state for active focus.
4. Signal rows for dwell, active focus, observed count, and score.
5. Heartbeat calls observer before refresh/dream/embed/doctor.
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
- Heartbeat target: under 60 seconds total.
- Idle CPU: no persistent busy process.
- Memory root target for MVP: under 200 MB.
- Raw screenshot TTL target: 24 hours by default, max 7 days.

## Validation

- `agent-memory observe --json` returns one current focus event.
- Repeated observe calls on same focus increase dwell and observed count.
- `agent-memory stats` includes observer events.
- `agent-memory doctor --json` reports trail schema and observer state checks.
- `agent-memory-ops status --live --json` includes observer, refresh, dream, embed, doctor.
- `agent-context "<current task>" --semantic --local` can recall relevant trail or Dream evidence.
