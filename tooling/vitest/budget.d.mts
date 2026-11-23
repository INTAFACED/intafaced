export declare const TEST_BUDGET: Readonly<{
  testTimeout: number;
  hookTimeout: number;
  maxWorkers?: number;
  execArgv?: string[];
  reporters?: string[];
}>;
export declare function nodeStorageOff(version?: string): { execArgv?: string[] };
export declare function testResults(env?: Record<string, string | undefined>): { reporters?: string[] };
