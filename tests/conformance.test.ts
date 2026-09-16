import { describe, expect, it } from "vitest";
import { loadConformanceScenarios, runConformanceScenario } from "../conformance/run.js";

const scenarios = await loadConformanceScenarios();

describe("Go reference conformance", () => {
  for (const scenario of scenarios) {
    it(scenario.scenario.name, async () => {
      const { reference, typescript } = await runConformanceScenario(scenario);
      expect(typescript).toEqual(reference);
    });
  }
});
