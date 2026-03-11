import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { FAUX_RULES, ROUTING_PASSCODES, type Tier } from "../../src/routing";

const OPENCODE =
  process.env.OPENCODE_BIN || "/home/dzack/.opencode/bin/opencode";
const TOOL_DIR = process.cwd();
const HOST = "127.0.0.1";
const MODEL = "github-copilot/gpt-4.1";
const MANAGER_PACKAGE =
  "git+ssh://git@github.com/dzackgarza/opencode-manager.git";
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

type RouterLogEntry = {
  session_id: string;
  prompt: string;
  tier: Tier;
  reasoning: string;
  injected: boolean;
};

type ServerHandle = {
  baseUrl: string;
  logPath: string;
  process: ChildProcess;
  logs: string;
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

function buildConfigContent(includePlugin: boolean): string {
  const config: Record<string, unknown> = {
    model: MODEL,
  };
  if (includePlugin) {
    config.plugin = [pathToFileURL(join(TOOL_DIR, "src/index.ts")).toString()];
  }
  return JSON.stringify(config);
}

async function startServer(options: {
  includePlugin: boolean;
  logPath: string;
}): Promise<ServerHandle> {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

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
        OPENCODE_CONFIG_CONTENT: buildConfigContent(options.includePlugin),
        PROMPT_TRANSFORMER_LOG_PATH: options.logPath,
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
        logPath: options.logPath,
        process: childProcess,
        logs,
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
  if (!server || server.process.exitCode !== null) return;

  server.process.kill("SIGINT");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.process.exitCode !== null) return;
    await wait(100);
  }

  server.process.kill("SIGKILL");
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

function readLogEntries(logPath: string): RouterLogEntry[] {
  try {
    const raw = readFileSync(logPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RouterLogEntry);
  } catch {
    return [];
  }
}

async function waitForLogEntry(
  logPath: string,
  sessionID: string,
  tier: Tier,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = readLogEntries(logPath).find(
      (row) => row.session_id === sessionID && row.tier === tier,
    );
    if (entry) return entry;
    await wait(500);
  }

  throw new Error(
    `Timed out waiting for routing log entry for ${sessionID} (${tier}).`,
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
    includePlugin: true,
    logPath: join(tempRoot, "plugin.log"),
  });
  controlServer = await startServer({
    includePlugin: false,
    logPath: join(tempRoot, "control.log"),
  });
}, 120_000);

afterAll(async () => {
  await stopServer(pluginServer);
  await stopServer(controlServer);
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}, 30_000);

describe("opencode-plugin-prompt-transformer live routing proof", () => {
  it("control: without the plugin, the manager-driven session does not emit the model-self routing passcode", async () => {
    const modelSelfPrompt = FAUX_RULES.find(
      ({ tier }) => tier === "model-self",
    )!.prompt;
    const baseUrl = controlServer!.baseUrl;
    const sessionID = await runPrompt(baseUrl, modelSelfPrompt);
    try {
      const text = await waitForAssistantReply(baseUrl, sessionID);
      expect(text).not.toContain(ROUTING_PASSCODES["model-self"]);
      expect(readLogEntries(controlServer!.logPath)).toHaveLength(0);
    } finally {
      deleteSession(baseUrl, sessionID);
    }
  }, 200_000);

  for (const { prompt, tier } of FAUX_RULES) {
    it(`routes ${tier} prompts through the injected template on a custom-port manager session`, async () => {
      const baseUrl = pluginServer!.baseUrl;
      const sessionID = await runPrompt(baseUrl, prompt);
      try {
        const text = await waitForAssistantContains(
          baseUrl,
          sessionID,
          ROUTING_PASSCODES[tier],
        );
        const logEntry = await waitForLogEntry(
          pluginServer!.logPath,
          sessionID,
          tier,
        );

        expect(text).toContain(ROUTING_PASSCODES[tier]);
        expect(logEntry.prompt).toBe(prompt);
        expect(logEntry.injected).toBe(true);
      } finally {
        deleteSession(baseUrl, sessionID);
      }
    }, 200_000);
  }
});
