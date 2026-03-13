import type { Plugin } from "@opencode-ai/plugin";
import type { TextPart } from "@opencode-ai/sdk";
import { fetchPromptText, renderTemplateText, runMicroAgent } from "./llm";
import {
  FAUX_RULES,
  fauxMatch,
  normalizePrompt,
  ROUTING_PASSCODES,
  type Tier,
} from "./routing";

const CLASSIFIER_SLUG = "micro-agents/prompt-difficulty-classifier";
const RESPONSE_TEMPLATE_SLUG =
  "micro-agents/prompt-difficulty-classifier/support/response-template";

// Lazy-load prompt texts once per process lifetime.
let _classifierText: string | null = null;
let _responseTemplateText: string | null = null;

function getClassifierText(): string {
  if (!_classifierText) {
    _classifierText = fetchPromptText(CLASSIFIER_SLUG);
  }
  return _classifierText;
}

function getResponseTemplateText(): string {
  if (!_responseTemplateText) {
    _responseTemplateText = fetchPromptText(RESPONSE_TEMPLATE_SLUG);
  }
  return _responseTemplateText;
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
      getClassifierText(),
      { prompt: text.trim() },
    );
    return response.response.structured;
  } catch {
    return null;
  }
}

export const PromptRouter: Plugin = async ({ client }) => {
  return {
    "chat.message": async (_input, output) => {
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
        const instruction = await renderTemplateText(
          getResponseTemplateText(),
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
