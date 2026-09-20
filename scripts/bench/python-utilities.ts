import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { BenchmarkCase } from "./types";

function pythonCase(name: string, filename: string): BenchmarkCase {
  const script = fileURLToPath(new URL(filename, import.meta.url));
  function execute(): number {
    const result = Bun.spawnSync(["python3", "-B", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONHASHSEED: "0", PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 30_000,
    });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
    const output = new TextDecoder().decode(result.stdout).trim();
    assert.match(output, /^\d+$/, `${name}: expected an integer checksum`);
    const checksum = Number(output);
    assert.ok(Number.isSafeInteger(checksum));
    return checksum;
  }
  return {
    name,
    // One complete utility workload per run, including Python process startup.
    operations: 1,
    verify() { execute(); },
    run: execute,
  };
}

export const cases: BenchmarkCase[] = [
  pythonCase("model_prices_catalog", "./prices.py"),
  pythonCase("managed_skill_audit", "./skill-audit.py"),
];
