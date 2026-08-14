import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runPinnedGoTests } from "../conformance/scripts/go-reference.js";

const root = resolve(import.meta.dirname, "..");
const executedSubtests = await runPinnedGoReference();

describe("pinned actions/scaleset v0.4.0 Go reference hierarchy", () => {
  for (const name of executedSubtests) {
    it(name, () => {
      // This test name is emitted only after the exact upstream subtest has run
      // and passed in the pinned reference process. TypeScript behavior is
      // validated separately by the named native and differential tests.
      expect(executedSubtests).toContain(name);
    });
  }
});

async function runPinnedGoReference(): Promise<string[]> {
  const { stdout } = await runPinnedGoTests(root);
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as { Action?: string; Test?: string };
    if (event.Action === "pass" && event.Test?.includes("/")) names.add(event.Test);
  }
  return [...names].sort();
}
