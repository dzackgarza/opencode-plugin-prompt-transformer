import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const _dir = dirname(fileURLToPath(import.meta.url));
const AI_ROOT = resolve(_dir, "../../../ai");
const OPENCODE_ROOT = resolve(AI_ROOT, "opencode");
const PYTHON = resolve(OPENCODE_ROOT, ".venv/bin/python");
const UV = "uv";
const TEMPLATE_INSPECT = "llm-template-inspect";
const TEMPLATE_RENDER = "llm-template-render";
const RUNNER_RUN = "llm-run";

export interface ErrorResponse {
  error: {
    type: string;
    message: string;
  };
}

export interface TemplateReference {
  path?: string;
  text?: string;
  name?: string;
}

export interface TemplateDocument {
  path?: string | null;
  name?: string | null;
  frontmatter: Record<string, unknown>;
  body_template: string;
}

export interface InspectTemplateResponse {
  template: TemplateDocument;
}

export interface RenderTemplateResponse {
  template: TemplateDocument;
  rendered: {
    body: string;
    document: string;
  };
}

export interface RunOverrides {
  models?: string[];
  temperature?: number;
  max_tokens?: number;
  retries?: number;
}

export interface RunResponse<T = unknown, TFinal = unknown> {
  run: {
    template_path: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  response: {
    model: string;
    raw_text: string;
    structured: T | null;
  };
  final_output: {
    text?: string | null;
    data?: TFinal | null;
  };
}

function parseError(stdout: string): string | null {
  try {
    const payload = JSON.parse(stdout) as ErrorResponse;
    if (typeof payload.error?.message === "string") {
      return payload.error.message;
    }
  } catch {
    return null;
  }
  return null;
}

function runJsonCommand<T>(command: string, request: object): T {
  const proc = spawnSync(UV, ["run", "--active", "--python", PYTHON, command], {
    cwd: OPENCODE_ROOT,
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: 60_000,
  });

  if (proc.error) {
    throw new Error(`${command} spawn error: ${proc.error.message}`);
  }

  const stdout = proc.stdout?.trim() ?? "";
  const stderr = proc.stderr?.trim() ?? "";
  if (proc.status !== 0) {
    const message =
      parseError(stdout) ?? (stderr || `${command} exited ${proc.status}`);
    throw new Error(`${command} error: ${message}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${command} returned non-JSON: ${stdout.slice(0, 200)}`);
  }
}

export async function inspectTemplate(path: string): Promise<TemplateDocument> {
  const response = runJsonCommand<InspectTemplateResponse>(TEMPLATE_INSPECT, {
    template: { path },
  });
  return response.template;
}

export async function renderTemplatePath(
  path: string,
  bindings: Record<string, unknown>,
): Promise<string> {
  const response = runJsonCommand<RenderTemplateResponse>(TEMPLATE_RENDER, {
    template: { path },
    bindings: { data: bindings },
  });
  return response.rendered.body;
}

export async function runMicroAgent<T = unknown, TFinal = unknown>(
  path: string,
  bindings: Record<string, unknown>,
  options?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    retries?: number;
  },
): Promise<RunResponse<T, TFinal>> {
  const overrides: RunOverrides = {};
  if (options?.model) {
    overrides.models = [options.model];
  }
  if (options?.temperature !== undefined) {
    overrides.temperature = options.temperature;
  }
  if (options?.max_tokens !== undefined) {
    overrides.max_tokens = options.max_tokens;
  }
  if (options?.retries !== undefined) {
    overrides.retries = options.retries;
  }

  return runJsonCommand<RunResponse<T, TFinal>>(RUNNER_RUN, {
    template: { path },
    bindings: { data: bindings },
    overrides,
  });
}
