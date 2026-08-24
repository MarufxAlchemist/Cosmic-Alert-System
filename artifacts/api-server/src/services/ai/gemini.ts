import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import type { LLMProvider, LLMProviderConfig } from "./provider.js";
import { logger } from "../../lib/logger.js";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Google SDK surfaces HTTP status in the error message
    if (msg.includes("429") || msg.includes("rate limit")) return true;
    if (msg.includes("503") || msg.includes("overloaded")) return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("504")) return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GeminiProvider implements LLMProvider {
  readonly name: string;
  private genAI: GoogleGenerativeAI;
  private modelName: string;
  private timeoutMs: number;
  private maxRetries: number;
  private maxOutputTokens: number;

  constructor(config: LLMProviderConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.modelName = config.model ?? "gemini-2.5-flash";
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.maxOutputTokens = config.maxOutputTokens ?? 8192;
    this.name = `gemini/${this.modelName}`;
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      generationConfig: {
        // Force JSON-only output — eliminates markdown fences and prose wrapping
        responseMimeType: "application/json",
        temperature: 0.2,   // Low temperature for factual, consistent output
        // Not hardcoded: a truncated response is indistinguishable from a
        // malformed one, and 2048 silently cut the circular-extraction schema
        // off mid-JSON. See LLMProviderConfig.maxOutputTokens.
        maxOutputTokens: this.maxOutputTokens,
      },
      safetySettings: [
        // Astronomy content should never trigger these; setting to BLOCK_NONE
        // prevents the model from refusing a legitimate scientific prompt
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
    });

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const text = await this.callWithTimeout(model, prompt);
        if (attempt > 1) {
          logger.info({ attempt, provider: this.name }, "Gemini request succeeded after retry");
        }
        return text;
      } catch (err) {
        lastError = err;

        if (!isRetryableError(err) || attempt === this.maxRetries) {
          break;
        }

        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        logger.warn(
          { attempt, backoffMs, provider: this.name, err },
          "Gemini transient error — retrying"
        );
        await sleep(backoffMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Gemini provider failed after ${this.maxRetries} attempts`);
  }

  private async callWithTimeout(
    model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
    prompt: string
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });

      const text = result.response.text();
      if (!text || text.trim() === "") {
        throw new Error("Gemini returned an empty response");
      }
      return text.trim();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Gemini request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
