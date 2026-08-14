import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run the pinned Go reference suite and retain its JSON subtest hierarchy.
 *
 * actions/scaleset's current TLS assertion is Linux-specific under Go 1.26:
 * the same untrusted certificate is reported differently by Darwin's TLS
 * stack. Run the unmodified reference suite in Linux on macOS so local and CI
 * both exercise every upstream subtest rather than skipping one.
 */
export function runPinnedGoCommand(root: string, args: string[]) {
  const referenceRoot = resolve(root, "actions-scaleset");
  if (process.platform !== "darwin") {
    return execFileAsync("go", args, { cwd: referenceRoot, maxBuffer: 20 * 1024 * 1024 });
  }
  return execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${referenceRoot}:/src`,
      "-v",
      `${resolve(homedir(), "go/pkg/mod")}:/go/pkg/mod`,
      "-v",
      `${resolve(homedir(), "Library/Caches/go-build")}:/root/.cache/go-build`,
      "-w",
      "/src",
      "golang:1.26",
      "go",
      ...args,
    ],
    { cwd: root, maxBuffer: 20 * 1024 * 1024 },
  );
}

export function runPinnedGoTests(root: string) {
  return runPinnedGoCommand(root, ["test", "-json", "-count=1", ".", "./listener"]);
}
