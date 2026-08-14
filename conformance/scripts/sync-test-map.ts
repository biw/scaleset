import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runPinnedGoTests } from "./go-reference.js";

const root = resolve(import.meta.dirname, "../..");
const path = resolve(root, "conformance/test-map.json");

interface Mapping {
  source: string;
  test: string;
  coverage: "conformance" | "native" | "reference" | "deferred";
  target?: string;
  reason?: string;
}

interface TestMap {
  tests: Mapping[];
  nestedTests?: Mapping[];
}

const map = JSON.parse(await readFile(path, "utf8")) as TestMap;
const roots = new Map(map.tests.map((entry) => [entry.test, entry]));
const { stdout } = await runPinnedGoTests(root);
const discovered = new Set<string>();
for (const line of stdout.split("\n")) {
  if (!line) continue;
  const event = JSON.parse(line) as { Action?: string; Test?: string };
  if (event.Action === "pass" && event.Test?.includes("/")) discovered.add(event.Test);
}

map.nestedTests = [...discovered].sort().map((test): Mapping => {
  const parent = roots.get(test.split("/", 1)[0]!);
  if (!parent) throw new Error(`No top-level test-map entry for ${test}`);
  return {
    source: parent.source,
    test,
    coverage: "reference",
    target: "tests/go-subtests.test.ts",
  };
});

await writeFile(path, JSON.stringify(map, null, 2) + "\n");
console.log(`Mapped ${map.nestedTests.length} upstream nested Go subtests.`);
