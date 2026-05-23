#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_OBSERVE_INTERVAL_SECONDS,
  buildMetrics,
  planFullPipeline,
} from "./lib/ops-runtime";

type JsonRecord = Record<string, unknown>;

type CommandResult = {
  command: string;
  args: string[];
  ok: boolean;
  status: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
};

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const HOME = homedir();
const MEMORY_ROOT = process.env.AGENT_MEMORY_ROOT || path.join(HOME, ".agents", "memory");
const RUNTIME_DIR = path.join(MEMORY_ROOT, "runtime");
const RUNS_DIR = path.join(RUNTIME_DIR, "runs");
const STATUS_PATH = path.join(RUNTIME_DIR, "status.json");
const METRICS_PATH = path.join(RUNTIME_DIR, "metrics.prom");
const LOCK_DIR = path.join(RUNTIME_DIR, "heartbeat.lock");
const LOG_DIR = path.join(HOME, "Library", "Logs", "agent-memory");
const LABEL = process.env.AGENT_MEMORY_LAUNCHD_LABEL || "com.envvar.agent-memory-heartbeat";
const PLIST_PATH = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const DEFAULT_INTERVAL_SECONDS = DEFAULT_OBSERVE_INTERVAL_SECONDS;

function usage(exitCode = 0): never {
  const text = `Usage:
  agent-memory-ops heartbeat [--json]
  agent-memory-ops status [--json] [--live]
  agent-memory-ops metrics
  agent-memory-ops install [--interval-seconds 60]
  agent-memory-ops uninstall
  agent-memory-ops kick
  agent-memory-ops logs [--lines 80]

Runtime:
  ${STATUS_PATH}
  ${METRICS_PATH}
  ${RUNS_DIR}/YYYY-MM-DD.jsonl
  ${PLIST_PATH}
`;
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function argValue(args: string[], name: string, fallback = ""): string {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function argNumber(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name, "");
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureRuntimeDirs() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
}

function commandPath(): string {
  return [
    path.join(HOME, ".agents", "bin"),
    path.join(HOME, ".local", "bin"),
    path.join(HOME, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
}

function safeCommandEnv(): Record<string, string> {
  return {
    HOME,
    PATH: commandPath(),
    AGENT_MEMORY_ROOT: MEMORY_ROOT,
    NO_COLOR: "1",
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
    TZ: process.env.TZ || "Asia/Shanghai",
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function runJsonCommand(command: string, args: string[], timeoutMs: number): CommandResult {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: safeCommandEnv(),
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const output: CommandResult = {
    command,
    args,
    ok: result.status === 0 && !result.error,
    status: result.status ?? (result.error ? 1 : 0),
    durationMs: Date.now() - started,
    stdout,
    stderr,
  };
  if (result.error) output.error = result.error.message;
  try {
    output.json = JSON.parse(stdout);
  } catch {
    // Some subcommands are human-readable. Keep raw stdout/stderr in the run log.
  }
  return output;
}

function acquireLock(): { ok: true; release: () => void } | { ok: false; reason: string } {
  ensureRuntimeDirs();
  try {
    mkdirSync(LOCK_DIR);
    writeFileSync(path.join(LOCK_DIR, "pid"), `${process.pid}\n${nowIso()}\n`, "utf8");
    return {
      ok: true,
      release: () => {
        rmSync(LOCK_DIR, { recursive: true, force: true });
      },
    };
  } catch {
    try {
      const stat = statSync(LOCK_DIR);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 10 * 60 * 1000) {
        rmSync(LOCK_DIR, { recursive: true, force: true });
        return acquireLock();
      }
      return { ok: false, reason: `locked (${Math.round(ageMs / 1000)}s old)` };
    } catch {
      return { ok: false, reason: "lock_unavailable" };
    }
  }
}

function compactCommandResult(result: CommandResult): JsonRecord {
  return {
    command: [result.command, ...result.args].join(" "),
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    json: result.json,
    error: result.error,
    stderrPreview: result.stderr.trim().slice(0, 800) || undefined,
  };
}

function extractStats(doctorJson: unknown): JsonRecord {
  const record = doctorJson && typeof doctorJson === "object" ? (doctorJson as JsonRecord) : {};
  const stats = record.stats && typeof record.stats === "object" ? (record.stats as JsonRecord) : {};
  const trail = stats.trail && typeof stats.trail === "object" ? (stats.trail as JsonRecord) : {};
  const jsonl = record.jsonl && typeof record.jsonl === "object" ? (record.jsonl as JsonRecord) : {};
  const capabilities = record.capabilities && typeof record.capabilities === "object" ? (record.capabilities as JsonRecord) : {};
  return {
    ok: Boolean(record.ok),
    total: Number(stats.total || 0),
    ftsRows: Number(stats.ftsRows || 0),
    semanticRows: Number(stats.semanticRows || 0),
    semanticEmbeddingRows: Number(stats.semanticEmbeddingRows || 0),
    jsonlFiles: Number(jsonl.files || 0),
    jsonlBytes: Number(jsonl.bytes || 0),
    sizeKb: Number(record.sizeKb || 0),
    capabilityCount: Number(capabilities.count || 0),
    trail: {
      rawEvents: Number(trail.rawEvents || 0),
      artifacts: Number(trail.artifacts || 0),
      signals: Number(trail.signals || 0),
      episodes: Number(trail.episodes || 0),
      memories: Number(trail.memories || 0),
    },
  };
}

function previousStats(status: JsonRecord | null): JsonRecord {
  return status?.stats && typeof status.stats === "object" ? (status.stats as JsonRecord) : {};
}

async function writeRun(status: JsonRecord) {
  ensureRuntimeDirs();
  writeFileSync(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(METRICS_PATH, buildMetrics(status), "utf8");
  const day = String(status.startedAt || nowIso()).slice(0, 10);
  await appendFile(path.join(RUNS_DIR, `${day}.jsonl`), `${JSON.stringify(status)}\n`, "utf8");
}

async function runHeartbeat(): Promise<JsonRecord> {
  const lock = acquireLock();
  if (!lock.ok) {
    const status = {
      kind: "agent-memory-heartbeat",
      ok: false,
      skipped: true,
      reason: lock.reason,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    };
    await writeRun(status);
    return status;
  }

  const started = Date.now();
  const startedAt = nowIso();
  const previousStatus = readStatus();
  const fullPipelinePlan = planFullPipeline(previousStatus);
  const steps: JsonRecord = {};

  const observeStartedAt = nowIso();
  const observe = runJsonCommand("agent-memory", ["observe", "--json", "--timeout-ms", "4000"], 20_000);
  const observeFinishedAt = nowIso();
  steps.observe = compactCommandResult(observe);

  const observeStatus = {
    lastStartedAt: observeStartedAt,
    lastFinishedAt: observeFinishedAt,
    lastOk: observe.ok,
    durationMs: observe.durationMs,
  };

  let stats = previousStats(previousStatus);
  let fullPipeline: JsonRecord;
  let fullPipelineSkipped: JsonRecord | undefined;
  let heartbeatOk = observe.ok;

  if (fullPipelinePlan.shouldRun) {
    const fullPipelineStartedMs = Date.now();
    const fullPipelineStartedAt = nowIso();
    const refresh = runJsonCommand(
      "agent-memory",
      [
        "refresh",
        "--since-hours",
        "24",
        "--limit-files",
        "40",
        "--x-limit",
        "100",
        "--tab-limit",
        "100",
        "--timeout-ms",
        "4000",
      ],
      60_000,
    );
    const dream = runJsonCommand("agent-memory", ["dream", "--since-hours", "24", "--limit", "240"], 60_000);
    const embed = runJsonCommand("agent-memory", ["embed", "--limit", "200", "--wait"], 60_000);
    // P3: proactive outreach. Best-effort Background-tier pings; a failed
    // delivery must not mark the whole heartbeat unhealthy, so it stays out of
    // fullPipelineOk and is recorded only as a step.
    const notify = runJsonCommand("agent-memory", ["notify", "--limit", "3"], 30_000);
    const doctor = runJsonCommand("agent-memory", ["doctor", "--json"], 30_000);
    const fullPipelineFinishedAt = nowIso();
    const fullPipelineOk =
      refresh.ok && dream.ok && embed.ok && doctor.ok && Boolean((doctor.json as JsonRecord | undefined)?.ok);

    steps.refresh = compactCommandResult(refresh);
    steps.dream = compactCommandResult(dream);
    steps.embed = compactCommandResult(embed);
    steps.notify = compactCommandResult(notify);
    steps.doctor = compactCommandResult(doctor);
    stats = extractStats(doctor.json);
    heartbeatOk = observe.ok && fullPipelineOk;
    fullPipeline = {
      intervalSeconds: fullPipelinePlan.intervalSeconds,
      skipped: false,
      lastStartedAt: fullPipelineStartedAt,
      lastFinishedAt: fullPipelineFinishedAt,
      lastOk: fullPipelineOk,
      durationMs: Date.now() - fullPipelineStartedMs,
      nextDueAt: new Date(Date.parse(fullPipelineFinishedAt) + fullPipelinePlan.intervalSeconds * 1000).toISOString(),
    };
  } else {
    fullPipelineSkipped = {
      reason: fullPipelinePlan.skippedReason,
      nextDueAt: fullPipelinePlan.nextDueAt,
    };
    fullPipeline = {
      intervalSeconds: fullPipelinePlan.intervalSeconds,
      skipped: true,
      skippedReason: fullPipelinePlan.skippedReason,
      lastStartedAt: fullPipelinePlan.lastStartedAt,
      lastFinishedAt: fullPipelinePlan.lastFinishedAt,
      lastOk: fullPipelinePlan.lastOk,
      durationMs: fullPipelinePlan.durationMs,
      nextDueAt: fullPipelinePlan.nextDueAt,
    };
    heartbeatOk = observe.ok && fullPipelinePlan.lastOk !== false;
  }

  const status: JsonRecord = {
    kind: "agent-memory-heartbeat",
    label: LABEL,
    ok: heartbeatOk,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - started,
    lastObserveAt: observeStatus.lastFinishedAt,
    lastFullPipelineAt: fullPipeline.lastFinishedAt,
    observe: observeStatus,
    fullPipeline,
    fullPipelineSkipped,
    steps,
    stats,
    runtime: {
      memoryRoot: MEMORY_ROOT,
      statusPath: STATUS_PATH,
      metricsPath: METRICS_PATH,
      runsDir: RUNS_DIR,
      logDir: LOG_DIR,
      plistPath: PLIST_PATH,
    },
  };

  try {
    await writeRun(status);
  } finally {
    lock.release();
  }

  return status;
}

async function heartbeat(args: string[]) {
  const jsonOutput = hasFlag(args, "--json");
  const status = await runHeartbeat();
  if (jsonOutput) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    const stats = status.stats as JsonRecord;
    if (status.skipped) {
      console.log(`agent-memory heartbeat skipped: ${status.reason}`);
    } else {
      console.log(
        `agent-memory heartbeat: ${status.ok ? "ok" : "failed"}; events=${stats.total}; fts=${stats.ftsRows}; semantic=${stats.semanticRows}; duration=${status.durationMs}ms`,
      );
    }
  }
  if (!status.ok) process.exitCode = 2;
}

function readStatus(): JsonRecord | null {
  if (!existsSync(STATUS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATUS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function launchdState(): JsonRecord {
  const installed = existsSync(PLIST_PATH);
  let loaded = false;
  let detail = "";
  const result = spawnSync("launchctl", ["print", `${guiTarget()}/${LABEL}`], {
    encoding: "utf8",
    timeout: 5000,
  });
  loaded = result.status === 0;
  detail = loaded ? result.stdout || "" : result.stderr || result.stdout || result.error?.message || "";
  const state = detail.match(/\n\tstate = ([^\n]+)/)?.[1]?.trim() || "";
  const runs = Number.parseInt(detail.match(/\n\truns = (\d+)/)?.[1] || "0", 10);
  const lastExitCode = Number.parseInt(detail.match(/\n\tlast exit code = (-?\d+)/)?.[1] || "0", 10);
  const runIntervalSeconds = Number.parseInt(detail.match(/\n\trun interval = (\d+) seconds/)?.[1] || "0", 10);
  return {
    label: LABEL,
    plistPath: PLIST_PATH,
    installed,
    loaded,
    state: state || (loaded ? "unknown" : "not_loaded"),
    runs: Number.isFinite(runs) ? runs : 0,
    lastExitCode: Number.isFinite(lastExitCode) ? lastExitCode : null,
    runIntervalSeconds: Number.isFinite(runIntervalSeconds) ? runIntervalSeconds : null,
  };
}

function summarizeStatus(status: JsonRecord | null, launchd: JsonRecord) {
  if (!status) {
    console.log("agent-memory ops: no heartbeat status yet");
    console.log(`launchd: installed=${launchd.installed} loaded=${launchd.loaded}`);
    return;
  }
  const stats = (status.stats || {}) as JsonRecord;
  const observe = (status.observe || {}) as JsonRecord;
  const fullPipeline = (status.fullPipeline || {}) as JsonRecord;
  const skipped = (status.fullPipelineSkipped || {}) as JsonRecord;
  console.log(`agent-memory ops: ${status.ok ? "ok" : "needs_attention"}`);
  console.log(`last_run: ${status.finishedAt || status.startedAt} (${status.durationMs || 0}ms)`);
  console.log(`last_observe: ${observe.lastFinishedAt || "unknown"} (${observe.durationMs || 0}ms)`);
  console.log(
    `full_pipeline: last=${fullPipeline.lastFinishedAt || "never"} ok=${String(fullPipeline.lastOk ?? "unknown")} next=${fullPipeline.nextDueAt || "unknown"}`,
  );
  if (skipped.reason) console.log(`full_pipeline_skipped: ${skipped.reason}`);
  console.log(
    `memory: events=${stats.total || 0} fts=${stats.ftsRows || 0} semantic=${stats.semanticRows || 0} size=${stats.sizeKb || 0}KiB`,
  );
  console.log(`launchd: installed=${launchd.installed} loaded=${launchd.loaded} label=${LABEL}`);
  console.log(`status: ${STATUS_PATH}`);
  console.log(`metrics: ${METRICS_PATH}`);
  console.log(`logs: ${LOG_DIR}`);
}

async function status(args: string[]) {
  const jsonOutput = hasFlag(args, "--json");
  let current = readStatus();
  if (hasFlag(args, "--live")) {
    await runHeartbeat();
    current = readStatus();
  }
  const output = {
    ok: Boolean(current?.ok),
    status: current,
    launchd: launchdState(),
    paths: {
      statusPath: STATUS_PATH,
      metricsPath: METRICS_PATH,
      runsDir: RUNS_DIR,
      logDir: LOG_DIR,
      plistPath: PLIST_PATH,
    },
  };
  if (jsonOutput) console.log(JSON.stringify(output, null, 2));
  else summarizeStatus(current, output.launchd);
}

function plist(intervalSeconds: number): string {
  const bun = process.env.BUN_PATH || path.join(HOME, ".bun", "bin", "bun");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${bun}</string>
      <string>${THIS_FILE}</string>
      <string>heartbeat</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>PATH</key>
      <string>${commandPath()}</string>
      <key>AGENT_MEMORY_ROOT</key>
      <string>${MEMORY_ROOT}</string>
      <key>AI_API_KEY</key>
      <string></string>
      <key>OPENAI_API_KEY</key>
      <string></string>
      <key>GEMINI_API_KEY</key>
      <string></string>
      <key>GEMINI_API_KEYS</key>
      <string></string>
      <key>ANTHROPIC_API_KEY</key>
      <string></string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>

    <key>StandardOutPath</key>
    <string>${path.join(LOG_DIR, "heartbeat.out.log")}</string>

    <key>StandardErrorPath</key>
    <string>${path.join(LOG_DIR, "heartbeat.err.log")}</string>
  </dict>
</plist>
`;
}

function guiTarget(): string {
  return `gui/${process.getuid?.() || Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim())}`;
}

function install(args: string[]) {
  ensureRuntimeDirs();
  const intervalSeconds = Math.max(DEFAULT_INTERVAL_SECONDS, argNumber(args, "--interval-seconds", DEFAULT_INTERVAL_SECONDS));
  writeFileSync(PLIST_PATH, plist(intervalSeconds), "utf8");
  spawnSync("launchctl", ["bootout", guiTarget(), PLIST_PATH], { stdio: "ignore" });
  const bootstrap = spawnSync("launchctl", ["bootstrap", guiTarget(), PLIST_PATH], {
    encoding: "utf8",
  });
  if (bootstrap.status !== 0) {
    console.error(bootstrap.stderr || bootstrap.stdout || "launchctl bootstrap failed");
    process.exit(2);
  }
  const kick = spawnSync("launchctl", ["kickstart", "-k", `${guiTarget()}/${LABEL}`], {
    encoding: "utf8",
  });
  if (kick.status !== 0) {
    console.error(kick.stderr || kick.stdout || "launchctl kickstart failed");
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, label: LABEL, plistPath: PLIST_PATH, intervalSeconds }, null, 2));
}

function uninstall() {
  spawnSync("launchctl", ["bootout", guiTarget(), PLIST_PATH], { stdio: "ignore" });
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
  console.log(JSON.stringify({ ok: true, label: LABEL, removed: PLIST_PATH }, null, 2));
}

function kick() {
  const result = spawnSync("launchctl", ["kickstart", "-k", `${guiTarget()}/${LABEL}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || "launchctl kickstart failed");
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, label: LABEL }, null, 2));
}

function metrics() {
  if (!existsSync(METRICS_PATH)) {
    console.error(`metrics not found: ${METRICS_PATH}`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(METRICS_PATH, "utf8"));
}

function logs(args: string[]) {
  const lines = String(argNumber(args, "--lines", 80));
  const outLog = path.join(LOG_DIR, "heartbeat.out.log");
  const errLog = path.join(LOG_DIR, "heartbeat.err.log");
  console.log(`== ${outLog} ==`);
  if (existsSync(outLog)) spawnSync("tail", ["-n", lines, outLog], { stdio: "inherit" });
  else console.log("(missing)");
  console.log(`== ${errLog} ==`);
  if (existsSync(errLog)) spawnSync("tail", ["-n", lines, errLog], { stdio: "inherit" });
  else console.log("(missing)");
}

function installWrappers() {
  const targets = [path.join(HOME, ".agents", "bin"), path.join(HOME, ".local", "bin")];
  const bins = {
    "agent-memory": path.join(ROOT, "src", "main.ts"),
    "agent-memory-ops": path.join(ROOT, "src", "ops.ts"),
    "agent-memory-ui": path.join(ROOT, "src", "ui-server.ts"),
    "agent-recall": path.join(ROOT, "src", "recall.ts"),
  };
  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    for (const [name, source] of Object.entries(bins)) {
      const target = path.join(dir, name);
      try {
        if (existsSync(target)) {
          const stats = statSync(target);
          if (stats.isSymbolicLink() || stats.isFile()) {
            unlinkSync(target);
          }
        }
        // Create a small shim instead of a direct symlink if we want to ensure 'bun' is used
        const shim = `#!/bin/sh\nexec bun ${source} "$@"\n`;
        writeFileSync(target, shim, { mode: 0o755 });
      } catch (err) {
        console.error(`failed to install wrapper ${target}: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    }
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") usage(0);
  if (cmd === "heartbeat") return heartbeat(args);
  if (cmd === "status") return status(args);
  if (cmd === "metrics") return metrics();
  if (cmd === "install") return install(args);
  if (cmd === "uninstall") return uninstall();
  if (cmd === "kick") return kick();
  if (cmd === "logs") return logs(args);
  if (cmd === "install-wrappers") return installWrappers();
  usage(1);
}

await main();
