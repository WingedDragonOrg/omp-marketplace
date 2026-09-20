export interface BenchmarkCase {
  /** Stable snake_case metric prefix. */
  name: string;
  /** Fixed number of logical operations in one run. */
  operations: number;
  setup?(): void | Promise<void>;
  verify(): void | Promise<void>;
  run(): number | Promise<number>;
  teardown?(): void | Promise<void>;
}
