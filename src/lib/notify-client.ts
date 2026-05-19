export type NotifyChannel = "ntfy" | "telegram" | "bark" | "all";
export type NotifyPriority = "low" | "default" | "high" | "urgent";

export interface NotifyMessage {
  title: string;
  body: string;
  priority?: NotifyPriority;
  tags?: string[];
}

export interface NtfyConfig {
  server: string;
  topic: string;
  priority?: NotifyPriority;
  token?: string;
  username?: string;
  password?: string;
}

export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
  message_thread_id?: number;
  disable_preview?: boolean;
}

export interface BarkConfig {
  server: string;
  key: string;
}

export interface UnifiedNotifyConfig {
  default: NotifyChannel;
  ntfy?: NtfyConfig;
  telegram?: TelegramConfig;
  bark?: BarkConfig;
}

export interface NotifyDispatchResult {
  channel: Exclude<NotifyChannel, "all">;
  ok: boolean;
  error?: string;
}

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function mapNtfyPriority(priority?: NotifyPriority): number | undefined {
  switch (priority) {
    case "low":
      return 2;
    case "default":
      return 3;
    case "high":
      return 4;
    case "urgent":
      return 5;
    default:
      return undefined;
  }
}

function overlayConfigByEnv(config: UnifiedNotifyConfig): UnifiedNotifyConfig {
  const envDefault = process.env.NOTIFY_DEFAULT_CHANNEL as NotifyChannel | undefined;
  const defaultChannel = envDefault || config.default;

  const ntfyServer = process.env.NOTIFY_NTFY_SERVER;
  const ntfyTopic = process.env.NOTIFY_NTFY_TOPIC;

  const telegramBotToken = process.env.NOTIFY_TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.NOTIFY_TELEGRAM_CHAT_ID;

  const barkServer = process.env.NOTIFY_BARK_SERVER;
  const barkKey = process.env.NOTIFY_BARK_KEY;

  const merged: UnifiedNotifyConfig = {
    ...config,
    default: defaultChannel,
  };

  if (config.ntfy || ntfyServer || ntfyTopic) {
    merged.ntfy = {
      server: ntfyServer || config.ntfy?.server || "",
      topic: ntfyTopic || config.ntfy?.topic || "",
      priority: (process.env.NOTIFY_NTFY_PRIORITY as NotifyPriority | undefined) || config.ntfy?.priority,
      token: process.env.NOTIFY_NTFY_TOKEN || config.ntfy?.token,
      username: process.env.NOTIFY_NTFY_USERNAME || config.ntfy?.username,
      password: process.env.NOTIFY_NTFY_PASSWORD || config.ntfy?.password,
    };
  }

  if (config.telegram || telegramBotToken || telegramChatId) {
    const threadRaw = process.env.NOTIFY_TELEGRAM_THREAD_ID;
    merged.telegram = {
      bot_token: telegramBotToken || config.telegram?.bot_token || "",
      chat_id: telegramChatId || config.telegram?.chat_id || "",
      message_thread_id: threadRaw ? Number(threadRaw) : config.telegram?.message_thread_id,
      disable_preview: process.env.NOTIFY_TELEGRAM_DISABLE_PREVIEW
        ? process.env.NOTIFY_TELEGRAM_DISABLE_PREVIEW === "true"
        : config.telegram?.disable_preview,
    };
  }

  if (config.bark || barkServer || barkKey) {
    merged.bark = {
      server: barkServer || config.bark?.server || "",
      key: barkKey || config.bark?.key || "",
    };
  }

  return merged;
}

export async function sendViaNtfy(config: NtfyConfig, message: NotifyMessage): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    } else if (config.username && config.password) {
      const encoded = Buffer.from(`${config.username}:${config.password}`).toString("base64");
      headers.Authorization = `Basic ${encoded}`;
    }

    const payload: Record<string, unknown> = {
      topic: config.topic,
      title: message.title,
      message: message.body,
    };

    const mappedPriority = mapNtfyPriority(message.priority || config.priority);
    if (mappedPriority) {
      payload.priority = mappedPriority;
    }

    if (message.tags?.length) {
      payload.tags = message.tags;
    }

    const response = await fetch(normalizeServerUrl(config.server), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `ntfy ${response.status}: ${text.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: `ntfy error: ${String(error)}` };
  }
}

export async function sendViaTelegram(config: TelegramConfig, message: NotifyMessage): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: config.chat_id,
      text: `${message.title}\n${message.body}`.trim(),
      disable_web_page_preview: config.disable_preview ?? true,
    };

    if (config.message_thread_id) {
      payload.message_thread_id = config.message_thread_id;
    }

    const response = await fetch(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `telegram ${response.status}: ${text.slice(0, 200)}` };
    }

    const data = (await response.json()) as { ok?: boolean; description?: string };
    if (data.ok === false) {
      return { ok: false, error: `telegram api: ${data.description || "unknown"}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: `telegram error: ${String(error)}` };
  }
}

export async function sendViaBark(config: BarkConfig, message: NotifyMessage): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${normalizeServerUrl(config.server)}/${config.key}/${encodeURIComponent(message.title)}/${encodeURIComponent(message.body)}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `bark ${response.status}: ${text.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: `bark error: ${String(error)}` };
  }
}

function availableChannels(config: UnifiedNotifyConfig): Array<Exclude<NotifyChannel, "all">> {
  const channels: Array<Exclude<NotifyChannel, "all">> = [];

  if (config.ntfy?.server && config.ntfy?.topic) {
    channels.push("ntfy");
  }

  if (config.telegram?.bot_token && config.telegram?.chat_id) {
    channels.push("telegram");
  }

  if (config.bark?.server && config.bark?.key) {
    channels.push("bark");
  }

  return channels;
}

export async function dispatchNotify(
  configRaw: UnifiedNotifyConfig,
  message: NotifyMessage,
  channel?: NotifyChannel,
): Promise<NotifyDispatchResult[]> {
  const config = overlayConfigByEnv(configRaw);
  const selected = channel || config.default;
  const channels = selected === "all" ? availableChannels(config) : [selected];
  const results: NotifyDispatchResult[] = [];

  for (const item of channels) {
    if (item === "ntfy") {
      if (!config.ntfy?.server || !config.ntfy?.topic) {
        results.push({ channel: item, ok: false, error: "ntfy 未配置" });
        continue;
      }

      const result = await sendViaNtfy(config.ntfy, message);
      results.push({ channel: item, ...result });
      continue;
    }

    if (item === "telegram") {
      if (!config.telegram?.bot_token || !config.telegram?.chat_id) {
        results.push({ channel: item, ok: false, error: "telegram 未配置" });
        continue;
      }

      const result = await sendViaTelegram(config.telegram, message);
      results.push({ channel: item, ...result });
      continue;
    }

    if (!config.bark?.server || !config.bark?.key) {
      results.push({ channel: item, ok: false, error: "bark 未配置" });
      continue;
    }

    const result = await sendViaBark(config.bark, message);
    results.push({ channel: item, ...result });
  }

  return results;
}
