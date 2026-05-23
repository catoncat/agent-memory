import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";

export type AiTaskType =
  | "extract"
  | "classify"
  | "rewrite"
  | "summarize"
  | "translate"
  | "plan"
  | "qa"
  | "coding"
  | "reasoning";

export type AiEffort = "fast" | "balanced" | "strong";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiClientConfig {
  baseUrl: string;
  apiKey: string;
  modelFast: string;
  modelBalanced: string;
  modelStrong: string;
  timeoutMs: number;
}

export interface ChatOptions {
  task?: AiTaskType;
  effort?: AiEffort;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseJson?: boolean;
}

export interface ChatResult {
  model: string;
  content: string;
  raw: unknown;
}

// DEFAULTS are now managed via loadConfig() in ./config.ts


const FAST_TASKS = new Set<AiTaskType>([
  "extract",
  "classify",
  "rewrite",
  "summarize",
  "translate",
]);

const STRONG_TASKS = new Set<AiTaskType>(["plan", "coding", "reasoning"]);

function sanitizeApiKey(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) return "";
  // Header 值必须是可打印 ASCII，避免 fetch 抛 invalid header。
  if (/[^\x20-\x7E]/.test(value)) return "";
  return value;
}

export function loadAiConfig(overrides: Partial<AiClientConfig> = {}): AiClientConfig {
  const config = loadConfig();
  return {
    ...config.ai,
    ...overrides,
  };
}

export function pickModel(
  config: AiClientConfig,
  task: AiTaskType = "qa",
  effort: AiEffort = "balanced"
): string {
  if (effort === "fast") return config.modelFast;
  if (effort === "strong") return config.modelStrong;

  if (STRONG_TASKS.has(task)) return config.modelStrong;
  if (FAST_TASKS.has(task)) return config.modelFast;
  return config.modelBalanced;
}

