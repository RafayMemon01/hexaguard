import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FileFacts, RepositoryIndex } from "./indexer.js";

interface ScoredFile {
  file: FileFacts;
  score: number;
}

const trustLevels = {
  T0_SOURCE: "T0_SOURCE",
  T1_TEST_CONFIG_SCHEMA: "T1_TEST_CONFIG_SCHEMA",
  T2_HUMAN_POLICY: "T2_HUMAN_POLICY",
  T3_HUMAN_NOTES: "T3_HUMAN_NOTES",
  T4_AGENT_OBSERVATION: "T4_AGENT_OBSERVATION",
  T5_AGENT_SUMMARY: "T5_AGENT_SUMMARY",
  T6_EXTERNAL_TEXT: "T6_EXTERNAL_TEXT",
  T7_UNTRUSTED: "T7_UNTRUSTED",
} as const;

type TrustLevel = (typeof trustLevels)[keyof typeof trustLevels];

export class MissingIndexError extends Error {
  constructor() {
    super("No HexaGuard index found at .hexaguard/local/index.json. Run `hexaguard index` first.");
    this.name = "MissingIndexError";
  }
}

const maxLikelyFiles = 5;
const maxCertifiedFacts = 5;
const maxMustVerifyFiles = 7;
const maxSecurityAnchors = 5;

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const testWords = new Set(["spec", "test", "tests", "testing"]);
const securityWords = new Set([
  "acl",
  "auth",
  "csrf",
  "crypto",
  "jwt",
  "permission",
  "policy",
  "role",
  "roles",
  "security",
  "session",
  "token",
]);

export async function generateContextCard(cwd: string, task: string): Promise<string> {
  const index = await readRepositoryIndex(cwd);
  const taskTokens = tokenize(task).filter((token) => !stopWords.has(token));
  const rankedFiles = rankFiles(index.files, taskTokens);
  const likelyFiles = selectLikelyFiles(index.files, rankedFiles);
  const securityAnchors = selectSecurityAnchors(rankedFiles);
  const mustVerifyFiles = selectMustVerifyFiles(likelyFiles, rankedFiles, securityAnchors);
  const certifiedFacts = await buildCertifiedFacts(cwd, likelyFiles.slice(0, maxCertifiedFacts));

  return [
    "HexaGuard Context Card",
    "",
    `Task: ${task}`,
    "",
    "Likely relevant files:",
    formatFileList(likelyFiles),
    "",
    "Certified current facts:",
    formatList(certifiedFacts),
    "",
    "Must verify before editing:",
    formatFileList(mustVerifyFiles),
    "",
    "Security anchors:",
    formatFileList(securityAnchors),
    "",
    "Uncertain behavioral hints:",
    `- None in MVP. Future behavioral hints are ${trustLevels.T4_AGENT_OBSERVATION}/${trustLevels.T5_AGENT_SUMMARY}: evidence only, never authority.`,
    "",
    "Trust rule:",
    `- ${trustLevels.T0_SOURCE} and ${trustLevels.T1_TEST_CONFIG_SCHEMA} facts are trusted only when current files match the index.`,
    `- ${trustLevels.T2_HUMAN_POLICY} may flag anchors, but it does not override current source or tests.`,
    "- Current source code and tests override memory.",
  ].join("\n");
}

async function readRepositoryIndex(cwd: string): Promise<RepositoryIndex> {
  const indexPath = join(cwd, ".hexaguard", "local", "index.json");

  try {
    const rawIndex = await readFile(indexPath, "utf8");
    return JSON.parse(rawIndex) as RepositoryIndex;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new MissingIndexError();
    }

    throw error;
  }
}

function rankFiles(files: FileFacts[], taskTokens: string[]): ScoredFile[] {
  const hasTestIntent = taskTokens.some((token) => testWords.has(token));
  const hasSecurityIntent = taskTokens.some((token) => securityWords.has(token));

  return files
    .map((file) => ({
      file,
      score: scoreFile(file, taskTokens, hasTestIntent, hasSecurityIntent),
    }))
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
}

