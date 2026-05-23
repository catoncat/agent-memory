import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AppConfig {
  memoryRoot: string;
  ai: {
    baseUrl: string;
    apiKey: string;
    modelFast: string;
    modelBalanced: string;
    modelStrong: string;
    timeoutMs: number;
  };
  gemini: {
    apiKeys: string[];
    embedModel: string;
    embedDimension: number;
  };
}

const DEFAULT_ROOT = path.join(homedir(), ".agents", "memory");

export function loadConfig(): AppConfig {
  const memoryRoot = process.env.AGENT_MEMORY_ROOT || DEFAULT_ROOT;
  const configPath = path.join(memoryRoot, "config.json");

  let fileConfig: any = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e) {
      console.error(`Failed to parse config file at ${configPath}:`, e);
    }
  }

  // Helper to get config with priority: Environment > Config File > Default
  const get = (envKey: string, fileKey: string, defaultValue: any) => {
    return process.env[envKey] || fileConfig[fileKey] || defaultValue;
  };

  return {
    memoryRoot,
    ai: {
      baseUrl: get("AI_BASE_URL", "ai_base_url", "https://ai.chen.rs/v1"),
      apiKey: get("AI_API_KEY", "ai_api_key", process.env.OPENAI_API_KEY || ""),
      modelFast: get("AI_MODEL_FAST", "ai_model_fast", "gpt-5.4-mini"),
      modelBalanced: get("AI_MODEL_BALANCED", "ai_model_balanced", "gpt-5.5"),
      modelStrong: get("AI_MODEL_STRONG", "ai_model_strong", "gpt-5.5"),
      timeoutMs: Number(get("AI_TIMEOUT_MS", "ai_timeout_ms", 30000)),
    },
    gemini: {
      apiKeys: (get("GEMINI_API_KEYS", "gemini_api_keys", process.env.GEMINI_API_KEY || ""))
        .split(/[,\n]/)
        .map((k: string) => k.trim())
        .filter(Boolean),
      embedModel: get("GEMINI_EMBED_MODEL", "gemini_embed_model", "gemini-embedding-2"),
      embedDimension: Number(get("GEMINI_EMBED_DIMENSION", "gemini_embed_dimension", 768)),
    },
  };
}

export function ensureConfigDir(config: AppConfig) {
  if (!existsSync(config.memoryRoot)) {
    mkdirSync(config.memoryRoot, { recursive: true });
  }
}
