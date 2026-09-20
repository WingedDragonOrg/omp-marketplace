import assert from "node:assert/strict";
import type { BenchmarkCase } from "./types";
import { cases as annotationReviewCases } from "./annotation-review";
import { cases as gatesGuardScopeCases } from "./gates-guard-scope";
import { cases as worktreeDelegateCases } from "./worktree-delegate";
import { cases as pythonUtilityCases } from "./python-utilities";

// These workloads exercise local plugin code only. Fail closed on accidental fetch.
globalThis.fetch = Object.assign(
  async () => { throw new Error("Network is disabled in the plugin benchmark"); },
  { preconnect() { throw new Error("Network is disabled in the plugin benchmark"); } },
) as typeof fetch;

const cases: BenchmarkCase[] = [
  ...annotationReviewCases,
  ...gatesGuardScopeCases,
  ...worktreeDelegateCases,
  ...pythonUtilityCases,
];
const warmups = 2;
const sampleCount = 7;
const names = new Set<string>();
const results: Array<{ name: string; operations: number; median: number; madPct: number; checksum: number }> = [];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

assert.ok(cases.length > 0, "At least one workload is required");
console.log(`Benchmark runtime: Bun ${Bun.version}; ${warmups} warmups; ${sampleCount} samples`);
for (const workload of cases) {
  assert.match(workload.name, /^[a-z][a-z0-9_]*$/);
  assert.ok(!names.has(workload.name), `Duplicate workload: ${workload.name}`);
  names.add(workload.name);
  assert.ok(Number.isSafeInteger(workload.operations) && workload.operations > 0);
  try {
    await workload.setup?.();
    await workload.verify();
    let checksum: number | undefined;
    const samples: number[] = [];
    for (let round = 0; round < warmups + sampleCount; round++) {
      // Collect between batches, not inside the timed region. Collection triggered
      // by workload allocations during run() remains part of the measurement.
      Bun.gc(true);
      const start = performance.now();
      const value = await workload.run();
      const elapsed = performance.now() - start;
      assert.ok(Number.isFinite(value), `${workload.name}: invalid checksum`);
      if (checksum === undefined) checksum = value;
      else assert.equal(value, checksum, `${workload.name}: workload state changed between runs`);
      assert.ok(elapsed > 0 && Number.isFinite(elapsed));
      if (round >= warmups) samples.push(elapsed);
    }
    await workload.verify();
    const middle = median(samples);
    const madPct = 100 * median(samples.map(value => Math.abs(value - middle))) / middle;
    results.push({ name: workload.name, operations: workload.operations, median: middle, madPct, checksum: checksum! });
    console.log(JSON.stringify({ workload: workload.name, operations: workload.operations, checksum, samples_ms: samples }));
  } finally {
    await workload.teardown?.();
  }
}

// A geometric mean gives every fixed case equal proportional weight. Never
// compare this score across edits to fixtures, operation counts, or runtime.
const score = Math.exp(results.reduce((sum, result) => sum + Math.log(result.median), 0) / results.length);
for (const result of results) {
  console.log(`METRIC ${result.name}_ms=${result.median.toFixed(6)}`);
}
console.log(`METRIC workload_total_ms=${results.reduce((sum, result) => sum + result.median, 0).toFixed(6)}`);
console.log(`METRIC worst_mad_pct=${Math.max(...results.map(result => result.madPct)).toFixed(6)}`);
console.log(`METRIC plugin_latency_ms=${score.toFixed(6)}`);
