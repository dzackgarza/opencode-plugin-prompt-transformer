export type Tier = "model-self" | "knowledge" | "C" | "B" | "A" | "S";

export const ROUTING_PASSCODES: Record<Tier, string> = {
  "model-self": "ROUTER_PASS_MODEL_SELF_20260309_71F4",
  knowledge: "ROUTER_PASS_KNOWLEDGE_20260309_5B2C",
  C: "ROUTER_PASS_C_20260309_8D11",
  B: "ROUTER_PASS_B_20260309_4E6A",
  A: "ROUTER_PASS_A_20260309_9C03",
  S: "ROUTER_PASS_S_20260309_2F88",
};

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

export function normalizePrompt(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function fauxMatch(text: string): Tier | null {
  const normalized = normalizePrompt(text);
  for (const { prompt, tier } of FAUX_RULES) {
    if (normalized === prompt) {
      return tier;
    }
  }
  return null;
}
