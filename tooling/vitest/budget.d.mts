export declare const TEST_BUDGET: Readonly<{ testTimeout: number; hookTimeout: number; maxWorkers?: number; reporters?: string[] }>;
export declare function testResults(env?: Record<string, string | undefined>): { reporters?: string[] };
