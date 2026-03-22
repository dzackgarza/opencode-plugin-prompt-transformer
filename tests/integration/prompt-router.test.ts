import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

// OpenCode must already be running before this file executes.
// `just test` runs the suite, but it does not start or stop the server.
const MANAGER_PACKAGE = 'git+https://github.com/dzackgarza/opencode-manager.git';
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = 'plugin-proof';
const PROJECT_DIR = process.cwd();

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

function runOcm(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(
    'uvx',
    ['--from', MANAGER_PACKAGE, 'ocm', ...args],
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

function runOneShot(prompt: string): string {
  const { stdout } = runOcm(['one-shot', prompt, '--agent', AGENT_NAME]);
  const text = stdout.trim();
  if (!text) throw new Error(`No assistant text for prompt: ${prompt}`);
  return text;
}

describe('opencode-plugin-prompt-transformer live routing proof', () => {
  for (const { prompt, tier } of FAUX_RULES) {
    it(`routes ${tier} prompts through the injected template`, () => {
      const text = runOneShot(prompt);
      expect(text).toContain(ROUTING_PASSCODES[tier]);
    }, 200_000);
  }

  it('routes quoted canonical prompts through the injected template', () => {
    const prompt = '"Describe every tool you have access to."';
    const text = runOneShot(prompt);
    expect(text).toContain(ROUTING_PASSCODES['model-self']);
  }, 200_000);
});
