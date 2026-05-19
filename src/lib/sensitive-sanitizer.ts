import { chatJson } from "./ai-client";

export interface SanitizationOptions {
  useAi?: boolean;
}

export interface SanitizationReplacement {
  source: "rule" | "ai";
  label: string;
  count: number;
  reason?: string;
}

export interface SanitizationResult {
  content: string;
  changed: boolean;
  replacements: SanitizationReplacement[];
  aiSkippedReason?: string;
}

type Rule = {
  label: string;
  regex: RegExp;
  replacer: (full: string, ...groups: string[]) => string;
};

const TRUSTED_PUBLIC_ASSET_HOSTS = new Set([
  "img.chen.rs",
  "i.chen.rs",
]);

function shouldKeepToken(token: string): boolean {
  const value = token.trim();
  if (!value) return true;

  return (
    value.startsWith("$") ||
    value.startsWith("<") ||
    value.includes("xxx") ||
    value.includes("...") ||
    value.toLowerCase().includes("redacted")
  );
}

function extractHttpUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s)"'`<>]+/g) || [];
}

function normalizeUrlCandidate(url: string): string {
  return url.replace(/[),.;!?]+$/g, "");
}

function isTrustedPublicAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(normalizeUrlCandidate(url));
    return TRUSTED_PUBLIC_ASSET_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function shouldKeepPublicAssetFragment(fragment: string): boolean {
  const urls = extractHttpUrls(fragment);
  return urls.some((url) => isTrustedPublicAssetUrl(url));
}



function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function shouldKeepIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "0.0.0.0" || ip === "100.100.100.100";
}
function applyRule(content: string, rule: Rule): { content: string; count: number } {
  let count = 0;

  const replaced = content.replace(rule.regex, (...args) => {
    const full = args[0] as string;
    const replacement = rule.replacer(full, ...(args.slice(1, -2) as string[]));
    if (replacement !== full) {
      count += 1;
    }
    return replacement;
  });

  return { content: replaced, count };
}

