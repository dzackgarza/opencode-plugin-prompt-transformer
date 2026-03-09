[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# prompt-router

Classify user prompts into routing tiers and rewrite messages with this OpenCode plugin. It uses `chat.message` to transform user text.

## Install

Run these commands to install:

```bash
cd /home/dzack/opencode-plugins/prompt-router
just install
```

Register the plugin via `file:` in your OpenCode config:

```json
{
  "plugin": [
    "file:///home/dzack/opencode-plugins/prompt-router/src/index.ts"
  ]
}
```

View a sample configuration here: [`prompt-router/.config/opencode.json`](/home/dzack/opencode-plugins/prompt-router/.config/opencode.json)

**MCP**: None. This package provides a chat-transform hook rather than a tool server.

## Agent Surface

This plugin intercepts chat messages without exposing tool names. It performs these actions:

- **Reads** the latest user text.
- **Classifies** input into tiers: `model-self`, `knowledge`, `C`, `B`, `A`, or `S`.
- **Injects** instructions from the canonical response template.

Dependencies:

- **Runtime**: Bun, `@opencode-ai/plugin`, `yaml`
- **External local assets**: `~/ai/prompts/...`, `~/ai/scripts/llm`

## Checks

Run checks with just:

```bash
just typecheck
just test
```
