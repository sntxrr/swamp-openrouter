# @sntxrr/openrouter

Swamp model for the [OpenRouter](https://openrouter.ai) LLM gateway API —
send chat completions and list the current model catalog.

## Setup

Store your OpenRouter API key in a vault rather than passing it inline:

```bash
swamp vault create local_encryption llm-secrets --json
echo "$OPENROUTER_API_KEY" | swamp vault put llm-secrets OPENROUTER_API_KEY --json
```

Create a model instance, wiring the key from the vault so it resolves fresh on
every call:

```bash
swamp model create @sntxrr/openrouter my-router \
  --global-arg 'apiKey=${{ vault.get(llm-secrets, OPENROUTER_API_KEY) }}' \
  --global-arg defaultModel=openai/gpt-4o-mini
```

## Methods

### `chat`

Send a chat completion request.

```bash
swamp model method run my-router chat \
  --input 'messages=[{"role":"user","content":"hi"}]'
```

Optional inputs: `model` (overrides `defaultModel`), `temperature`,
`maxTokens`, and `requestId` (the stored instance name — use distinct values to
keep separate conversation histories; defaults to `"latest"`).

The result is written to the `completion` resource, readable via:

```bash
swamp data get my-router --name latest --json
```

### `listModels`

Fetch the current OpenRouter model catalog (no API key required by
OpenRouter's `/models` endpoint, but the model schema still requires one to be
configured):

```bash
swamp model method run my-router listModels
```

The result is written to the `modelCatalog` resource as `catalog`.

## Global Arguments

| Field          | Required | Description                                              |
| -------------- | -------- | ---------------------------------------------------------- |
| `apiKey`       | Yes      | OpenRouter API key (`sk-or-...`)                          |
| `baseUrl`      | No       | Defaults to `https://openrouter.ai/api/v1`                |
| `defaultModel` | No       | Model slug used when `chat` doesn't override it           |
| `siteUrl`      | No       | Sent as `HTTP-Referer` for OpenRouter's app rankings       |
| `siteName`     | No       | Sent as `X-Title`                                          |
