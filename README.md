[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)


# opencode-plugin-prompt-transformer

Classify user prompts into routing tiers and rewrite messages with this OpenCode plugin. It uses `chat.message` to transform user text.

## Install

Run these commands to install:

```bash
cd ./opencode-plugin-prompt-transformer
just install
```

Repo-local verification uses [`.envrc`](./.envrc), [`.config/opencode.json`](./.config/opencode.json), and a checked-in symlink under [`.config/plugins`](./.config/plugins) so OpenCode loads the real exporter without a machine-specific `file://` path.

**MCP**: None. This package provides a chat-transform hook rather than a tool server.

## Agent Surface

This plugin intercepts chat messages without exposing tool names. It performs these actions:

- **Reads** the latest user text.
- **Classifies** input into tiers: `model-self`, `knowledge`, `C`, `B`, `A`, or `S`.
- **Injects** instructions from the canonical response template.

Dependencies:

- **Runtime**: Bun, `@opencode-ai/plugin`, `yaml`
- **External local assets**: prompts resolved from [`ai-prompts`](https://github.com/dzackgarza/ai-prompts) via `$PROMPTS_DIR`
- **External local runtime**: `llm-run` and `llm-template-render` from [`llm-runner`](https://github.com/dzackgarza/llm-runner) and [`llm-templating-engine`](https://github.com/dzackgarza/llm-templating-engine) — must be available on `$PATH` or in the active `uv` environment

## LLM Integration

`opencode-plugin-prompt-transformer` does not call the legacy `./ai/scripts/llm` bridge. It shells into the standalone JSON CLIs instead:

- `llm-run` for prompt execution and structured classifier output
- `llm-template-render` for response-template rendering

Install the CLIs via `uvx` directly from GitHub:

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
