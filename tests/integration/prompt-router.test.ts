import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { FAUX_RULES, ROUTING_PASSCODES, type Tier } from "../../src/routing";

const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const TOOL_DIR = process.cwd();
const HOST = "127.0.0.1";
const MODEL = "github-copilot/gpt-4.1";
const MANAGER_PACKAGE = join(TOOL_DIR, "..", "opencode-manager");
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;

type SessionMessage = {
  info?: {
    role?: string;
  };
  parts?: Array<{
    type?: string;
    text?: string;
  }>;
};

type ServerHandle = {
  baseUrl: string;
  process: ChildProcess;
  logs: string;
  xdgRoot: string;
};

let pluginServer: ServerHandle | undefined;
let controlServer: ServerHandle | undefined;
let tempRoot = "";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function buildControlConfigContent(): string {
  const config: Record<string, unknown> = {
    model: MODEL,
  };
  return JSON.stringify(config);
}

async function startServer(options: {
  configPath?: string;
  configContent?: string;
}): Promise<ServerHandle> {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

  const xdgRoot = mkdtempSync(join(tmpdir(), "opencode-prompt-transformer-xdg-"));
  const configHome = join(xdgRoot, "config");
  const cacheHome = join(xdgRoot, "cache");
  const stateHome = join(xdgRoot, "state");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(cacheHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });

  const port = await findFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  const childProcess = spawn(
    "direnv",
    [
      "exec",
      TOOL_DIR,
      OPENCODE,
      "serve",
      "--hostname",
      HOST,
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        ...(options.configPath
          ? {
              OPENCODE_CONFIG: options.configPath,
              OPENCODE_CONFIG_DIR: join(TOOL_DIR, ".config"),
            }
          : {}),
        ...(options.configContent
          ? {
              OPENCODE_CONFIG_CONTENT: options.configContent,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  const capture = (chunk: Buffer | string) => {
    logs += chunk.toString();
  };
  childProcess.stdout.on("data", capture);
  childProcess.stderr.on("data", capture);

  const ready = `opencode server listening on ${baseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (logs.includes(ready)) {
      return {
        baseUrl,
        process: childProcess,
        logs,
        xdgRoot,
      };
    }
    if (childProcess.exitCode !== null) {
      throw new Error(
        `Custom OpenCode server exited early (${childProcess.exitCode}).\n${logs}`,
      );
    }
    await wait(200);
  }

  throw new Error(
    `Timed out waiting for custom OpenCode server at ${baseUrl}.\n${logs}`,
  );
}

async function stopServer(server: ServerHandle | undefined) {
  if (!server) return;

  if (server.process.exitCode === null) {
    server.process.kill("SIGINT");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.process.exitCode !== null) break;
      await wait(100);
    }
    if (server.process.exitCode === null) server.process.kill("SIGKILL");
  }

  rmSync(server.xdgRoot, { recursive: true, force: true });
}

function runSessionCommand(baseUrl: string, args: string[]) {
  const result = spawnSync(
    "npx",
    ["--yes", `--package=${MANAGER_PACKAGE}`, "opx-session", ...args],
    {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        OPENCODE_BASE_URL: baseUrl,
      },
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(
      `Manager command failed: ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return stdout;
}

function createSession(baseUrl: string, title: string) {
  return JSON.parse(runSessionCommand(baseUrl, ["create", "--title", title, "--json"])) as {
    id: string;
  };
}

function deleteSession(baseUrl: string, sessionID: string) {
  try {
    runSessionCommand(baseUrl, ["delete", sessionID, "--json"]);
  } catch {
    // best-effort cleanup in a noisy shared environment
  }
}

function readMessages(baseUrl: string, sessionID: string): SessionMessage[] {
  return JSON.parse(
    runSessionCommand(baseUrl, ["messages", sessionID, "--json"]),
  ) as SessionMessage[];
}

function assistantText(messages: SessionMessage[]) {
  return messages
    .filter((message) => message.info?.role === "assistant")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function extractRoutedTier(text: string): Tier | null {
  const match = text.match(/<!--\s*router:tier=([^\s>]+)\s*-->/);
  return match ? (match[1] as Tier) : null;
}

async function waitForAssistantContains(
  baseUrl: string,
  sessionID: string,
  expected: string,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = assistantText(readMessages(baseUrl, sessionID));
    if (text.includes(expected)) return text;
    await wait(1_000);
  }

  throw new Error(
    `Timed out waiting for assistant text to include ${expected}.\n${JSON.stringify(readMessages(baseUrl, sessionID), null, 2)}`,
  );
}

async function waitForAssistantReply(
  baseUrl: string,
  sessionID: string,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = assistantText(readMessages(baseUrl, sessionID)).trim();
    if (text.length > 0) return text;
    await wait(1_000);
  }

  throw new Error(
    `Timed out waiting for assistant reply.\n${JSON.stringify(readMessages(baseUrl, sessionID), null, 2)}`,
  );
}

async function runPrompt(baseUrl: string, prompt: string) {
  const sessionID = createSession(baseUrl, `prompt-router:${Date.now()}`).id;
  runSessionCommand(baseUrl, ["prompt", sessionID, prompt, "--no-reply"]);
  return sessionID;
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "prompt-router-test-"));
  pluginServer = await startServer({
    configPath: join(TOOL_DIR, ".config/opencode.json"),
  });
  controlServer = await startServer({
    configContent: buildControlConfigContent(),
  });
}, 120_000);

afterAll(async () => {
  await stopServer(pluginServer);
  await stopServer(controlServer);
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}, 30_000);

describe("opencode-plugin-prompt-transformer live routing proof", () => {
  it("control: without the plugin, the manager-driven session does not emit the model-self routing passcode", async () => {
    const nonce = randomUUID();
    const modelSelfPrompt = FAUX_RULES.find(
      ({ tier }) => tier === "model-self",
    )!.prompt;
    const promptWithNonce = `${modelSelfPrompt} After responding, also include this exact string: ${nonce}`;
    const baseUrl = controlServer!.baseUrl;
    const sessionID = await runPrompt(baseUrl, promptWithNonce);
    try {
      const text = await waitForAssistantReply(baseUrl, sessionID);
      expect(text).not.toContain(ROUTING_PASSCODES["model-self"]);
      expect(text).toContain(nonce);
    } finally {
      deleteSession(baseUrl, sessionID);
    }
  }, 200_000);

  for (const { prompt, tier } of FAUX_RULES) {
    it(`routes ${tier} prompts through the injected template on a custom-port manager session`, async () => {
      const nonce = randomUUID();
      const promptWithNonce = `${prompt} After responding, also include this exact string: ${nonce}`;
      const baseUrl = pluginServer!.baseUrl;
      const sessionID = await runPrompt(baseUrl, promptWithNonce);
      try {
        const text = await waitForAssistantContains(
          baseUrl,
          sessionID,
          ROUTING_PASSCODES[tier],
        );

        expect(text).toContain(ROUTING_PASSCODES[tier]);
        expect(text).toContain(nonce);
        expect(extractRoutedTier(text)).toBe(tier);
      } finally {
        deleteSession(baseUrl, sessionID);
      }
    }, 200_000);
  }
});
