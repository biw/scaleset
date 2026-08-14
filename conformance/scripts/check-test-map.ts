import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runPinnedGoTests } from "./go-reference.js";

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

export async function verifyReferenceMap(
  root = resolve(import.meta.dirname, "../.."),
): Promise<number> {
  const map = JSON.parse(
    await readFile(resolve(root, "conformance/test-map.json"), "utf8"),
  ) as TestMap;
  const files = [...new Set(map.tests.map((entry) => entry.source))];
  const discovered: Array<{ source: string; test: string }> = [];

  for (const source of files) {
    const text = await readFile(resolve(root, "actions-scaleset", source), "utf8");
    for (const match of text.matchAll(/^func (Test\w+)\s*\(/gm)) {
      discovered.push({ source, test: match[1]! });
    }
  }

  const mapped = new Set(map.tests.map((entry) => `${entry.source}:${entry.test}`));
  const missing = discovered.filter((entry) => !mapped.has(`${entry.source}:${entry.test}`));
  const invalid = map.tests.filter(
    (entry) => !discovered.some((test) => test.source === entry.source && test.test === entry.test),
  );
  const nested = map.nestedTests ?? [];
  const nestedDiscovered = await listNestedTests(root, map.tests);
  const mappedNested = new Set(nested.map((entry) => `${entry.source}:${entry.test}`));
  const missingNested = nestedDiscovered.filter(
    (entry) => !mappedNested.has(`${entry.source}:${entry.test}`),
  );
  const invalidNested = nested.filter(
    (entry) =>
      !nestedDiscovered.some((test) => test.source === entry.source && test.test === entry.test),
  );
  const incomplete = [...map.tests, ...nested].filter(
    (entry) =>
      (entry.coverage === "deferred" && !entry.reason) ||
      (entry.coverage !== "deferred" && !entry.target),
  );

  if (
    missing.length ||
    invalid.length ||
    missingNested.length ||
    invalidNested.length ||
    incomplete.length
  ) {
    const failures = [
      missing.length ? "Missing mappings:\n" + missing.map(format).join("\n") : undefined,
      invalid.length
        ? "Mappings for tests no longer in upstream:\n" + invalid.map(format).join("\n")
        : undefined,
      missingNested.length
        ? "Missing nested mappings:\n" + missingNested.map(format).join("\n")
        : undefined,
      invalidNested.length
        ? "Mappings for nested tests no longer in upstream:\n" +
          invalidNested.map(format).join("\n")
        : undefined,
      incomplete.length ? "Incomplete mappings:\n" + incomplete.map(format).join("\n") : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(failures);
  }

  return discovered.length + nestedDiscovered.length;
}

async function listNestedTests(
  root: string,
  roots: Mapping[],
): Promise<Array<{ source: string; test: string }>> {
  const sourceByRoot = new Map(roots.map((entry) => [entry.test, entry.source]));
  const { stdout } = await runPinnedGoTests(root);
  const result: Array<{ source: string; test: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as { Action?: string; Test?: string };
    if (event.Action !== "pass" || !event.Test?.includes("/")) continue;
    const source = sourceByRoot.get(event.Test.split("/", 1)[0]!);
    if (!source) throw new Error(`No source mapping for nested test ${event.Test}`);
    result.push({ source, test: event.Test });
  }
  return result.sort((left, right) => format(left).localeCompare(format(right)));
}

if (import.meta.main) {
  try {
    console.log(`Mapped all ${await verifyReferenceMap()} upstream Go tests and subtests.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

function format(entry: { source: string; test: string }): string {
  return `- ${entry.source}:${entry.test}`;
}
