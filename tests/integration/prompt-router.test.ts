import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { FAUX_RULES, ROUTING_PASSCODES } from "../../src/routing";

const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const MODEL = "github-copilot/gpt-4.1";
const TOOL_DIR = process.cwd();
const CONFIG_PATH = "./opencode-plugin-prompt-transformer/.config/opencode.json";
const MAX_BUFFER = 8 * 1024 * 1024;

function run(
  prompt: string,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
) {
  const result = spawnSync(OPENCODE, ["run", "--agent", "Minimal", prompt], {
    cwd: options?.cwd ?? process.env.HOME,
    encoding: "utf8",
    timeout: options?.timeout ?? 180_000,
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      ...options?.env,
    },
  });
  if (result.error) throw result.error;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

describe("opencode-plugin-prompt-transformer live routing proof", () => {
  it("control: without the plugin, the model does not emit the model-self routing passcode", () => {
    const modelSelfPrompt = FAUX_RULES.find(({ tier }) => tier === "model-self")!.prompt;
    const output = run(modelSelfPrompt, {
      cwd: process.env.HOME,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: MODEL }),
      },
    });
    expect(output).not.toContain(ROUTING_PASSCODES["model-self"]);
  }, 200_000);

  for (const { prompt, tier } of FAUX_RULES) {
    it(`relays the ${tier} routing passcode from the injected template`, () => {
      const output = run(prompt, {
        cwd: TOOL_DIR,
        env: {
          OPENCODE_CONFIG: CONFIG_PATH,
        },
      });
      expect(output).toContain(ROUTING_PASSCODES[tier]);
    }, 200_000);
  }
});