function scoreFile(
  file: FileFacts,
  taskTokens: string[],
  hasTestIntent: boolean,
  hasSecurityIntent: boolean,
): number {
  const pathText = file.path.toLowerCase();
  const pathTokens = new Set(tokenize(file.path));
  const symbolText = [...file.imports, ...file.exports].join(" ").toLowerCase();
  const symbolTokens = new Set(tokenize(symbolText));
  let score = 0;

  for (const token of taskTokens) {
    if (pathTokens.has(token)) {
      score += 6;
    } else if (pathText.includes(token)) {
      score += 2;
    }

    if (symbolTokens.has(token)) {
      score += 4;
    } else if (symbolText.includes(token)) {
      score += 1;
    }
  }

  if (file.isTest && (hasTestIntent || score > 0)) {
    score += 3;
  }

  if (file.isSecurityAnchor && hasSecurityIntent) {
    score += 4;
  }

  if (score > 0 && file.type === "source") {
    score += 1;
  }

  return score;
}

function selectLikelyFiles(files: FileFacts[], rankedFiles: ScoredFile[]): FileFacts[] {
  const scored = rankedFiles.filter((entry) => entry.score > 0).map((entry) => entry.file);

  if (scored.length > 0) {
    return scored.slice(0, maxLikelyFiles);
  }

  return files
    .slice()
    .sort((left, right) => fileTypePriority(left) - fileTypePriority(right) || left.path.localeCompare(right.path))
    .slice(0, maxLikelyFiles);
}

function selectSecurityAnchors(rankedFiles: ScoredFile[]): FileFacts[] {
  return rankedFiles
    .filter((entry) => entry.file.isSecurityAnchor)
    .map((entry) => entry.file)
    .slice(0, maxSecurityAnchors);
}

function selectMustVerifyFiles(
  likelyFiles: FileFacts[],
  rankedFiles: ScoredFile[],
  securityAnchors: FileFacts[],
): FileFacts[] {
  const relevantTests = rankedFiles
    .filter((entry) => entry.score > 0 && entry.file.isTest)
    .map((entry) => entry.file);

  return uniqueFiles([...likelyFiles, ...relevantTests, ...securityAnchors]).slice(0, maxMustVerifyFiles);
}

async function buildCertifiedFacts(cwd: string, files: FileFacts[]): Promise<string[]> {
  const facts: string[] = [];

  for (const file of files) {
    const trustLevel = getTrustLevel(file);

    try {
      const content = await readFile(join(cwd, file.path));
      const currentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;

      if (currentHash === file.hash) {
        facts.push(`[${trustLevel}] ${file.path} exists; hash matches index (${shortHash(file.hash)}); type ${file.type}`);
      } else {
        facts.push(`[${trustLevel}] ${file.path} changed since the last index; run hexaguard index again`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        facts.push(`[${trustLevel}] ${file.path} is missing since the last index; run hexaguard index again`);
      } else {
        throw error;
      }
    }
  }

  return facts;
}

function getTrustLevel(file: FileFacts): TrustLevel {
  if (file.path.startsWith(".hexaguard/policies/")) {
    return trustLevels.T2_HUMAN_POLICY;
  }

  if (file.isTest || file.type === "test" || isConfigFile(file) || isSchemaFile(file)) {
    return trustLevels.T1_TEST_CONFIG_SCHEMA;
  }

  return trustLevels.T0_SOURCE;
}

function isConfigFile(file: FileFacts): boolean {
  const lowerPath = file.path.toLowerCase();
  const fileName = lowerPath.split("/").at(-1) ?? "";

  return (
    file.type === "config" ||
    fileName === "config.json" ||
    fileName === "package.json" ||
    fileName === "tsconfig.json" ||
    fileName.includes(".config.")
  );
}

function isSchemaFile(file: FileFacts): boolean {
  const lowerPath = file.path.toLowerCase();

  return (
    lowerPath.includes("schema") ||
    lowerPath.endsWith(".graphql") ||
    lowerPath.endsWith(".gql") ||
    lowerPath.endsWith(".proto")
  );
}

function fileTypePriority(file: FileFacts): number {
  if (file.type === "source") {
    return 0;
  }

  if (file.type === "test") {
    return 1;
  }

  if (file.type === "config") {
    return 2;
  }

  if (file.type === "documentation") {
    return 3;
  }

  return 4;
}

function uniqueFiles(files: FileFacts[]): FileFacts[] {
  const seen = new Set<string>();
  const unique: FileFacts[] = [];

  for (const file of files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      unique.push(file);
    }
  }

  return unique;
}

function formatList(items: string[]): string {
  if (items.length === 0) {
    return "- None found in the current index.";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatFileList(files: FileFacts[]): string {
  return formatList(files.map((file) => `[${getTrustLevel(file)}] ${file.path}`));
}

function shortHash(hash: string): string {
  if (!hash.startsWith("sha256:")) {
    return hash;
  }

  return `${hash.slice(0, 19)}...`;
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
