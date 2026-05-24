# 🧠 Agent Memory (记忆轨迹运行时)

> 一个以 Agent 为中心、本地优先的 macOS 记忆层。

Agent Memory 是一个 **记忆轨迹运行时 (Memory Trail Runtime)**，旨在桥接原始电脑使用记录与 Agent 智能。它通过观察你的日常活动，将其整合为有意义的“梦境 (Dream)”片段，并为 AI Agent 提供可解释的回忆能力。

> **更新 (2026-05-24)：** 本仓库是更大产品的**记忆器官**——**Catty**，一个实时、不断逼近你本人的"更好的我"agent。产品本体见 [`docs/catty-thesis.md`](docs/catty-thesis.md)，首个验证切片见 [`docs/catty-v0-plan.md`](docs/catty-v0-plan.md)。下面描述的是这个记忆器官本身。

---

## ✨ 特性

- **🛡️ 本地优先存储**: 原始轨迹、FTS（全文检索）索引和向量索引都保留在本机，FTS 在本地运行。语义向量由远程 Gemini API 生成，向量落地后在本地做 cosine 检索（暂无本地 embedding 模型）。
- **👁️ 低开销观察**: 通过 60 秒一次的轻量 observe 循环，捕捉 macOS 前台状态、活跃的 Chrome 标签页以及开发会话，无需高能耗的屏幕录制。
- **🌙 梦境流水线**: 通过低频的 30 分钟节流，自动将原始活动轨迹整合为高层级的片段记忆。
- **🔍 语义召回**: 为 Agent 提供结构化的上下文、匹配理由以及证据链接。
- **📊 可视化**: 内置 UI 面板，方便你观察记忆轨迹和系统健康状况。

---

## 🚀 快速开始

### 1. 安装
确保你已安装 [Bun](https://bun.sh)，然后执行：

```bash
# 安装依赖
bun install

# 安装 CLI 封装指令 (agent-memory, agent-memory-ops 等)
bun run src/ops.ts install-wrappers
```

### 2. 启动守护进程
安装 `launchd` 服务以保持记忆引擎在后台运行：

```bash
agent-memory-ops install --interval-seconds 60
```

守护进程不是 30 分钟才观察一次。每个 60 秒心跳都会记录当前使用轨迹；较重的 refresh、Dream、embedding（远程 Gemini API）和 doctor 会被节流到约 30 分钟一次。

### 3. 使用
查看记忆引擎状态：

```bash
agent-memory-ops status
```

打开可视化面板：

```bash
agent-memory-ui
```

---

## 🛠️ 组件清单

| 指令 | 描述 |
| :--- | :--- |
| `agent-memory` | 核心引擎，负责索引、摄取和上下文召回。 |
| `agent-memory-ops` | 运维工具，管理后台心跳、日志和安装。 |
| `agent-memory-ui` | 本地 Web 服务器，提供记忆看板。 |
| `agent-recall` | CLI 工具，用于手动进行语义搜索。 |

---

## 📖 架构设计

Agent Memory 遵循以下流水线：
**观察 (Observe)** → **原始轨迹 (Raw Trail)** → **信号 (Signals)** → **梦境 (Dream)** → **召回 (Recall)** → **Agent 行动**

- **轨迹 (Trail)**: 你在做什么的年代志日志。
- **梦境 (Dream)**: 周期性的整合过程，系统在此“思考”轨迹并形成持久记忆。
- **召回 (Recall)**: Agent 的接口，用于询问“用户关于 X 做过什么？”

更多技术细节请参阅 [ADR 0001: Memory Trail Runtime](docs/0001-memory-trail-runtime.md)。

---

## 📜 开源协议

MIT

---

[English README](README.md)
