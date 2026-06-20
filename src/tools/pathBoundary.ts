import path from "node:path";

export interface CwdPathResult {
  absolutePath: string;
  relativePath: string;
}

export function resolvePathInsideCwd(cwd: string, requestedPath: string): CwdPathResult | undefined {
  const cwdAbsolute = path.resolve(cwd);
  const absolutePath = path.resolve(cwdAbsolute, requestedPath);
  const relativePath = path.relative(cwdAbsolute, absolutePath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return {
      absolutePath,
      relativePath: relativePath || ".",
    };
  }

  return undefined;
}
