import { spawnSync } from 'child_process';

import type { Plugin } from '@opencode-ai/plugin';
import type { Message, Part, TextPart } from '@opencode-ai/sdk';

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

type MessageWithParts = {
  info: Message;
  parts: Part[];
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

function textParts(parts: Part[]): TextPart[] {
  return parts.filter((part): part is TextPart => part.type === 'text');
}

function lastUserMessage(messages: MessageWithParts[]): MessageWithParts | undefined {
  return [...messages].reverse().find((message) => message.info.role === 'user');
}

export const PromptRouter: Plugin = async ({ client }) => {
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        const message = lastUserMessage(output.messages);
        if (!message) return;

        const messageTextParts = textParts(message.parts);
        const text = messageTextParts.map((part) => part.text).join(' ');

        const transform = runTransform(text);
        if (!transform) return;

        const firstTextPart = messageTextParts[0];
        if (!firstTextPart) return;

        firstTextPart.text = transform.transformed_prompt;
        if (transform.probe_prompt) {
          for (const part of messageTextParts.slice(1)) {
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
