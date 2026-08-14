import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execute, type Scenario, type Transcript } from "./ts-driver.js";

const execFileAsync = promisify(execFile);

export interface ConformanceScenario {
  path: string;
  scenario: Scenario;
}

export async function loadConformanceScenarios(): Promise<ConformanceScenario[]> {
  const directory = fileURLToPath(new URL("scenarios/", import.meta.url));
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();

  return Promise.all(
    names.map(async (name) => {
      const path = `${directory}/${name}`;
      const scenario = JSON.parse(await readFile(path, "utf8")) as Scenario;
      return { path, scenario };
    }),
  );
}

export async function runConformanceScenario({
  path,
  scenario,
}: ConformanceScenario): Promise<{ reference: Transcript; typescript: Transcript }> {
  const typescript = await execute(scenario);

  let reference: Transcript;
  try {
    const { stdout } = await execFileAsync("go", ["run", ".", path], {
      cwd: fileURLToPath(new URL("go/", import.meta.url)),
      env: process.env,
    });
    reference = JSON.parse(stdout) as Transcript;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Go reference bridge failed. Run pnpm setup:conformance, then retry.\n${detail}`,
      { cause: error },
    );
  }

  return { reference, typescript };
}

if (import.meta.main) {
  const scenarios = await loadConformanceScenarios();
  for (const scenario of scenarios) {
    const { reference, typescript } = await runConformanceScenario(scenario);
    if (JSON.stringify(reference) !== JSON.stringify(typescript)) {
      console.error("Go reference transcript:", JSON.stringify(reference, null, 2));
      console.error("TypeScript transcript:", JSON.stringify(typescript, null, 2));
      process.exitCode = 1;
      continue;
    }
    console.log(`Conformance passed: ${scenario.scenario.name}`);
  }
}
