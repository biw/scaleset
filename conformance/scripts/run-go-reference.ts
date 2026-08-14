import { resolve } from "node:path";
import { runPinnedGoCommand } from "./go-reference.js";

try {
  const { stdout, stderr } = await runPinnedGoCommand(resolve(import.meta.dirname, "../.."), [
    "test",
    "./...",
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} catch (error) {
  const processError = error as Error & { stdout?: string; stderr?: string };
  process.stdout.write(processError.stdout ?? "");
  process.stderr.write(processError.stderr ?? "");
  throw error;
}
