/** Type side of scripts/ensure-toolchain.mjs. The script body is unchanged. */
export function installedJdkHome(jdkRoot: string): string | null;

export function ensureToolchain(toolsDir?: string): {
  readonly JAVA_HOME: string;
  readonly MVN: string;
  readonly MAVEN_REPO: string;
};
