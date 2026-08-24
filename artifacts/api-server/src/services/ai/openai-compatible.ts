/**
 * openai-compatible.ts — LLMProvider over the OpenAI chat-completions API
 * ---------------------------------------------------------------------------
 * Covers DeepSeek and Qwen (DashScope compatible mode), and any other service
 * exposing `POST {baseUrl}/chat/completions`. One adapter rather than three
 * near-identical ones, because that is genuinely all that differs between
 * them: the base URL and the model name.
 *
 * NO NEW DEPENDENCY. Node 18+ has global fetch, and the request is a single
 * JSON POST. Adding the `openai` SDK to send one POST would pull a large
 * dependency into a server that already bundles with esbuild, for no
 * capability this file lacks.
 *
 * The API key is read from configuration by the caller, never logged, and
 * never included in an error message — errors quote status codes and provider
 * text only.
 */

import type { LLMProvider, LLMProviderConfig } from "./provider.js";
import { logger } from "../../lib/logger.js";

/** Statuses worth another attempt. 4xx other than 429 will not improve. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown for a non-2xx response, carrying the status so retries can be judged. */
class HttpProviderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpProviderError";
  }
}

export interface OpenAICompatibleConfig extends LLMProviderConfig {
  /** e.g. https://api.deepseek.com/v1 or https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl: string;
  /** Shown in logs and stored as extraction provenance, e.g. "deepseek". */
  vendor: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxOutputTokens: number;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.apiKey) {
      throw new Error(`${config.vendor} provider requires an API key (LLM_API_KEY).`);
    }
    if (!config.model) {
      throw new Error(`${config.vendor} provider requires a model name (LLM_MODEL).`);
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.modelName = config.model;
    this.timeoutMs = config.timeoutMs ?? 45_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.maxOutputTokens = config.maxOutputTokens ?? 8192;
    this.name = `${config.vendor}/${this.modelName}`;
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const text = await this.callOnce(prompt, systemPrompt);
        if (attempt > 1) {
          logger.info({ attempt, provider: this.name }, "LLM request succeeded after retry");
        }
        return text;
      } catch (err) {
        lastError = err;

        const retryable =
          err instanceof HttpProviderError
            ? RETRYABLE_STATUS.has(err.status)
            : // A timeout or a socket error is transient by nature.
              err instanceof Error && /timed out|fetch failed|ECONN|network/i.test(err.message);

        if (!retryable || attempt === this.maxRetries) break;

        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn({ attempt, backoffMs, provider: this.name }, "LLM transient error — retrying");
        await sleep(backoffMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`${this.name} failed after ${this.maxRetries} attempts`);
  }

  private async callOnce(prompt: string, systemPrompt?: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages,
          // Low temperature: this is extraction, not composition.
          temperature: 0.1,
          max_tokens: this.maxOutputTokens,
          // Honoured by DeepSeek and Qwen compatible mode; harmlessly ignored
          // elsewhere. The agent strips fences anyway, so this is belt and
          // braces rather than a dependency.
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Provider error text is included for diagnosis. It cannot contain the
        // key: the key travels in a header, never in the body.
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new HttpProviderError(res.status, `${this.name} returned HTTP ${res.status}: ${detail}`);
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content;
      if (!text || !text.trim()) {
        throw new Error(`${this.name} returned an empty response`);
      }
      return text.trim();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`${this.name} request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
