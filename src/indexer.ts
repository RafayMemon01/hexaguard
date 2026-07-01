import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

export type FileType = "source" | "test" | "config" | "documentation" | "data" | "asset" | "unknown";

export interface FileFacts {
  path: string;
  extension: string;
  size: number;
  hash: string;
  type: FileType;
  imports: string[];
  exports: string[];
  isTest: boolean;
  isSecurityAnchor: boolean;
}

export interface RepositoryIndex {
  schemaVersion: 1;
  files: FileFacts[];
}

const ignoredPathSegments = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".private"]);
const ignoredSecretFileNames = new Set([".env", ".npmrc", ".pypirc", ".netrc"]);
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const documentationExtensions = new Set([".md", ".mdx", ".txt", ".rst"]);
const dataExtensions = new Set([".json", ".yml", ".yaml", ".toml", ".lock"]);
const assetExtensions = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
]);

export async function indexRepository(cwd: string): Promise<RepositoryIndex> {
  const filePaths = await collectFiles(cwd, cwd);
  const files: FileFacts[] = [];

  for (const filePath of filePaths) {
    files.push(await readFileFacts(cwd, filePath));
  }

  files.sort((left, right) => left.path.localeCompare(right.path));

  const index: RepositoryIndex = {
    schemaVersion: 1,
    files,
  };

  const localDir = join(cwd, ".hexaguard", "local");
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  return index;
}

async function collectFiles(root: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of sortedEntries) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = toRepoPath(root, fullPath);

    if (isIgnoredPath(relativePath) || entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readFileFacts(root: string, filePath: string): Promise<FileFacts> {
  const relativePath = toRepoPath(root, filePath);
  const fileStat = await stat(filePath);
  const content = await readFile(filePath);
  const extension = extname(filePath).toLowerCase();
  const isTest = isTestFile(relativePath);
  const text = sourceExtensions.has(extension) ? content.toString("utf8") : "";
  const imports = text ? extractImports(text) : [];
  const exports = text ? extractExports(text) : [];

  return {
    path: relativePath,
    extension,
    size: fileStat.size,
    hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    type: getFileType(relativePath, extension, isTest),
    imports,
    exports,
    isTest,
    isSecurityAnchor: isSecurityAnchor(relativePath, imports, exports),
  };
}

function isIgnoredPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const fileName = parts.at(-1) ?? "";

  if (parts[0] === ".hexaguard" && parts[1] === "local") {
    return true;
  }

  if (parts.some((part) => ignoredPathSegments.has(part))) {
    return true;
  }

  if (ignoredSecretFileNames.has(fileName) || fileName.startsWith(".env.")) {
    return true;
  }

  return /\.(pem|p12|pfx|key)$/i.test(fileName);
}

function toRepoPath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function getFileType(relativePath: string, extension: string, isTest: boolean): FileType {
  const fileName = basename(relativePath).toLowerCase();

  if (isTest) {
    return "test";
  }

  if (sourceExtensions.has(extension)) {
    return "source";
  }

  if (
    fileName === "package.json" ||
    fileName === "tsconfig.json" ||
    fileName.endsWith(".config.js") ||
    fileName.endsWith(".config.ts")
  ) {
    return "config";
  }

  if (documentationExtensions.has(extension)) {
    return "documentation";
  }

  if (dataExtensions.has(extension)) {
    return "data";
  }

  if (assetExtensions.has(extension)) {
    return "asset";
  }

  return "unknown";
}

function isTestFile(relativePath: string): boolean {
  const lowerPath = relativePath.toLowerCase();
  const fileName = basename(lowerPath);
  const parts = lowerPath.split("/");

  return (
    parts.includes("test") ||
    parts.includes("tests") ||
    parts.includes("__tests__") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName)
  );
}

function isSecurityAnchor(relativePath: string, imports: string[], exports: string[]): boolean {
  const searchable = [relativePath, ...imports, ...exports].join(" ").toLowerCase();
  const securityKeywords = [
    "auth",
    "acl",
    "csrf",
    "crypto",
    "guard",
    "jwt",
    "permission",
    "policy",
    "roles",
    "security",
    "session",
    "token",
  ];

  return securityKeywords.some((keyword) => searchable.includes(keyword));
}

function extractImports(text: string): string[] {
  const imports = new Set<string>();
  const importPatterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of importPatterns) {
    for (const match of text.matchAll(pattern)) {
      imports.add(match[1]);
    }
  }

  return [...imports].sort();
}

function extractExports(text: string): string[] {
  const exports = new Set<string>();
  const declarationPattern =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
  const namedExportPattern = /\bexport\s*\{([^}]+)\}/g;
  const commonJsPattern = /\bexports\.([A-Za-z_$][\w$]*)\s*=/g;

  if (/\bexport\s+default\b/.test(text)) {
    exports.add("default");
  }

  for (const match of text.matchAll(declarationPattern)) {
    exports.add(match[1]);
  }

  for (const match of text.matchAll(namedExportPattern)) {
    for (const item of match[1].split(",")) {
      const name = item.trim();

      if (name) {
        exports.add(name);
      }
    }
  }

  for (const match of text.matchAll(commonJsPattern)) {
    exports.add(match[1]);
  }

  if (/\bmodule\.exports\s*=/.test(text)) {
    exports.add("module.exports");
  }

  return [...exports].sort();
}
