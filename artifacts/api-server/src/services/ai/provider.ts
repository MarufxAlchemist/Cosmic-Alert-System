/**
 * LLM provider abstraction for Transient Event Detection's AI service layer.
 *
 * Design: depend on LLMProvider, not on a concrete class. Swap implementations
 * by injecting a different provider — no call-site changes required. No file
 * outside this directory may import a vendor SDK.
 *
 * Implementations:
 *   GeminiProvider           — gemini.ts, via @google/generative-ai
 *   OpenAICompatibleProvider — openai-compatible.ts, covers DeepSeek and Qwen
 *
 * CONFIGURATION
 * -------------
 * Preferred, vendor-neutral:
 *
 *   LLM_PROVIDER = gemini | deepseek | qwen | openai-compatible
 *   LLM_API_KEY  = ...
 *   LLM_MODEL    = ...                (optional; each provider has a default)
 *   LLM_BASE_URL = ...                (required only for openai-compatible)
 *   LLM_TIMEOUT_MS = 45000            (optional)
 *
 * Changing provider or model is exactly those variables. No business-logic
 * file mentions a vendor.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * When LLM_PROVIDER is unset the existing GEMINI_API_KEY / GEMINI_MODEL /
 * GEMINI_TIMEOUT_MS variables are used unchanged, so deployments that predate
 * this indirection keep working with no edit. The missing-key error still
 * names GEMINI_API_KEY in that case, because routes/events.ts matches on that
 * string to return 503 rather than 502.
 */

// Statically imported, not require()'d.
//
// This used to be `require("./gemini.js")`, deferred "so the SDK is not loaded
// at startup". esbuild resolves that at bundle time so the server worked, but
// `require` does not exist in ESM — so every unbundled runtime (tsx scripts,
// vitest) threw "require is not defined" the moment a provider was
// constructed, and the extraction worker mis-classified that as a transient
// error and retried it. The deferral also saved nothing: the SDK is bundled
// either way because it is a static dependency of gemini.ts.
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export interface LLMProvider {
  /** Human-readable name used in logs and cache metadata. */
  readonly name: string;

  /**
   * Send a prompt to the model and return the raw text response.
   * Implementations are responsible for retry logic and timeouts.
   * The caller is responsible for JSON parsing and validation.
   */
  generate(prompt: string, systemPrompt?: string): Promise<string>;
}

export interface LLMProviderConfig {
  apiKey: string;
  /** Override the default model for this provider. */
  model?: string;
  /** Hard deadline per request in milliseconds. Default: 30_000. */
  timeoutMs?: number;
  /** Maximum retry attempts on transient errors. Default: 3. */
  maxRetries?: number;
}

// ─── Provider selection ──────────────────────────────────────────────────────

/**
 * Base URLs for the vendors that speak the OpenAI chat-completions protocol.
 *
 * Both are the vendors' documented compatible-mode endpoints. LLM_BASE_URL
 * overrides either one (self-hosted gateways, regional endpoints).
 */
const OPENAI_COMPATIBLE_DEFAULTS: Readonly<Record<string, { baseUrl: string; model: string }>> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  qwen: {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
};

function timeoutMs(fallback: number): number {
  const raw = Number(process.env["LLM_TIMEOUT_MS"] ?? process.env["GEMINI_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function createGemini(): LLMProvider {
  const apiKey = process.env["LLM_API_KEY"] ?? process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    // The GEMINI_API_KEY spelling is load-bearing: routes/events.ts matches on
    // it to distinguish "not configured" (503) from "provider broke" (502).
    throw new Error(
      "GEMINI_API_KEY is not set. Add it (or LLM_API_KEY with LLM_PROVIDER=gemini) " +
        "to your .env file to enable AI analysis."
    );
  }

  return new GeminiProvider({
    apiKey,
    model: process.env["LLM_MODEL"] ?? process.env["GEMINI_MODEL"] ?? "gemini-2.5-flash",
    timeoutMs: timeoutMs(45_000),
    maxRetries: 3,
  });
}

function createOpenAICompatible(vendor: string): LLMProvider {
  const defaults = OPENAI_COMPATIBLE_DEFAULTS[vendor];
  const baseUrl = process.env["LLM_BASE_URL"] ?? defaults?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `LLM_PROVIDER="${vendor}" requires LLM_BASE_URL (no built-in endpoint is known for it).`
    );
  }

  const apiKey = process.env["LLM_API_KEY"];
  if (!apiKey) {
    throw new Error(`LLM_API_KEY is not set. It is required for LLM_PROVIDER="${vendor}".`);
  }

  const model = process.env["LLM_MODEL"] ?? defaults?.model;
  if (!model) {
    throw new Error(`LLM_MODEL is not set and no default is known for LLM_PROVIDER="${vendor}".`);
  }

  return new OpenAICompatibleProvider({
    vendor,
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutMs(45_000),
    maxRetries: 3,
  });
}

/**
 * The provider named by LLM_PROVIDER, defaulting to Gemini for compatibility.
 *
 * Adding a vendor means adding a branch here and nothing else: every caller
 * holds an LLMProvider.
 */
export function createDefaultProvider(): LLMProvider {
  const requested = (process.env["LLM_PROVIDER"] ?? "gemini").trim().toLowerCase();

  switch (requested) {
    case "":
    case "gemini":
    case "google":
      return createGemini();

    case "deepseek":
    case "qwen":
      return createOpenAICompatible(requested);

    case "openai-compatible":
      return createOpenAICompatible("openai-compatible");

    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${requested}". Supported: gemini, deepseek, qwen, openai-compatible.`
      );
  }
}

/**
 * Kept for the Phase 2 call sites that named it explicitly. Equivalent to
 * setting LLM_PROVIDER=deepseek.
 */
export function createDeepSeekProvider(config?: LLMProviderConfig): LLMProvider {
  const defaults = OPENAI_COMPATIBLE_DEFAULTS["deepseek"]!;
  const apiKey = config?.apiKey ?? process.env["LLM_API_KEY"];
  if (!apiKey) {
    throw new Error("LLM_API_KEY is not set. It is required for the DeepSeek provider.");
  }
  return new OpenAICompatibleProvider({
    vendor: "deepseek",
    baseUrl: process.env["LLM_BASE_URL"] ?? defaults.baseUrl,
    apiKey,
    model: config?.model ?? process.env["LLM_MODEL"] ?? defaults.model,
    timeoutMs: config?.timeoutMs ?? timeoutMs(45_000),
    maxRetries: config?.maxRetries ?? 3,
  });
}
