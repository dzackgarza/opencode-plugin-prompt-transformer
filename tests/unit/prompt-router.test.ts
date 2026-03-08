import { describe, expect, it } from "bun:test";
import { fauxMatch } from "../../src/index";

describe("prompt-router faux rules", () => {
  it("matches each canonical prompt exactly", () => {
    expect(fauxMatch("Describe every tool you have access to.")).toBe("model-self");
    expect(fauxMatch("What is the latest stable release of TypeScript?")).toBe("knowledge");
    expect(
      fauxMatch(
        "Create a file named router-poc-c.txt containing exactly: poc-baseline-c, then delete it.",
      ),
    ).toBe("C");
    expect(
      fauxMatch(
        "For each .ts file in this directory, open it and print the name of every exported symbol.",
      ),
    ).toBe("B");
    expect(fauxMatch("Audit command-interceptor.ts for security vulnerabilities.")).toBe("A");
    expect(fauxMatch("Design a plugin for tracking token usage per session.")).toBe("S");
  });

  it("trims whitespace before matching", () => {
    expect(fauxMatch("  Describe every tool you have access to.  ")).toBe("model-self");
  });

  it("returns null for partial, unknown, or case-mismatched prompts", () => {
    expect(fauxMatch("Describe every tool")).toBeNull();
    expect(fauxMatch("Hello, how are you?")).toBeNull();
    expect(fauxMatch("describe every tool you have access to.")).toBeNull();
  });
});
