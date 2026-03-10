import { appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import type { Plugin } from "@opencode-ai/plugin";
import type { TextPart } from "@opencode-ai/sdk";
import { renderTemplatePath, runMicroAgent } from "./llm";
import {
  FAUX_RULES,
  fauxMatch,
  normalizePrompt,
  ROUTING_PASSCODES,
  type Tier,
} from "./routing";

const _dir = dirname(fileURLToPath(import.meta.url));
const AI_ROOT = process.env.AI_ROOT || resolve(_dir, "../../../ai");

const CLASSIFIER_PROMPT_PATH = resolve(
  AI_ROOT,
  "prompts/micro_agents/prompt_difficulty_classifier/prompt.md",
);
const RESPONSE_TEMPLATE_PATH = resolve(
  AI_ROOT,
  "prompts/micro_agents/prompt_difficulty_classifier/response_template.md",
);

const LOG_PATH = process.env.PROMPT_TRANSFORMER_LOG_PATH || "/tmp/opencode-plugin-prompt-transformer.log";

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

async function classify(
  text: string,
): Promise<{ tier: Tier; reasoning: string } | null> {
  const fauxTier = fauxMatch(text);
  if (fauxTier) {
    return { tier: fauxTier, reasoning: "faux exact match" };
  }

  try {
    const response = await runMicroAgent<{ tier: Tier; reasoning: string }>(
      CLASSIFIER_PROMPT_PATH,
      { prompt: text.trim() },
    );
    return response.response.structured;
  } catch {
    return null;
  }
}

export const PromptRouter: Plugin = async ({ client }) => {
  return {
    "chat.message": async (input, output) => {
      try {
        const text = output.parts
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join(" ");
        const normalizedText = normalizePrompt(text);
        if (!normalizedText) return;
        const textParts = output.parts.filter((part): part is TextPart => part.type === "text");
        const firstTextPart = textParts[0];
        if (!firstTextPart) return;

        const classification = await classify(normalizedText);
        if (!classification) return;

        const { tier, reasoning } = classification;
        const probePrompt = FAUX_RULES.find(({ prompt, tier: probeTier }) =>
          probeTier === tier && prompt === normalizedText,
        )?.prompt;
        const instruction = await renderTemplatePath(
          RESPONSE_TEMPLATE_PATH,
          {
            tier,
            passcode: ROUTING_PASSCODES[tier],
            probe_prompt: probePrompt ?? "",
          },
        );

        if (probePrompt) {
          firstTextPart.text = instruction;
          for (const part of textParts.slice(1)) {
            part.ignored = true;
          }
        } else {
          firstTextPart.text = `${instruction}\n\n${firstTextPart.text}`;
        }

        appendLog({
          ts: new Date().toISOString(),
          session_id: input.sessionID,
          prompt: normalizedText.slice(0, 500),
          tier,
          reasoning,
          injected: true,
        });

        await client.app.log({
          body: {
            service: "opencode-plugin-prompt-transformer",
            level: "info",
            message: `Classified as ${tier}: ${reasoning}`,
            extra: { tier, reasoning },
          },
        }).catch(() => {});
      } catch (err: any) {
        await client.app.log({
          body: {
            service: "opencode-plugin-prompt-transformer",
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
