/**
 * OpenRouter LLM gateway integration — chat completions and model catalog
 * listing against the OpenRouter API (https://openrouter.ai/api/v1).
 *
 * @module
 */
// extensions/models/openrouter.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiKey: z.string().describe("OpenRouter API key (sk-or-...)"),
  baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
  defaultModel: z.string().optional().describe(
    "Model slug used when a chat call doesn't override it, e.g. openai/gpt-4o-mini",
  ),
  siteUrl: z.string().url().optional().describe(
    "Sent as HTTP-Referer for OpenRouter's app rankings",
  ),
  siteName: z.string().optional().describe("Sent as X-Title"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
});

const ChatArgsSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  requestId: z.string().default("latest").describe(
    "Instance name for the stored completion — use distinct values to keep separate conversation histories",
  ),
});

const CompletionSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: z.object({
        role: z.string(),
        content: z.string().nullable(),
      }),
      finishReason: z.string().nullable().optional(),
    }),
  ),
  usage: z.object({
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).optional(),
  requestedAt: z.string(),
});

const ModelCatalogSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      contextLength: z.number().optional(),
    }),
  ),
  fetchedAt: z.string(),
});

/** Build the shared headers OpenRouter expects on every request. */
function buildHeaders(globalArgs: GlobalArgs): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${globalArgs.apiKey}`,
    "Content-Type": "application/json",
  };
  if (globalArgs.siteUrl) headers["HTTP-Referer"] = globalArgs.siteUrl;
  if (globalArgs.siteName) headers["X-Title"] = globalArgs.siteName;
  return headers;
}

type RetryLogger = {
  warn: (message: string, props?: Record<string, unknown>) => void;
};

/** Parse a `Retry-After` header value (seconds or HTTP date) into milliseconds. */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Retry transient (429/5xx) failures with exponential backoff, honoring Retry-After. */
async function withRetry<T>(
  operation: () => Promise<Response>,
  parse: (res: Response) => Promise<T>,
  logger: RetryLogger,
  maxAttempts = 5,
): Promise<T> {
  const baseDelay = 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await operation();
    if (res.ok) return await parse(res);

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts - 1) {
      const body = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${body}`);
    }
    const delay = retryAfterMs(res) ??
      (baseDelay * 2 ** attempt + Math.random() * 500);
    logger.warn(
      "OpenRouter request throttled ({status}), retrying in {delayMs}ms",
      { status: res.status, delayMs: Math.round(delay) },
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("unreachable");
}

/**
 * OpenRouter model definition — exposes `chat` (chat completions) and
 * `listModels` (model catalog) methods backed by the OpenRouter API.
 */
export const model = {
  type: "@sntxrr/openrouter",
  version: "2026.06.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "completion": {
      description: "Chat completion response from OpenRouter",
      schema: CompletionSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "modelCatalog": {
      description: "Snapshot of models available through OpenRouter",
      schema: ModelCatalogSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    chat: {
      description: "Send a chat completion request to OpenRouter",
      arguments: ChatArgsSchema,
      execute: async (
        args: z.infer<typeof ChatArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (message: string, props?: Record<string, unknown>) => void;
            warn: (
              message: string,
              props?: Record<string, unknown>,
            ) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { globalArgs, logger } = context;
        const model = args.model ?? globalArgs.defaultModel;
        if (!model) {
          throw new Error(
            "No model specified — pass `model` or set `defaultModel` on the openrouter model definition",
          );
        }

        logger.info("Requesting chat completion from {model}", { model });

        const body = {
          model,
          messages: args.messages,
          ...(args.temperature !== undefined
            ? { temperature: args.temperature }
            : {}),
          ...(args.maxTokens !== undefined
            ? { max_tokens: args.maxTokens }
            : {}),
        };

        const completion = await withRetry(
          () =>
            fetch(`${globalArgs.baseUrl}/chat/completions`, {
              method: "POST",
              headers: buildHeaders(globalArgs),
              body: JSON.stringify(body),
            }),
          (res) => res.json(),
          logger,
        ) as Record<string, unknown>;

        if (!Array.isArray(completion.choices)) {
          throw new Error(
            `OpenRouter response missing "choices" array: ${
              JSON.stringify(completion)
            }`,
          );
        }

        const usage = completion.usage as Record<string, number> | undefined;

        const handle = await context.writeResource(
          "completion",
          args.requestId,
          {
            id: completion.id,
            model: completion.model ?? model,
            choices: completion.choices,
            usage: usage
              ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              }
              : undefined,
            requestedAt: new Date().toISOString(),
          },
        );

        logger.info("Chat completion {id} stored as {requestId}", {
          id: completion.id,
          requestId: args.requestId,
        });
        return { dataHandles: [handle] };
      },
    },
    listModels: {
      description:
        "Fetch the current catalog of models available on OpenRouter",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (message: string, props?: Record<string, unknown>) => void;
            warn: (
              message: string,
              props?: Record<string, unknown>,
            ) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { globalArgs, logger } = context;

        logger.info("Fetching OpenRouter model catalog");

        const data = await withRetry(
          () =>
            fetch(`${globalArgs.baseUrl}/models`, {
              method: "GET",
              headers: buildHeaders(globalArgs),
            }),
          (res) => res.json(),
          logger,
        ) as { data: Array<Record<string, unknown>> };

        if (!Array.isArray(data.data)) {
          throw new Error(
            `OpenRouter response missing "data" array: ${JSON.stringify(data)}`,
          );
        }

        const handle = await context.writeResource("modelCatalog", "catalog", {
          models: data.data.map((m) => ({
            id: m.id,
            name: m.name,
            contextLength: m.context_length,
          })),
          fetchedAt: new Date().toISOString(),
        });

        logger.info("Stored catalog of {count} models", {
          count: data.data.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
