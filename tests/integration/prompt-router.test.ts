import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

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
    prompt:
      'Create a file named router-poc-c.txt containing exactly: poc-baseline-c, then delete it.',
    tier: 'C',
  },
  {
    prompt:
      'For each .ts file in this directory, open it and print the name of every exported symbol.',
    tier: 'B',
  },
  { prompt: 'Audit command-interceptor.ts for security vulnerabilities.', tier: 'A' },
  { prompt: 'Design a plugin for tracking token usage per session.', tier: 'S' },
];

const TOOL_DIR = process.cwd();
const HOST = '127.0.0.1';
const MANAGER_PACKAGE = 'git+https://github.com/dzackgarza/opencode-manager.git';
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;

function extractRoutedTier(text: string): Tier | null {
  const match = text.match(/<!--\s*router:tier=([^\s>]+)\s*-->/);
  return match ? (match[1] as Tier) : null;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a TCP port.'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) { reject(error); return; }
        resolve(port);
      });
    });
  });
}

type ServerHandle = {
  baseUrl: string;
  process: ChildProcess;
  xdgRoot: string;
};

function resolveDirenvEnv(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = spawnSync('direnv', ['exec', cwd, 'env', '-0'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Failed to resolve direnv environment.\nSTDOUT:\n${result.stdout ?? ''}\nSTDERR:\n${result.stderr ?? ''}`,
    );
  }
  const resolved: NodeJS.ProcessEnv = {};
  for (const entry of (result.stdout ?? '').split('\0')) {
    if (!entry) continue;
    const sep = entry.indexOf('=');
    if (sep < 0) continue;
    resolved[entry.slice(0, sep)] = entry.slice(sep + 1);
  }
  return resolved;
}

async function startPluginServer(): Promise<ServerHandle> {
  spawnSync('direnv', ['allow', TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

  const xdgRoot = mkdtempSync(join(tmpdir(), 'opencode-prompt-transformer-xdg-'));
  const configHome = join(xdgRoot, 'config');
  const cacheHome = join(xdgRoot, 'cache');
  const stateHome = join(xdgRoot, 'state');
  const testHome = join(xdgRoot, 'home');
  mkdirSync(configHome, { recursive: true });
  mkdirSync(cacheHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(testHome, { recursive: true });

  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;

  // Resolve the full direnv env for this plugin dir with isolated XDG dirs.
  // This picks up the plugin registration and any plugin-specific env vars.
  const isolatedBase: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    OPENCODE_TEST_HOME: testHome,
  };
  const resolvedEnv = resolveDirenvEnv(TOOL_DIR, isolatedBase);

  const childProcess = spawn(
    'opencode',
    ['serve', '--hostname', HOST, '--port', String(port), '--print-logs', '--log-level', 'INFO'],
    { cwd: TOOL_DIR, env: resolvedEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let logs = '';
  const capture = (chunk: Buffer | string) => { logs += chunk.toString(); };
  childProcess.stdout.on('data', capture);
  childProcess.stderr.on('data', capture);

  const ready = `opencode server listening on ${baseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (logs.includes(ready)) return { baseUrl, process: childProcess, xdgRoot };
    if (childProcess.exitCode !== null) {
      throw new Error(`OpenCode server exited early (${childProcess.exitCode}).\n${logs}`);
    }
    await wait(200);
  }
  throw new Error(`Timed out waiting for OpenCode server at ${baseUrl}.\n${logs}`);
}

async function stopServer(server: ServerHandle | undefined) {
  if (!server) return;
  if (server.process.exitCode === null) {
    server.process.kill('SIGINT');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.process.exitCode !== null) break;
      await wait(100);
    }
    if (server.process.exitCode === null) server.process.kill('SIGKILL');
  }
  rmSync(server.xdgRoot, { recursive: true, force: true });
}

function runOneShot(baseUrl: string, prompt: string): string {
  const result = spawnSync(
    'uvx',
    ['--from', MANAGER_PACKAGE, 'ocm', 'one-shot', prompt, '--agent', 'Minimal', '--transcript'],
    {
      env: { ...process.env, OPENCODE_BASE_URL: baseUrl },
      encoding: 'utf8',
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `ocm one-shot failed\nSTDOUT:\n${result.stdout ?? ''}\nSTDERR:\n${result.stderr ?? ''}`,
    );
  }
  return (result.stdout ?? '').trim();
}

let pluginServer: ServerHandle | undefined;

beforeAll(async () => {
  pluginServer = await startPluginServer();
}, 120_000);

afterAll(async () => {
  await stopServer(pluginServer);
}, 30_000);

describe('opencode-plugin-prompt-transformer live routing proof', () => {
  for (const { prompt, tier } of FAUX_RULES) {
    it(`routes ${tier} prompts through the injected template`, async () => {
      const nonce = randomUUID();
      const promptWithNonce = `${prompt} After responding, also include this exact string: ${nonce}`;
      const text = runOneShot(pluginServer!.baseUrl, promptWithNonce);
      expect(text).toContain(ROUTING_PASSCODES[tier]);
      expect(text).toContain(nonce);
      expect(extractRoutedTier(text)).toBe(tier);
    }, 200_000);
  }
});
