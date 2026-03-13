import { spawnSync } from "child_process";

const UVX = "uvx";

const TEMPLATE_INSPECT = "llm-template-inspect";
const TEMPLATE_RENDER = "llm-template-render";
const RUNNER_RUN = "llm-run";
const AI_PROMPTS_CLI = "ai-prompts";

const COMMAND_PACKAGES: Record<string, string> = {
  [TEMPLATE_INSPECT]: "git+https://github.com/dzackgarza/llm-templating-engine.git",
  [TEMPLATE_RENDER]: "git+https://github.com/dzackgarza/llm-templating-engine.git",
  [RUNNER_RUN]: "git+https://github.com/dzackgarza/llm-runner.git",
  [AI_PROMPTS_CLI]: "git+https://github.com/dzackgarza/ai-prompts.git",
};

export interface ErrorResponse {
  error: {
    type: string;
    message: string;
  };
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
  const pkg = COMMAND_PACKAGES[command];
  if (!pkg) {
    throw new Error(`Unknown command: ${command}`);
  }
  const proc = spawnSync(UVX, ["--from", pkg, command], {
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

export function fetchPromptText(slug: string): string {
  const pkg = COMMAND_PACKAGES[AI_PROMPTS_CLI];
  const proc = spawnSync(UVX, ["--from", pkg, AI_PROMPTS_CLI, "get", slug], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (proc.error) {
    throw new Error(`ai-prompts spawn error: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(`ai-prompts get ${slug} failed: ${proc.stderr?.trim()}`);
  }
  return proc.stdout?.trim() ?? "";
}

export async function inspectTemplate(text: string): Promise<TemplateDocument> {
  const response = runJsonCommand<InspectTemplateResponse>(TEMPLATE_INSPECT, {
    template: { text },
  });
  return response.template;
}

export async function renderTemplateText(
  text: string,
  bindings: Record<string, unknown>,
): Promise<string> {
  const response = runJsonCommand<RenderTemplateResponse>(TEMPLATE_RENDER, {
    template: { text },
    bindings: { data: bindings },
  });
  return response.rendered.body;
}

export async function runMicroAgent<T = unknown, TFinal = unknown>(
  text: string,
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
    template: { text },
    bindings: { data: bindings },
    overrides,
  });
}
