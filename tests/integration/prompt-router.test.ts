import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// OpenCode must already be running before this file executes.
// `just test` runs the suite, but it does not start or stop the server.
const MANAGER_PACKAGE = 'git+https://github.com/dzackgarza/opencode-manager.git';
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = 'plugin-proof';
const PROJECT_DIR = process.cwd();
const OCM_TOOL_DIR = mkdtempSync(join(tmpdir(), 'ocm-tool-'));
let ocmBinaryPath: string | undefined;

type Tier = 'model-self' | 'knowledge' | 'C' | 'B' | 'A' | 'S';

function requireEnv(name: string, message: string): string {
  const value = process.env[name];
  if (!value) throw new Error(message);
  return value;
}

const BASE_URL = requireEnv(
  'OPENCODE_BASE_URL',
  'OPENCODE_BASE_URL must be set (run against a repo-local or CI OpenCode server)',
);

const ROUTING_PASSCODES: Record<Tier, string> = {
  'model-self': 'ROUTER_PASS_MODEL_SELF_20260309_71F4',
  knowledge: 'ROUTER_PASS_KNOWLEDGE_20260309_5B2C',
  C: 'ROUTER_PASS_C_20260309_8D11',
  B: 'ROUTER_PASS_B_20260309_4E6A',
  A: 'ROUTER_PASS_A_20260309_9C03',
  S: 'ROUTER_PASS_S_20260309_2F88',
};

const FAUX_RULES: Array<{ prompt: string; tier: Tier }> = [
  { prompt: 'Describe every tool you have access to.', tier: 'model-self' },
  { prompt: 'What is the latest stable release of TypeScript?', tier: 'knowledge' },
  {
    prompt: 'Create a file named router-poc-c.txt containing exactly: poc-baseline-c, then delete it.',
    tier: 'C',
  },
  {
    prompt: 'For each .ts file in this directory, open it and print the name of every exported symbol.',
    tier: 'B',
  },
  { prompt: 'Audit command-interceptor.ts for security vulnerabilities.', tier: 'A' },
  { prompt: 'Design a plugin for tracking token usage per session.', tier: 'S' },
];

type RawSessionMessage = {
  info?: {
    role?: string;
  };
  parts?: Array<{
    type?: string;
    text?: string;
  } | null>;
};

afterAll(() => {
  rmSync(OCM_TOOL_DIR, { recursive: true, force: true });
});

function getOcmBinaryPath(): string {
  if (ocmBinaryPath) return ocmBinaryPath;
  const binDir = process.platform === 'win32' ? join(OCM_TOOL_DIR, 'Scripts') : join(OCM_TOOL_DIR, 'bin');
  const candidate = join(binDir, process.platform === 'win32' ? 'ocm.exe' : 'ocm');
  if (!existsSync(candidate)) {
    const install = spawnSync(
      'uv',
      ['tool', 'install', '--tool-dir', OCM_TOOL_DIR, '--from', MANAGER_PACKAGE, 'ocm'],
      {
        env: process.env,
        cwd: PROJECT_DIR,
        encoding: 'utf8',
        timeout: SESSION_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0 || !existsSync(candidate)) {
      throw new Error(
        `Failed to install ocm\nSTDOUT:\n${install.stdout ?? ''}\nSTDERR:\n${install.stderr ?? ''}`,
      );
    }
  }
  ocmBinaryPath = candidate;
  return candidate;
}

function runOcm(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(
    getOcmBinaryPath(),
    args,
    {
      env: { ...process.env, OPENCODE_BASE_URL: BASE_URL },
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    throw new Error(`ocm ${args.join(' ')} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return { stdout, stderr };
}

function beginSession(prompt: string): string {
  const { stdout } = runOcm(['begin-session', prompt, '--agent', AGENT_NAME, '--json']);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
}

function flattenMessageText(message: RawSessionMessage): string {
  return (message.parts ?? [])
    .filter(
      (part): part is { type?: string; text?: string } =>
        part !== null && typeof part === 'object',
    )
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

async function waitForAssistantText(sessionID: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}/session/${sessionID}/message`);
    if (response.ok) {
      const data = (await response.json()) as unknown;
      if (Array.isArray(data)) {
        const match = data
          .filter((message): message is RawSessionMessage =>
            typeof message === 'object' && message !== null,
          )
          .filter((message) => message.info?.role === 'assistant')
          .map(flattenMessageText)
          .find((text) => text.length > 0);
        if (match) return match;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for assistant text in session ${sessionID}.`);
}

async function runSession(prompt: string): Promise<string> {
  const sessionID = beginSession(prompt);
  try {
    return await waitForAssistantText(sessionID, SESSION_TIMEOUT_MS);
  } finally {
    try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
  }
}

describe('opencode-plugin-prompt-transformer live routing proof', () => {
  for (const { prompt, tier } of FAUX_RULES) {
    it(`routes ${tier} prompts through the injected template`, async () => {
      const text = await runSession(prompt);
      expect(text).toContain(ROUTING_PASSCODES[tier]);
    }, 200_000);
  }

  it('routes quoted canonical prompts through the injected template', async () => {
    const prompt = '"Describe every tool you have access to."';
    const text = await runSession(prompt);
    expect(text).toContain(ROUTING_PASSCODES['model-self']);
  }, 200_000);
});
