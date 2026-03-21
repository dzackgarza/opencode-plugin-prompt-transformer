import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Server is started and torn down by `just test` — not by this file.
// Set OPENCODE_BASE_URL before running.
const BASE_URL = process.env.OPENCODE_BASE_URL;
if (!BASE_URL) throw new Error('OPENCODE_BASE_URL must be set (run via `just test`)');

const MANAGER_PACKAGE = 'git+https://github.com/dzackgarza/opencode-manager.git';
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = 'plugin-proof';

type Tier = 'model-self' | 'knowledge' | 'C' | 'B' | 'A' | 'S';

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

function extractRoutedTier(text: string): Tier | null {
  const match = text.match(/<!--\s*router:tier=([^\s>]+)\s*-->/);
  return match ? (match[1] as Tier) : null;
}

function runOcm(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(
    'uvx',
    ['--from', MANAGER_PACKAGE, 'ocm', ...args],
    {
      env: { ...process.env, OPENCODE_BASE_URL: BASE_URL },
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

// begin-session submits the prompt and returns immediately (session ID only).
// Use ocm wait to block until the full turn completes.
function beginSession(prompt: string): string {
  const { stdout } = runOcm(['begin-session', prompt, '--agent', AGENT_NAME, '--json']);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
}

function waitIdle(sessionID: string) {
  runOcm(['wait', sessionID, '--timeout-sec=180']);
}

// Return all assistant text content from the transcript, joined.
// The routing passcode is injected by the plugin into the model's context,
// and the model echoes it back in its text reply.
function readFinalAssistantText(sessionID: string): string {
  const { stdout } = runOcm(['transcript', sessionID, '--json']);
  const data = JSON.parse(stdout) as {
    turns: Array<{
      assistantMessages: Array<{
        steps: Array<{ type: string; contentText?: string } | null>;
      }>;
    }>;
  };
  const parts = data.turns.flatMap((turn) =>
    turn.assistantMessages.flatMap((msg) =>
      (msg.steps ?? [])
        .filter((s): s is { type: string; contentText: string } =>
          s !== null && s.type === 'text' && typeof s.contentText === 'string',
        )
        .map((s) => s.contentText),
    ),
  );
  if (parts.length === 0) throw new Error(`No assistant text in transcript:\n${stdout}`);
  return parts.join('\n');
}

describe('opencode-plugin-prompt-transformer live routing proof', () => {
  for (const { prompt, tier } of FAUX_RULES) {
    it(`routes ${tier} prompts through the injected template`, () => {
      const nonce = randomUUID();
      const promptWithNonce = `${prompt} After responding, also include this exact string: ${nonce}`;
      let sessionID: string | undefined;
      try {
        sessionID = beginSession(promptWithNonce);
        waitIdle(sessionID);
        const text = readFinalAssistantText(sessionID);
        expect(text).toContain(ROUTING_PASSCODES[tier]);
        expect(text).toContain(nonce);
        expect(extractRoutedTier(text)).toBe(tier);
      } finally {
        if (sessionID) {
          try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
        }
      }
    }, 200_000);
  }
});
