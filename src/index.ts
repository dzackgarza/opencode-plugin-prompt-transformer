import { appendFileSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import type { Plugin } from "@opencode-ai/plugin";
import type { TextPart, UserMessage } from "@opencode-ai/sdk";
import { renderTemplate, runMicroAgent } from "./llm";

const _dir = dirname(fileURLToPath(import.meta.url));
const AI_ROOT = resolve(_dir, "../../../ai");

const CLASSIFIER_PROMPT_PATH = resolve(
  AI_ROOT,
  "prompts/micro_agents/prompt_difficulty_classifier/prompt.md",
);
const RESPONSE_TEMPLATE_PATH = resolve(
  AI_ROOT,
  "prompts/micro_agents/prompt_difficulty_classifier/response_template.md",
);

type Tier = "model-self" | "knowledge" | "C" | "B" | "A" | "S";

const SESSION_ID = process.env.OPENCODE_SESSION_ID ?? randomUUID();
const LOG_PATH = "/var/sandbox/.prompt-router.log";

function appendLog(entry: {
  ts: string;
  session_id: string;
  prompt: string;
  tier: string;
  reasoning: string;
  injected: boolean;
}): void {
  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Log directory may not exist in dev.
  }
}

export const FAUX_RULES: Array<{ prompt: string; tier: Tier }> = [
  { prompt: "Describe every tool you have access to.", tier: "model-self" },
  { prompt: "What is the latest stable release of TypeScript?", tier: "knowledge" },
  {
    prompt:
      "Create a file named router-poc-c.txt containing exactly: poc-baseline-c, then delete it.",
    tier: "C",
  },
  {
    prompt:
      "For each .ts file in this directory, open it and print the name of every exported symbol.",
    tier: "B",
  },
  { prompt: "Audit command-interceptor.ts for security vulnerabilities.", tier: "A" },
  { prompt: "Design a plugin for tracking token usage per session.", tier: "S" },
];

const RESPONSE_TEMPLATE_BODY = await Bun.file(RESPONSE_TEMPLATE_PATH).text();

export function fauxMatch(text: string): Tier | null {
  const trimmed = text.trim();
  for (const { prompt, tier } of FAUX_RULES) {
    if (trimmed === prompt) {
      return tier;
    }
  }
  return null;
}

async function classify(
  text: string,
): Promise<{ tier: Tier; reasoning: string } | null> {
  const fauxTier = fauxMatch(text);
  if (fauxTier) {
    return { tier: fauxTier, reasoning: "faux exact match" };
  }

  try {
    return await runMicroAgent<{ tier: Tier; reasoning: string }>(
      CLASSIFIER_PROMPT_PATH,
      { prompt: text.trim() },
    );
  } catch {
    return null;
  }
}

export const PromptRouter: Plugin = async ({ client }) => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages?.length) return;

      try {
        const lastUser = [...output.messages]
          .reverse()
          .find((message) => message.info.role === "user");
        if (!lastUser) return;

        const text = lastUser.parts
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join(" ");
        if (!text.trim()) return;

        const classification = await classify(text);
        if (!classification) return;

        const { tier, reasoning } = classification;
        const instruction = await renderTemplate(
          RESPONSE_TEMPLATE_BODY,
          { tier },
          RESPONSE_TEMPLATE_PATH,
        );

        output.messages.push({
          info: {
            id: `router-${Date.now()}`,
            role: "user",
            sessionID: "",
            time: { created: Date.now() },
          } as UserMessage,
          parts: [{ type: "text", text: instruction } as TextPart],
        });

        appendLog({
          ts: new Date().toISOString(),
          session_id: SESSION_ID,
          prompt: text.slice(0, 500),
          tier,
          reasoning,
          injected: true,
        });

        await client.app.log({
          body: {
            service: "prompt-router",
            level: "info",
            message: `Classified as ${tier}: ${reasoning}`,
            extra: { tier, reasoning },
          },
        }).catch(() => {});
      } catch (err: any) {
        await client.app.log({
          body: {
            service: "prompt-router",
            level: "error",
            message: "Error in messages transform",
            extra: { error: err?.message ?? String(err) },
          },
        }).catch(() => {});
      }
    },
  };
};

export default PromptRouter;
