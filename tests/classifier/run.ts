#!/usr/bin/env bun
// Classifier evaluation runner.
//
// Usage:
//   bun run run.ts [model-slug]
//
// Model slug prefixes:
//   (none)    → OpenRouter  (e.g. arcee-ai/trinity-large-preview:free)
//   groq/     → Groq        (e.g. groq/llama-3.3-70b-versatile)
//   nvidia/   → NVIDIA NIM  (e.g. nvidia/meta/llama-3.3-70b-instruct)
//   ollama/   → Ollama      (e.g. ollama/qwen3:4b)
//
// Defaults to groq/llama-3.3-70b-versatile.
// Reads classifier prompt from prompts/micro_agents/prompt_difficulty_classifier/prompt.md.
// Reads cases from prompts/micro_agents/prompt_difficulty_classifier/expected_classifications.yaml.
// Writes per-run log to runs/{slug-safe}/{timestamp}.yaml.
// Updates cumulative scores in scores.yaml.
//
// Structured output and retries handled by llm-runner.

import { parse, stringify } from "yaml";
import { join, dirname, resolve } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { inspectTemplate, runMicroAgent } from "../../src/llm";

const DIR = dirname(import.meta.path);
const RUNS_DIR = join(DIR, "runs");
const DELAY_MS = 10000;
const AI_ROOT = resolve(DIR, "../../../../ai");

const CLASSIFIER_PROMPT_PATH = resolve(
  AI_ROOT,
  "prompts/micro_agents/prompt_difficulty_classifier/prompt.md",
);
const EXPECTED_CLASSIFICATIONS_PATH = resolve(
  AI_ROOT,
  "prompts/micro_agents/prompt_difficulty_classifier/expected_classifications.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Case {
  prompt: string;
  tier: string;
  label: string;
}

interface CaseResult {
  prompt: string;
  label: string;
  expected: string;
  got: string;
  pass: boolean;
  reasoning: string;
  latency_ms: number;
}

interface RunLog {
  model: string;
  timestamp: string;
  playbook_file: string;
  passed: number;
  total: number;
  score: number;
  results: CaseResult[];
}

interface ModelScore {
  total_runs: number;
  total_cases: number;
  total_passed: number;
  cumulative_score: number;
  last_run: string;
}

interface ScoresFile {
  models: Record<string, ModelScore>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugToDir(slug: string): string {
  return slug.replace(/\//g, "--").replace(/:/g, "-");
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Classify — delegates to the canonical runner for prompt loading and schema
// ---------------------------------------------------------------------------

async function classify(
  model: string,
  prompt: string,
): Promise<{ tier: string; reasoning: string; latency_ms: number }> {
  const t0 = Date.now();
  try {
    const result = await runMicroAgent<{ tier: string; reasoning: string }>(
      CLASSIFIER_PROMPT_PATH,
      { prompt },
      { model, temperature: 0 },
    );
    const classification = result.response.structured;
    if (!classification) {
      throw new Error("llm-run returned no structured classifier payload");
    }
    return {
      tier: classification.tier,
      reasoning: classification.reasoning,
      latency_ms: Date.now() - t0,
    };
  } catch (e: any) {
    return {
      tier: `ERROR: ${String(e?.message ?? e).slice(0, 80)}`,
      reasoning: "",
      latency_ms: Date.now() - t0,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const model =
  process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ??
  "groq/llama-3.3-70b-versatile";

// Load classifier prompt metadata and test cases from canonical locations.
await inspectTemplate(CLASSIFIER_PROMPT_PATH);
const { cases } = parse(
  await Bun.file(EXPECTED_CLASSIFICATIONS_PATH).text(),
) as { cases: Case[] };

console.log(`Model:      ${model}`);
console.log(`Cases:      ${cases.length}`);
console.log(`Delay:      ${DELAY_MS}ms between requests\n`);

const results: CaseResult[] = [];
let passed = 0;

for (let i = 0; i < cases.length; i++) {
  const { prompt, tier: expected, label } = cases[i];
  if (i > 0) await delay(DELAY_MS);

  const {
    tier: got,
    reasoning,
    latency_ms,
  } = await classify(model, prompt);
  const pass = got === expected;
  if (pass) passed++;

  results.push({ prompt, label, expected, got, pass, reasoning, latency_ms });
  console.log(
    `${pass ? "PASS" : "FAIL"} [${label}] expected=${expected} got=${got} (${latency_ms}ms)`,
  );
  console.log(`     "${prompt}"`);
  if (!pass && reasoning) console.log(`     reason: ${reasoning}`);
}

const score = passed / cases.length;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

console.log(
  `\n${passed}/${cases.length} passed (${(score * 100).toFixed(0)}%)`,
);

// ---------------------------------------------------------------------------
// Write run log
// ---------------------------------------------------------------------------

const runLog: RunLog = {
  model,
  timestamp: new Date().toISOString(),
  playbook_file: "prompts/micro_agents/prompt_difficulty_classifier/prompt.md",
  passed,
  total: cases.length,
  score,
  results,
};

const runDir = join(RUNS_DIR, slugToDir(model));
mkdirSync(runDir, { recursive: true });
const runFile = join(runDir, `${timestamp}.yaml`);
writeFileSync(runFile, stringify(runLog));
console.log(`\nRun log: ${runFile}`);

// ---------------------------------------------------------------------------
// Update cumulative scores
// ---------------------------------------------------------------------------

const scoresPath = join(DIR, "scores.yaml");
let scoresRaw: string;
try {
  scoresRaw = await Bun.file(scoresPath).text();
} catch {
  scoresRaw = "models: {}";
}
const scores = parse(scoresRaw) as ScoresFile;
if (!scores.models) scores.models = {};

const prev = scores.models[model] ?? {
  total_runs: 0,
  total_cases: 0,
  total_passed: 0,
  cumulative_score: 0,
  last_run: "",
};
scores.models[model] = {
  total_runs: prev.total_runs + 1,
  total_cases: prev.total_cases + cases.length,
  total_passed: prev.total_passed + passed,
  cumulative_score:
    (prev.total_passed + passed) / (prev.total_cases + cases.length),
  last_run: new Date().toISOString(),
};

writeFileSync(scoresPath, stringify(scores));
console.log(
  `Scores updated: ${(scores.models[model].cumulative_score * 100).toFixed(0)}% cumulative`,
);