function extractJsonBlock(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) return objectMatch[0];

  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch?.[0]) return arrayMatch[0];

  return trimmed;
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
  overrides: Partial<AiClientConfig> = {}
): Promise<ChatResult> {
  const config = loadAiConfig(overrides);
  if (!config.apiKey) {
    throw new Error("缺少 AI API Key：请设置 AI_API_KEY 或 OPENAI_API_KEY（不再提供硬编码默认值）");
  }

  const model = options.model || pickModel(config, options.task || "qa", options.effort || "balanced");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.3,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.responseJson ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI 请求失败: ${response.status} ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const content = data.choices?.[0]?.message?.content?.trim() || "";
    return {
      model: data.model || model,
      content,
      raw: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Embedding (Gemini) ──────────────────────────

const DEFAULT_GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_GEMINI_EMBED_MODEL = "gemini-embedding-2";
const DEFAULT_GEMINI_EMBED_DIMENSION = 768;
const DEFAULT_GEMINI_EMBED_BATCH_SIZE = 50;
const DEFAULT_GEMINI_EMBED_ITEMS_PER_MINUTE = 55;

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function getGeminiEmbedConfig() {
  const config = loadConfig();
  return {
    baseUrl: "https://generativelanguage.googleapis.com", // Hardcoded as Gemini API base
    model: config.gemini.embedModel,
    modelPath: `models/${config.gemini.embedModel}`,
    outputDimensionality: config.gemini.embedDimension,
    batchSize: 50,
    itemsPerMinute: 55,
    batchUrl: `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.embedModel}:batchEmbedContents`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || /aborted/i.test(err.message);
}

function postJsonWithCurl(url: string, body: string, timeoutMs: number): unknown {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const marker = "__CURL_HTTP_STATUS__:";
  const result = spawnSync(
    "curl",
    [
      "-sS",
      "--max-time",
      String(timeoutSeconds),
      "-X",
      "POST",
      url,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
      "-w",
      `\n${marker}%{http_code}`,
    ],
    {
      input: body,
      encoding: "utf-8",
      timeout: timeoutMs + 1000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`curl 请求失败: ${result.error.message}`);
  }

  const output = result.stdout || "";
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex < 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`curl 返回异常${stderr ? `: ${stderr.slice(0, 300)}` : ""}`);
  }

  const responseText = output.slice(0, markerIndex).trim();
  const httpCode = Number.parseInt(output.slice(markerIndex + marker.length).trim(), 10);
  if (!Number.isFinite(httpCode)) {
    throw new Error("curl 返回了无效的 HTTP 状态码");
  }
  if (httpCode < 200 || httpCode >= 300) {
    throw new Error(`Gemini Embedding 失败(curl): ${httpCode} ${responseText.slice(0, 300)}`);
  }

  return JSON.parse(responseText);
}

async function postJson(
  url: string,
  payload: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {},
  useCurlOnAbort = false,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = JSON.stringify(payload);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      signal: controller.signal,
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Embedding 失败: ${res.status} ${errText.slice(0, 300)}`);
    }

    return await res.json();
  } catch (err) {
    if (useCurlOnAbort && isAbortLikeError(err)) {
      return postJsonWithCurl(url, body, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isGeminiEmbedding2(model: string): boolean {
  return model === "gemini-embedding-2";
}

function isGeminiKeyRetryableError(message: string): boolean {
  return message.includes("429") || /API_KEY_INVALID/i.test(message);
}

function prepareGemini2Document(text: string): string {
  return text.startsWith("title: ") ? text : `title: none | text: ${text}`;
}

function prepareGemini2Query(text: string): string {
  return text.startsWith("task: ") ? text : `task: search result | query: ${text}`;
}

function geminiEmbedRequest(modelPath: string, text: string, kind: "document" | "query", outputDimensionality: number) {
  const model = modelPath.replace(/^models\//, "");
  if (isGeminiEmbedding2(model)) {
    return {
      model: modelPath,
      content: {
        parts: [
          {
            text: kind === "document" ? prepareGemini2Document(text) : prepareGemini2Query(text),
          },
        ],
      },
      output_dimensionality: outputDimensionality,
    };
  }

  return {
    model: modelPath,
    content: { parts: [{ text }] },
    taskType: kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
    outputDimensionality,
  };
}

export async function embed(
  texts: string[],
  opts: {
    apiKey?: string;
    timeoutMs?: number;
    onBatch?: (batchStart: number, vectors: number[][]) => void | Promise<void>;
    waitOnRateLimit?: boolean;
  } = {},
): Promise<number[][]> {
  const apiKeys = getGeminiApiKeys(opts.apiKey);
  if (apiKeys.length === 0) {
    throw new Error("缺少 GEMINI_API_KEY 或 GEMINI_API_KEYS 环境变量");
  }

  const results: number[][] = [];
  const embedConfig = getGeminiEmbedConfig();
  const keyStates = apiKeys.map((apiKey) => ({
    apiKey,
    windowStartedAt: Date.now(),
    sentInWindow: 0,
    exhaustedUntil: 0,
  }));
  let keyCursor = 0;

  for (let i = 0; i < texts.length; i += embedConfig.batchSize) {
    const batch = texts.slice(i, i + embedConfig.batchSize);

    let data: { embeddings: Array<{ values: number[] }> } | null = null;
    const maxAttempts = Math.max(3, apiKeys.length * 3);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const keyState = await pickGeminiKeyState(
        keyStates,
        embedConfig.itemsPerMinute,
        batch.length,
        keyCursor,
        opts.waitOnRateLimit ?? true,
      );
      keyCursor = (keyStates.indexOf(keyState) + 1) % keyStates.length;
      try {
        data = (await postJson(
          embedConfig.batchUrl,
          {
            requests: batch.map((text) =>
              geminiEmbedRequest(embedConfig.modelPath, text, "document", embedConfig.outputDimensionality),
            ),
          },
          opts.timeoutMs ?? 30000,
          { "x-goog-api-key": keyState.apiKey },
          false,
        )) as {
          embeddings: Array<{ values: number[] }>;
        };
        keyState.sentInWindow += batch.length;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isGeminiKeyRetryableError(message) || attempt === maxAttempts) throw error;
        if (message.includes("429")) {
          keyState.exhaustedUntil = Date.now() + 65000;
          console.log(`  Gemini key rate limited: rotate (${apiKeys.length} keys available)`);
        } else {
          console.log(`  Gemini key rejected: rotate (${apiKeys.length} keys available)`);
        }
      }
    }

    const vectors = (data?.embeddings || []).map((e) => e.values);
    if (opts.onBatch) {
      await opts.onBatch(i, vectors);
    }
    for (const vector of vectors) {
      results.push(vector);
    }
  }

  return results;
}

export async function embedQuery(
  text: string,
  opts: { apiKey?: string; timeoutMs?: number } = {},
): Promise<number[]> {
  const apiKeys = getGeminiApiKeys(opts.apiKey);
  if (apiKeys.length === 0) {
    throw new Error("缺少 GEMINI_API_KEY 或 GEMINI_API_KEYS 环境变量");
  }

  const embedConfig = getGeminiEmbedConfig();
  let data: { embeddings: Array<{ values: number[] }> } | null = null;
  for (let attempt = 1; attempt <= apiKeys.length; attempt += 1) {
    try {
      data = (await postJson(
        embedConfig.batchUrl,
        {
          requests: [
            geminiEmbedRequest(embedConfig.modelPath, text, "query", embedConfig.outputDimensionality),
          ],
        },
        opts.timeoutMs ?? 30000,
        { "x-goog-api-key": apiKeys[attempt - 1] },
        false,
      )) as {
        embeddings: Array<{ values: number[] }>;
      };
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isGeminiKeyRetryableError(message) || attempt === apiKeys.length) throw error;
    }
  }
  if (!data) throw new Error("Gemini Embedding 查询失败：没有可用的 API key");
  return data.embeddings[0].values;
}

function getGeminiApiKeys(override?: string): string[] {
  if (override) return override.split(/[,\n]/).map(k => k.trim()).filter(Boolean);
  return loadConfig().gemini.apiKeys;
}

async function pickGeminiKeyState<T extends {
  apiKey: string;
  windowStartedAt: number;
  sentInWindow: number;
  exhaustedUntil: number;
}>(
  states: T[],
  itemsPerMinute: number,
  batchLength: number,
  startIndex: number,
  waitOnRateLimit: boolean,
): Promise<T> {
  while (true) {
    const now = Date.now();
    for (let offset = 0; offset < states.length; offset += 1) {
      const state = states[(startIndex + offset) % states.length];
      if (state.exhaustedUntil > now) continue;
      if (now - state.windowStartedAt >= 61000) {
        state.windowStartedAt = now;
        state.sentInWindow = 0;
      }
      if (state.sentInWindow + batchLength <= itemsPerMinute) {
        return state;
      }
    }

    const waits = states.map((state) => {
      if (state.exhaustedUntil > now) return state.exhaustedUntil - now;
      return Math.max(0, 61000 - (now - state.windowStartedAt));
    });
    const waitMs = Math.max(1000, Math.min(...waits));
    if (!waitOnRateLimit) {
      throw new Error(`Gemini free-tier pacing required: wait ${Math.ceil(waitMs / 1000)}s`);
    }
    console.log(`  Gemini free-tier pacing: wait ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
}

export async function chatJson<T>(
  messages: ChatMessage[],
  options: ChatOptions = {},
  overrides: Partial<AiClientConfig> = {}
): Promise<{ model: string; data: T; text: string }> {
  const result = await chat(messages, { ...options, responseJson: options.responseJson ?? true }, overrides);
  const jsonText = extractJsonBlock(result.content);
  try {
    return {
      model: result.model,
      data: JSON.parse(jsonText) as T,
      text: result.content,
    };
  } catch (error) {
    throw new Error(
      `AI JSON 解析失败: ${error instanceof Error ? error.message : String(error)}\n原始内容: ${result.content.slice(0, 500)}`
    );
  }
}
