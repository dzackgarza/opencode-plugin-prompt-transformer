import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const _dir = dirname(fileURLToPath(import.meta.url));
const AI_ROOT = resolve(_dir, "../../../ai");
const OPENCODE_ROOT = resolve(AI_ROOT, "opencode");
const PYTHON = resolve(OPENCODE_ROOT, ".venv/bin/python");
const RUN_MICRO_AGENT = resolve(AI_ROOT, "scripts/run_micro_agent.py");
const UV = "uv";

export type LLMResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string };

export interface MicroAgent {
  system: string | null;
  body: string;
  frontmatter: Record<string, unknown>;
  path: string;
}

export async function loadMicroAgent(path: string): Promise<MicroAgent> {
  const res = runBridge<MicroAgent>({ action: "load_micro_agent", path });
  if (!res.ok) throw new Error(`scripts.llm micro-agent error: ${res.error}`);
  return res.result;
}

export async function renderTemplate(
  body: string,
  variables: Record<string, string>,
  path?: string,
): Promise<string> {
  const res = runBridge<string>({
    action: "render_template",
    body,
    path,
    variables,
  });
  if (!res.ok) throw new Error(`scripts.llm render error: ${res.error}`);
  return res.result;
}

export async function runMicroAgent<T = string>(
  path: string,
  variables: Record<string, string>,
  options?: { model?: string; temperature?: number },
): Promise<T> {
  const args = ["run", "--active", "--python", PYTHON, RUN_MICRO_AGENT, path];
  for (const [key, value] of Object.entries(variables)) {
    args.push("--var", `${key}=${value}`);
  }
  if (options?.model) {
    args.push("--model", options.model);
  }
  if (options?.temperature !== undefined) {
    args.push("--temperature", String(options.temperature));
  }

  const proc = spawnSync(UV, args, {
    cwd: OPENCODE_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });

  if (proc.error) {
    throw new Error(`scripts.llm runner spawn error: ${proc.error.message}`);
  }

  let payload: LLMResponse<T>;
  try {
    payload = JSON.parse(proc.stdout) as LLMResponse<T>;
  } catch {
    throw new Error(`run_micro_agent returned non-JSON: ${proc.stdout?.slice(0, 200)}`);
  }

  if (!payload.ok) {
    throw new Error(`scripts.run_micro_agent error: ${payload.error}`);
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr?.trim() ?? "";
    throw new Error(
      `scripts.run_micro_agent exited ${proc.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return payload.result;
}

function runBridge<T>(req: object): LLMResponse<T> {
  const proc = spawnSync(
    UV,
    ["run", "--active", "--python", PYTHON, "-m", "scripts.llm.bridge"],
    {
      cwd: OPENCODE_ROOT,
      input: JSON.stringify(req),
      encoding: "utf8",
      timeout: 60_000,
    },
  );

  if (proc.error) {
    return { ok: false, error: `spawn error: ${proc.error.message}` };
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr?.trim() ?? "";
    return {
      ok: false,
      error: `scripts.llm.bridge exited ${proc.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }

  try {
    return JSON.parse(proc.stdout) as LLMResponse<T>;
  } catch {
    return {
      ok: false,
      error: `llm.py returned non-JSON: ${proc.stdout?.slice(0, 200)}`,
    };
  }
}
