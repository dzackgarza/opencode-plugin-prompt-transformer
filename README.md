# prompt-router

OpenCode plugin that classifies the latest user prompt into a routing tier and rewrites the user message through `chat.message`.

## Install

```bash
cd /home/dzack/opencode-plugins/prompt-router
just install
```

OpenCode plugin registration via `file:`:

```json
{
  "plugin": [
    "file:///home/dzack/opencode-plugins/prompt-router/src/index.ts"
  ]
}
```

Sample local config: [`prompt-router/.config/opencode.json`](/home/dzack/opencode-plugins/prompt-router/.config/opencode.json)

MCP: not provided. This package is a chat-transform hook, not a tool server.

## Agent Surface

This plugin exposes no tool names. It intercepts chat messages and:

- reads the latest user text
- classifies it into one of `model-self`, `knowledge`, `C`, `B`, `A`, `S`
- injects rendered instructions from the canonical response template

Dependencies:

- Runtime: Bun, `@opencode-ai/plugin`, `yaml`
- External local assets: `~/ai/prompts/...`, `~/ai/scripts/llm`

## Checks

```bash
just typecheck
just test
```