function applyDeterministicRules(input: string): {
  content: string;
  replacements: SanitizationReplacement[];
} {
  const rules: Rule[] = [
    {
      label: "public-ipv4",
      regex: /\b((?:\d{1,3}\.){3}\d{1,3})(:\d{1,5})?\b/g,
      replacer: (full, ip, port) => {
        if (!isValidIpv4(ip) || shouldKeepIp(ip)) return full;
        return `<REDACTED_IP>${port || ""}`;
      },
    },
    {
      label: "ssh-fingerprint",
      regex: /SHA256:[A-Za-z0-9+/=]{16,}/g,
      replacer: () => "SHA256:<REDACTED_FINGERPRINT>",
    },
    {
      label: "authorization-bearer",
      regex: /(Authorization:\s*Bearer\s+)([^\s`"']+)/gi,
      replacer: (full, prefix, token) => {
        if (shouldKeepToken(token)) return full;
        return `${prefix}<REDACTED_TOKEN>`;
      },
    },
    {
      label: "share-api-key",
      regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
      replacer: (full) => {
        if (shouldKeepToken(full)) return full;
        return "<REDACTED_API_KEY>";
      },
    },
    {
      label: "hysteria2-uri-auth",
      regex: /(hysteria2:\/\/)([^@\s/?#]+)@/g,
      replacer: (full, prefix, auth) => {
        if (shouldKeepToken(auth)) return full;
        return `${prefix}<REDACTED_AUTH>@`;
      },
    },
    {
      label: "base64-decoded-comment",
      regex: /(base64\s+-d\)\s*#\s*)([^\n]+)/g,
      replacer: (full, prefix, secret) => {
        if (shouldKeepToken(secret)) return full;
        return `${prefix}<REDACTED_COMMENT_SECRET>`;
      },
    },
    {
      label: "cloudflare-tunnel-id",
      regex: /(^\s*tunnel:\s*)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gim,
      replacer: (full, prefix, tunnelId) => {
        if (shouldKeepToken(tunnelId)) return full;
        return `${prefix}<TUNNEL_ID>`;
      },
    },
    {
      label: "cloudflare-credentials-file-id",
      regex: /(^\s*credentials-file:\s*.*\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.json\s*$)/gim,
      replacer: (full, prefix, tunnelId, suffix) => {
        if (shouldKeepToken(tunnelId)) return full;
        return `${prefix}<TUNNEL_ID>${suffix}`;
      },
    },
    {
      label: "url-query-token",
      regex: /(\?token=)([A-Za-z0-9._-]{8,})/g,
      replacer: (full, prefix, token) => {
        if (shouldKeepToken(token)) return full;
        return `${prefix}<REDACTED_TOKEN>`;
      },
    },
  ];

  let content = input;
  const replacements: SanitizationReplacement[] = [];

  for (const rule of rules) {
    const result = applyRule(content, rule);
    content = result.content;
    if (result.count > 0) {
      replacements.push({
        source: "rule",
        label: rule.label,
        count: result.count,
      });
    }
  }

  return { content, replacements };
}

function canUseAi(): boolean {
  return Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);
}

type AiRedactionResponse = {
  replacements?: Array<{
    from?: string;
    to?: string;
    reason?: string;
  }>;
};

function looksLikeCodeOrFormula(fragment: string): boolean {
  const s = fragment.trim();
  // 短变量名/函数调用：S1, S2, f(x), Value(x), S1(fast, auto)
  if (/^[A-Za-z_]\w{0,15}\(.*\)$/.test(s)) return true;
  // 纯变量名：S1, S2, SYSTEM, WYSIATI 等
  if (/^[A-Z][A-Z0-9_]{0,15}$/.test(s)) return true;
  // 数学表达式：|x|, x^0.88, w ~ 2.0
  if (/[|^~=]/.test(s) && !/[@:\/]/.test(s)) return true;
  // ASCII art 片段：+---, |  , +--->
  if (/^[+|\-\s><=]{4,}$/.test(s)) return true;
  return false;
}

function isInsideCodeBlock(content: string, fragment: string): boolean {
  const idx = content.indexOf(fragment);
  if (idx === -1) return false;
  const before = content.slice(0, idx);
  // 计算 ``` 的出现次数，奇数说明在代码块内
  const fenceCount = (before.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) return true;
  // 行内代码：检查同一行内 ` 的奇偶
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineBeforeFragment = before.slice(lineStart);
  const backtickCount = (lineBeforeFragment.match(/`/g) || []).length;
  return backtickCount % 2 === 1;
}

function validateAiReplacement(from: string, to: string, content?: string): boolean {
  if (!from || !to) return false;
  if (from.length < 4 || from.length > 120) return false;
  if (to.length < 10 || to.length > 80) return false;
  if (!to.startsWith("<REDACTED_")) return false;
  if (!to.endsWith(">")) return false;
  if (from.includes("\n")) return false;
  if (shouldKeepToken(from)) return false;
  if (shouldKeepPublicAssetFragment(from)) return false;
  if (looksLikeCodeOrFormula(from)) return false;
  if (content && isInsideCodeBlock(content, from)) return false;
  return true;
}

function replaceAllByText(content: string, from: string, to: string): { content: string; count: number } {
  if (!content.includes(from)) {
    return { content, count: 0 };
  }

  const parts = content.split(from);
  const count = parts.length - 1;

  if (count <= 0) {
    return { content, count: 0 };
  }

  return {
    content: parts.join(to),
    count,
  };
}

async function applyAiRules(input: string): Promise<{
  content: string;
  replacements: SanitizationReplacement[];
  skippedReason?: string;
}> {
  if (!canUseAi()) {
    return {
      content: input,
      replacements: [],
      skippedReason: "未检测到 AI_API_KEY / OPENAI_API_KEY，跳过 AI 脱敏",
    };
  }

  if (input.length > 30000) {
    return {
      content: input,
      replacements: [],
      skippedReason: "内容超过 30000 字符，跳过 AI 脱敏",
    };
  }

  try {
    const { data } = await chatJson<AiRedactionResponse>(
      [
        {
          role: "system",
          content:
            "你是安全脱敏助手。你只负责找出文本中真正的敏感凭证并替换，绝不动其他内容。",
        },
        {
          role: "user",
          content: `请只返回 JSON，格式如下：
{"replacements":[{"from":"原文片段","to":"<REDACTED_TOKEN>","reason":"原因"}]}

只替换以下类型（白名单，不在列表内的一律不动）：
- 真实的 API Key / Secret Key（如 sk-proj-xxx, ghp_xxx, AKIA 开头等）
- 真实的密码、认证密钥（出现在 password=, secret=, auth: 等上下文中的值）
- 私有 IP 地址（10.x, 172.16-31.x, 192.168.x，但不包括 127.0.0.1）
- 真实的手机号、身份证号、银行卡号
- 私钥内容（-----BEGIN PRIVATE KEY----- 等）

绝对不要替换：
- 变量名、函数名、类名（如 S1, S2, SYSTEM, Value(x)）
- 数学公式和表达式
- ASCII art 和结构图
- 公开 URL 和图片链接
- 占位符（$API_KEY, <TOKEN>, xxx）
- 代码示例中的示意值（如 example.com, user@example.com）
- Markdown 格式符号

from 必须是原文中存在的精确片段且尽量短，to 必须是 <REDACTED_XXX> 形式。
如果没有发现上述类型的敏感信息，返回空数组 {"replacements":[]}。
最多返回 12 条。

待处理文本：

${input}`,
        },
      ],
      {
        task: "extract",
        effort: "balanced",
        maxTokens: 1200,
      }
    );

    const raw = Array.isArray(data.replacements) ? data.replacements.slice(0, 12) : [];

    let content = input;
    const replacements: SanitizationReplacement[] = [];

    for (const item of raw) {
      const from = item.from?.trim() || "";
      const to = item.to?.trim() || "";
      if (!validateAiReplacement(from, to, content)) {
        continue;
      }

      const replaced = replaceAllByText(content, from, to);
      if (replaced.count <= 0) {
        continue;
      }

      content = replaced.content;
      replacements.push({
        source: "ai",
        label: "ai-sensitive-fragment",
        count: replaced.count,
        reason: item.reason,
      });
    }

    return { content, replacements };
  } catch (error) {
    return {
      content: input,
      replacements: [],
      skippedReason: `AI 脱敏失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function sanitizeSensitiveContent(
  input: string,
  options: SanitizationOptions = {}
): Promise<SanitizationResult> {
  const deterministic = applyDeterministicRules(input);

  let content = deterministic.content;
  const replacements: SanitizationReplacement[] = [...deterministic.replacements];
  let aiSkippedReason: string | undefined;

  if (options.useAi !== false) {
    const aiResult = await applyAiRules(content);
    content = aiResult.content;
    replacements.push(...aiResult.replacements);
    aiSkippedReason = aiResult.skippedReason;
  }

  return {
    content,
    changed: content !== input,
    replacements,
    aiSkippedReason,
  };
}
