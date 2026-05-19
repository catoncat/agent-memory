# ADR 0001: Memory Trail Runtime

## Status

Accepted.

## Context

`agent-memory` started as a low-resource event store for Codex sessions, Chrome tabs, X bookmarks, closeouts, FTS, and local semantic recall. That proved the recovery and search path, but it does not yet capture the user's actual computer usage. The product target is not a bookmark reader or a generic local search app. It is a local memory layer that lets agents recall what the user was doing and continue work with less re-explanation.

External patterns split into two incomplete halves:

- Recall/screenpipe-style systems capture screen history and OCR, but mostly optimize for human search.
- Mem0/Letta/MemGPT-style systems manage agent memories, but usually depend on explicit app events or conversations.

The useful product combines both: observe local usage, compress it into episodes, and expose explainable recall to agents.

## Decision

Build `agent-memory` as a Memory Trail Runtime with this pipeline:

```text
Observe -> Raw Trail -> Signals -> Dream -> Recall -> Agent Action
```

The runtime will:

1. Capture low-cost usage trail events from macOS foreground state, daily Chrome, Codex sessions, closeouts, and later keyframe OCR.
2. Store raw trail and artifacts separately from durable memories.
3. Compute implicit behavior signals such as dwell time, active focus, revisit, copy/search/save, and source reliability.
4. Consolidate raw trail into Dream episodes during heartbeat or idle runs.
5. Serve recall through `agent-context` with match reasons and evidence links.
6. Keep a local-first path where cloud models are optional accelerators, not required infrastructure.

## Consequences

- X bookmarks remain a source, but are not a primary product surface.
- Raw screenshots and OCR are short-lived artifacts, not the durable memory layer.
- The current single `events` table becomes a compatibility/search index. New runtime tables own trail, artifacts, signals, episodes, and memories.
- Dream must be evaluated by recall usefulness and evidence quality, not by number of summaries produced.
- The UI should be an observability console: `Now / Trail / Dream / Recall / Health`.

## Rejected Options

### Full screen recorder first

Rejected because it maximizes coverage before signal quality. It risks high resource use and a large garbage pile before we have stable Dream and forgetting.

### Bookmark/RSS reader

Rejected because it optimizes manual consumption. The goal is agent recall and continuity, not another inbox.

### Obsidian note generator first

Rejected because durable notes are an output format, not the memory runtime. Writing notes too early hides whether recall is actually useful.

### Cloud-first semantic memory

Rejected because the user's Mac must remain useful without quota, network, or API keys. Local FTS and local embeddings are baseline.

## Evaluation Gates

- CPU average below 3 percent during ordinary work.
- No foreground interaction stalls from observation.
- Raw artifact store stays bounded by TTL and size budgets.
- `agent-context` returns relevant episode/memory with reason and evidence.
- Dream reduces raw trail noise while preserving recoverability.
- `agent-memory doctor` can prove index consistency, local semantic coverage, runtime health, and storage bounds.
