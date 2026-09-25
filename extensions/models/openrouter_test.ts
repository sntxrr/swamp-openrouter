// extensions/models/openrouter_test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing";
import { model } from "./openrouter.ts";

type ChatContext = Parameters<typeof model.methods.chat.execute>[1];
type ListModelsContext = Parameters<typeof model.methods.listModels.execute>[1];

const GLOBAL_ARGS = {
  apiKey: "sk-or-test",
  baseUrl: "https://openrouter.ai/api/v1",
};

function chatContext(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const ctx = createModelTestContext({ globalArgs, methodName: "chat" });
  return { ...ctx, context: ctx.context as unknown as ChatContext };
}

function listModelsContext(
  globalArgs: Record<string, unknown> = GLOBAL_ARGS,
) {
  const ctx = createModelTestContext({ globalArgs, methodName: "listModels" });
  return { ...ctx, context: ctx.context as unknown as ListModelsContext };
}

Deno.test("chat stores a completion on success", async () => {
  const { context, getWrittenResources } = chatContext();

  await withMockedFetch(
    (req) => {
      assertEquals(req.url, "https://openrouter.ai/api/v1/chat/completions");
      assertEquals(req.headers.get("Authorization"), "Bearer sk-or-test");
      return Promise.resolve(
        Response.json({
          id: "gen-123",
          model: "openai/gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi there" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 3,
            total_tokens: 8,
          },
        }),
      );
    },
    async () => {
      await model.methods.chat.execute(
        {
          messages: [{ role: "user", content: "hi" }],
          model: "openai/gpt-4o-mini",
          requestId: "chat",
        },
        context,
      );
    },
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "completion");
  assertEquals(written[0].name, "chat");
  assertEquals(written[0].data.id, "gen-123");
  assertEquals(written[0].data.usage, {
    promptTokens: 5,
    completionTokens: 3,
    totalTokens: 8,
  });
});

Deno.test("chat throws on API error and writes nothing", async () => {
  const { context, getWrittenResources } = chatContext();

  await withMockedFetch(
    () =>
      Promise.resolve(
        Response.json(
          { error: { message: "invalid api key", code: 401 } },
          { status: 401 },
        ),
      ),
    async () => {
      await assertRejects(
        () =>
          model.methods.chat.execute(
            {
              messages: [{ role: "user", content: "hi" }],
              model: "openai/gpt-4o-mini",
              requestId: "chat",
            },
            context,
          ),
        Error,
        "OpenRouter API error 401",
      );
    },
  );

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("chat requires a model when no defaultModel is set", async () => {
  const { context, getWrittenResources } = chatContext();

  await assertRejects(
    () =>
      model.methods.chat.execute(
        { messages: [{ role: "user", content: "hi" }], requestId: "chat" },
        context,
      ),
    Error,
    "No model specified",
  );

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("chat retries once on 429 then succeeds", async () => {
  const { context, getWrittenResources, getLogsByLevel } = chatContext();

  let calls = 0;
  await withMockedFetch(
    () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          Response.json({ error: "rate limited" }, {
            status: 429,
            headers: { "Retry-After": "0" },
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          id: "gen-456",
          model: "openai/gpt-4o-mini",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" } },
          ],
        }),
      );
    },
    async () => {
      await model.methods.chat.execute(
        {
          messages: [{ role: "user", content: "hi" }],
          model: "openai/gpt-4o-mini",
          requestId: "chat",
        },
        context,
      );
    },
  );

  assertEquals(calls, 2);
  assertEquals(getWrittenResources()[0].data.id, "gen-456");
  assertEquals(getLogsByLevel("warning").length, 1);
});

Deno.test("listModels stores the catalog on success", async () => {
  const { context, getWrittenResources } = listModelsContext();

  await withMockedFetch(
    (req) => {
      assertEquals(req.url, "https://openrouter.ai/api/v1/models");
      return Promise.resolve(
        Response.json({
          data: [
            { id: "openai/gpt-4o-mini", name: "GPT-4o mini", context_length: 128000 },
            { id: "anthropic/claude-fable-5", name: "Claude Fable 5" },
          ],
        }),
      );
    },
    async () => {
      await model.methods.listModels.execute({}, context);
    },
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "modelCatalog");
  assertEquals(written[0].data.models, [
    { id: "openai/gpt-4o-mini", name: "GPT-4o mini", contextLength: 128000 },
    {
      id: "anthropic/claude-fable-5",
      name: "Claude Fable 5",
      contextLength: undefined,
    },
  ]);
});

Deno.test("listModels throws when response shape is unexpected", async () => {
  const { context, getWrittenResources } = listModelsContext();

  await withMockedFetch(
    () => Promise.resolve(Response.json({ unexpected: true })),
    async () => {
      await assertRejects(
        () => model.methods.listModels.execute({}, context),
        Error,
        'missing "data" array',
      );
    },
  );

  assertEquals(getWrittenResources().length, 0);
});

Deno.test("chat requestId defaults to a non-reserved name", () => {
  const args = model.methods.chat.arguments.parse({
    messages: [{ role: "user", content: "hi" }],
  });
  assertEquals(args.requestId, "chat");
});

Deno.test("chat rejects the swamp-reserved requestId \"latest\"", () => {
  const result = model.methods.chat.arguments.safeParse({
    messages: [{ role: "user", content: "hi" }],
    requestId: "latest",
  });
  assertEquals(result.success, false);
});

Deno.test("apiKey is marked sensitive so swamp redacts it", () => {
  const meta = model.globalArguments.shape.apiKey.meta();
  assertEquals(meta?.sensitive, true);
});

Deno.test("chat aborts a request that never answers after timeoutMs", async () => {
  // A real tarpit: accepts the connection, never writes a byte.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const held: Deno.Conn[] = [];
  (async () => {
    for await (const conn of listener) held.push(conn);
  })();
  const { port } = listener.addr as Deno.NetAddr;
  const { context } = chatContext({
    ...GLOBAL_ARGS,
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 200,
  });
  try {
    await assertRejects(() =>
      model.methods.chat.execute(
        {
          messages: [{ role: "user", content: "hi" }],
          model: "openai/gpt-4o-mini",
          requestId: "chat",
        },
        context,
      )
    );
  } finally {
    listener.close();
    held.forEach((c) => c.close());
  }
});

Deno.test("upgrade to 2026.09.25.2 keeps existing arguments intact", () => {
  const upgrade = model.upgrades.at(-1)!;
  assertEquals(upgrade.toVersion, model.version);
  const old = { apiKey: "sk-or-test", defaultModel: "openai/gpt-4o-mini" };
  assertEquals(upgrade.upgradeAttributes(old), old);
});
