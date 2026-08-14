import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "scaleset-package-"));

try {
  await execFileAsync("pnpm", ["pack", "--pack-destination", scratch], { cwd: root });
  const archive = (await readdir(scratch)).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("pnpm pack did not create a tarball");

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "scaleset-consumer-smoke", private: true, type: "module" }),
  );
  await execFileAsync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", join(scratch, archive)],
    {
      cwd: consumer,
    },
  );
  await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const core = await import("scaleset"); const node = await import("scaleset/node"); if (typeof core.ScaleSetClient !== "function" || typeof node.createNodeFetch !== "function") throw new Error("package exports are incomplete"); const fetch = node.createNodeFetch(); await fetch.close();',
    ],
    { cwd: consumer },
  );
  console.log("Packed package installs and imports successfully.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
