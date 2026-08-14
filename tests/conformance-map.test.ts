import { expect, it } from "vite-plus/test";
import { verifyReferenceMap } from "../conformance/scripts/check-test-map.js";

it("maps every upstream Go Test function and nested subtest", async () => {
  await expect(verifyReferenceMap()).resolves.toBe(165);
}, 60_000);
