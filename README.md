# Agent Memory (Memory Trail Runtime)

A local-first memory layer that captures macOS foreground state, browser activity, and agent sessions to provide explainable recall and continuity for AI agents.

## Features

- **Observe**: Low-cost capture of macOS foreground state and Chrome activity.
- **Raw Trail**: Durable storage of activity events.
- **Dream**: Consolidation of raw trails into high-level episodic memories.
- **Recall**: Semantic and FTS search for agents via `agent-context`.
- **Privacy**: Local-first storage and processing.

## Components

- `agent-memory`: Core engine for indexing and recall.
- `agent-memory-ops`: Background daemon (heartbeat) and operations.
- `agent-memory-ui`: Observability console for trails and dreams.
- `agent-recall`: CLI tool for manual semantic search.

## Installation

```bash
bun install
bun run src/ops.ts install-wrappers
bun run src/ops.ts install
```

## Architecture

See [ADR 0001: Memory Trail Runtime](docs/0001-memory-trail-runtime.md) for design decisions.
