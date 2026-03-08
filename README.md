# Prompt Router

Standalone OpenCode plugin package for routing incoming user prompts into
cognitive tiers before the main agent responds.

Registration path:

```json
"file:///home/dzack/opencode-plugins/prompt-router/src/index.ts"
```

The plugin uses the canonical prompt assets in `~/ai/prompts/micro_agents/prompt_difficulty_classifier/`
and the canonical Python interfaces in `~/ai/scripts/llm` via:

- `scripts/run_micro_agent.py` for classifier execution
- `scripts.llm.bridge` for render-only Jinja templating

Local checks:

```bash
cd /home/dzack/opencode-plugins/prompt-router
bunx tsc --noEmit
bun test
```
