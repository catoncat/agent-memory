# 🧠 Agent Memory (Memory Trail Runtime)

[简体中文](README.zh-CN.md) | English

> A local-first, agent-centric memory layer for macOS.

Agent Memory is a **Memory Trail Runtime** designed to bridge the gap between raw computer usage and agentic intelligence. It observes your daily activities, consolidates them into meaningful "Dream" episodes, and provides explainable recall for AI agents.

---

## ✨ Features

- **🛡️ Privacy First**: Everything stays local. FTS and semantic embeddings run on your machine.
- **👁️ Low-Cost Observation**: Captures macOS foreground state, active Chrome tabs, and developer sessions with a lightweight 60-second observe loop.
- **🌙 Dream Pipeline**: Automatically consolidates raw activity trails into high-level episodic memories on a low-frequency 30-minute throttle.
- **🔍 Semantic Recall**: Provides agents with structured context, reasons for matching, and evidence links.
- **📊 Observability**: Comes with a built-in UI to visualize your memory trails and system health.

---

## 🚀 Quick Start

### 1. Installation
Ensure you have [Bun](https://bun.sh) installed, then:

```bash
# Install dependencies
bun install

# Install CLI wrappers (agent-memory, agent-memory-ops, etc.)
bun run src/ops.ts install-wrappers
```

### 2. Start the Daemon
Install the `launchd` service to keep the memory engine running in the background:

```bash
agent-memory-ops install --interval-seconds 60
```

The daemon does not wait 30 minutes to observe activity. Every 60-second heartbeat records the current usage trail, while heavier refresh, Dream, local embedding, and doctor work is throttled to roughly every 30 minutes.

### 3. Usage
Check the status of your memory engine:

```bash
agent-memory-ops status
```

Open the observability dashboard:

```bash
agent-memory-ui
```

Consolidate the trail, inspect the cross-surface graph, and correct salience:

```bash
# Consolidate the last 24h of trail into dream episodes
agent-memory dream

# Correct how dream scores a thread / episode / link / event (feeds back into salience)
agent-memory correct <thread:..|episode:..|link:..|eventId> demote --note "why"

# List cross-surface links between threads (the memory graph)
agent-memory links --limit 20

# Surface fresh high-value findings as quiet Background-tier notifications
agent-memory notify --dry-run        # preview what would fire, no delivery
agent-memory notify --limit 3        # deliver (deduped), as the heartbeat does
```

---

## 🛠️ Components

| Command | Description |
| :--- | :--- |
| `agent-memory` | Core engine for indexing, ingestion, and context retrieval. |
| `agent-memory-ops` | Operations tool for managing the background heartbeat and logs. |
| `agent-memory-ui` | Local web server for the memory dashboard. |
| `agent-recall` | CLI tool for manual semantic searching across your history. |

---

## 📖 Architecture

Agent Memory follows the pipeline:
**Observe** → **Raw Trail** → **Signals** → **Dream** → **Recall** → **Agent Action**

- **Trail**: Chronological logs of what you were doing.
- **Dream**: Periodic consolidation where the system "thinks" about the trails to form durable memories.
- **Recall**: The interface for agents to ask "What was the user doing regarding X?"

For deeper technical details, see [ADR 0001: Memory Trail Runtime](docs/0001-memory-trail-runtime.md).

---

## 📜 License

MIT
