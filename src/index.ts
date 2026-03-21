import { spawnSync } from 'child_process';

import type { Plugin } from '@opencode-ai/plugin';
import type { TextPart } from '@opencode-ai/sdk';

const UVX = 'uvx';
const CLI_SPEC =
  process.env.PROMPT_TRANSFORMER_CLI_SPEC ??
  'git+https://github.com/dzackgarza/prompt-transformer-manager.git';
const CLI_NAME = 'prompt-transformer';

type TransformResult = {
  normalized_prompt: string;
  tier: string;
  reasoning: string;
  probe_prompt: string | null;
  instruction: string;
  transformed_prompt: string;
};

function runTransform(prompt: string): TransformResult | null {
  const proc = spawnSync(UVX, ['--from', CLI_SPEC, CLI_NAME, 'transform', prompt], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (proc.error) {
    throw new Error(`prompt-transformer spawn error: ${proc.error.message}`);
  }

  const stdout = proc.stdout?.trim() ?? '';
  const stderr = proc.stderr?.trim() ?? '';
  if (proc.status !== 0) {
    throw new Error(stderr || `prompt-transformer exited ${proc.status}`);
  }
  if (!stdout || stdout === 'null') {
    return null;
  }

  const payload = JSON.parse(stdout) as TransformResult;
  return payload;
}

export const PromptRouter: Plugin = async ({ client }) => {
  return {
    'chat.message': async (_input, output) => {
      try {
        const text = output.parts
          .filter((part): part is TextPart => part.type === 'text')
          .map((part) => part.text)
          .join(' ');

        const transform = runTransform(text);
        if (!transform) return;

        const textParts = output.parts.filter(
          (part): part is TextPart => part.type === 'text',
        );
        const firstTextPart = textParts[0];
        if (!firstTextPart) return;

        firstTextPart.text = transform.transformed_prompt;
        if (transform.probe_prompt) {
          for (const part of textParts.slice(1)) {
            part.ignored = true;
          }
        }

        await client.app
          .log({
            body: {
              service: 'opencode-plugin-prompt-transformer',
              level: 'info',
              message: `Classified as ${transform.tier}: ${transform.reasoning}`,
              extra: { tier: transform.tier, reasoning: transform.reasoning },
            },
          })
          .catch(() => {});
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        await client.app
          .log({
            body: {
              service: 'opencode-plugin-prompt-transformer',
              level: 'error',
              message: 'Error in messages transform',
              extra: { error },
            },
          })
          .catch(() => {});
      }
    },
  };
};

export default PromptRouter;
