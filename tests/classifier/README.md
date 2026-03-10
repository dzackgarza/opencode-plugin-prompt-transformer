
# Classifier Test Harness

Evaluates models in `CLASSIFIER_MODELS` against a labeled 12-case suite. It records per-run YAML logs and cumulative accuracy in `scores.yaml`.

## Usage

Navigate to the test directory and run the evaluation:

```bash
cd ./opencode-plugin-prompt-transformer/tests/classifier

# Run with the default model (groq/llama-3.3-70b-versatile)
bun run run.ts

# Run with a specific model
bun run run.ts groq/moonshotai/kimi-k2-instruct

# Use MD_JSON mode for models that do not support the response_format header
bun run run.ts nvidia/mistralai/mistral-large-3-675b-instruct-2512 --mode MD_JSON
```

Output logs are saved to `runs/<model-slug>/<timestamp>.yaml`. Cumulative scores are updated in `scores.yaml`.

## Execution Process

1. **Prompt Retrieval**: Reads the canonical classifier prompt from `./ai/prompts/micro_agents/prompt_difficulty_classifier/prompt.md`.
2. **Evaluation**: Calls the runner for each case and compares the returned tier to the expected tier.
3. **Score Update**: Updates `scores.yaml` with cumulative accuracy.
4. **Runner**: Uses `scripts/run_micro_agent.py` to enforce the declared schema and return JSON.
5. **Rate Limiting**: Implements a 10s delay between calls to respect Groq's free-tier limits.

## Model Compatibility

### Highly Accurate (12/12)

| Model | Mode | Latency | Notes |
|-------|------|---------|-------|
| `groq/llama-3.3-70b-versatile` | JSON | 138–400ms | Primary; fast LPU with a generous free tier. |
| `groq/moonshotai/kimi-k2-instruct` | JSON | 151–1165ms | Reliable fallback. |
| `nvidia/mistralai/mistral-large-3-675b-instruct-2512` | MD_JSON | 890–1688ms | Requires MD_JSON mode. |
| `nvidia/mistralai/mistral-small-3.1-24b-instruct-2503` | JSON | 995–1630ms | Accurate but slower. |

### Accurate (11/12)

- `nvidia/meta/llama-3.3-70b-instruct` (NVIDIA NIM)
- `groq/meta-llama/llama-4-maverick-17b-128e-instruct` (Superseded by kimi-k2)

### Last Resort

- `arcee-ai/trinity-large-preview:free` (OpenRouter): Limited by a 50 req/day cap.

### Unsupported

- **Thinking Models**: `stepfun/step-3.5-flash:free`, `z-ai/glm-4.5-air:free`, `nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1`, `groq/qwen/qwen3-32b`. These models either truncate JSON or output `<think>` blocks.
- **Incompatible Instructors**: `nvidia/google/gemma-3-27b-it` (Strict role alternation).

## Rate Limiting

- **Groq Free Tier**: Limited to ~100k tokens/day (~43 runs). Switch to NVIDIA NIM if exhausted.
- **OpenRouter Free Tier**: 50 requests/day account-wide. Use only for spot-checks.
- **NVIDIA NIM**: No daily cap; preferred for batch runs.

## MD_JSON Mode

Use `--mode MD_JSON` for models that return HTTP 400/404 on `response_format: json_object` (e.g., Mistral Large on NVIDIA NIM). Prompt-based JSON works reliably for these models.
