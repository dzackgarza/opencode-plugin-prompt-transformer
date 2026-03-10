[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)


# opencode-plugin-prompt-transformer

Classify user prompts into routing tiers and rewrite messages with this OpenCode plugin. It uses `chat.message` to transform user text.

## Install

Run these commands to install:

```bash
cd ./opencode-plugin-prompt-transformer
just install
```

Register the plugin via `file:` in your OpenCode config:

```json
{
  "plugin": [
    "file:///path/to/opencode-plugin-prompt-transformer/src/index.ts"
  ]
}
```

View a sample configuration here: [`opencode-plugin-prompt-transformer/.config/opencode.json`](./opencode-plugin-prompt-transformer/.config/opencode.json)

**MCP**: None. This package provides a chat-transform hook rather than a tool server.

## Agent Surface

This plugin intercepts chat messages without exposing tool names. It performs these actions:

- **Reads** the latest user text.
- **Classifies** input into tiers: `model-self`, `knowledge`, `C`, `B`, `A`, or `S`.
- **Injects** instructions from the canonical response template.

Dependencies:

- **Runtime**: Bun, `@opencode-ai/plugin`, `yaml`
- **External local assets**: `./ai/prompts/...`
- **External local runtime**: `./ai/opencode/.venv`, which provides `llm-run` and `llm-template-render` from the GitHub-backed `llm-runner` and `llm-templating-engine` dependencies declared in `./ai/opencode/pyproject.toml`

## LLM Integration

`opencode-plugin-prompt-transformer` does not call the legacy `./ai/scripts/llm` bridge. It shells into the standalone JSON CLIs instead:

- `llm-run` for prompt execution and structured classifier output
- `llm-template-render` for response-template rendering

That means the local OpenCode environment must be synced first:

```bash
cd ./ai/opencode
uv sync --dev
```

For ad hoc smoke tests outside the project environment, the canonical upstream CLIs are also available directly from GitHub via `uvx --from`:

```bash
uvx --from git+https://github.com/dzackgarza/llm-runner.git llm-run --help
uvx --from git+https://github.com/dzackgarza/llm-templating-engine.git llm-template-render --help
```

## Checks

Run checks with just:

```bash
just typecheck
just test
```
