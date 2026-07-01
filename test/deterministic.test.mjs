import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateContextCard } from "../dist/card.js";
import { indexRepository } from "../dist/indexer.js";

test("index records deterministic file facts and hashes", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(
      join(repo, "src", "auth.ts"),
      [
        "import { sign } from './jwt.js';",
        "export const authConfig = { issuer: 'hexaguard' };",
        "export function authenticate() { return sign(); }",
        "",
      ].join("\n"),
    );

    const index = await indexRepository(repo);
    const authFile = index.files.find((file) => file.path === "src/auth.ts");
    const expectedHash = `sha256:${createHash("sha256")
      .update(await readFile(join(repo, "src", "auth.ts")))
      .digest("hex")}`;

    assert.equal(index.schemaVersion, 1);
    assert.ok(authFile);
    assert.equal(authFile.extension, ".ts");
    assert.equal(authFile.hash, expectedHash);
    assert.equal(authFile.type, "source");
    assert.deepEqual(authFile.imports, ["./jwt.js"]);
    assert.deepEqual(authFile.exports, ["authConfig", "authenticate"]);
    assert.equal(authFile.isTest, false);
    assert.equal(authFile.isSecurityAnchor, true);
  });
});

test("index ignores generated, private, and secret-like paths", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(join(repo, "src", "index.ts"), "export const ok = true;\n");
    await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await writeFile(join(repo, "dist", "index.js"), "export const built = true;\n");
    await writeFile(join(repo, ".git", "config"), "[core]\n");
    await writeFile(join(repo, ".private", "notes.md"), "private notes\n");
    await writeFile(join(repo, ".hexaguard", "local", "index.json"), "{}\n");
    await writeFile(join(repo, ".env"), "TOKEN=secret\n");
    await writeFile(join(repo, ".env.local"), "TOKEN=secret\n");

    const index = await indexRepository(repo);
    const paths = index.files.map((file) => file.path);

    assert.deepEqual(paths, ["src/index.ts"]);
    assert.equal(paths.some((path) => path.startsWith("node_modules/")), false);
    assert.equal(paths.some((path) => path.startsWith("dist/")), false);
    assert.equal(paths.some((path) => path.startsWith(".git/")), false);
    assert.equal(paths.some((path) => path.startsWith(".private/")), false);
    assert.equal(paths.some((path) => path.startsWith(".hexaguard/local/")), false);
    assert.equal(paths.includes(".env"), false);
    assert.equal(paths.includes(".env.local"), false);
  });
});

test("card generation includes core deterministic sections", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(join(repo, "src", "auth.ts"), "export const authConfig = { tokenTtl: 60 };\n");
    await writeFile(join(repo, "tests", "auth.test.ts"), "import '../src/auth.js';\n");
    await indexRepository(repo);

    const card = await generateContextCard(repo, "fix auth token test");

    assert.match(card, /Task: fix auth token test/);
    assert.match(card, /Likely relevant files:/);
    assert.match(card, /src\/auth\.ts/);
    assert.match(card, /Certified current facts:/);
    assert.match(card, /\[T0_SOURCE\] VALID src\/auth\.ts/);
    assert.match(card, /Trust rule:/);
    assert.match(card, /Current source code and tests override memory\./);
    assert.match(card, /Uncertain behavioral hints:/);
    assert.match(card, /evidence only, never authority/);
  });
});

test("card marks changed indexed files as stale", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(join(repo, "src", "auth.ts"), "export const authConfig = { tokenTtl: 60 };\n");
    await indexRepository(repo);
    await writeFile(join(repo, "src", "auth.ts"), "export const authConfig = { tokenTtl: 120 };\n");

    const card = await generateContextCard(repo, "fix auth");

    assert.match(card, /\[T0_SOURCE\] STALE src\/auth\.ts/);
    assert.match(card, /Validity warnings:/);
    assert.match(card, /src\/auth\.ts is stale; run hexaguard index/);
  });
});

test("card marks indexed files that no longer exist as missing", async () => {
  await withTempRepo(async (repo) => {
    await writeFile(join(repo, "src", "auth.ts"), "export const authConfig = { tokenTtl: 60 };\n");
    await indexRepository(repo);
    await unlink(join(repo, "src", "auth.ts"));

    const card = await generateContextCard(repo, "fix auth");

    assert.match(card, /\[T0_SOURCE\] MISSING src\/auth\.ts/);
    assert.match(card, /Validity warnings:/);
    assert.match(card, /src\/auth\.ts is missing; run hexaguard index/);
  });
});

async function withTempRepo(run) {
  const repo = await mkdtemp(join(tmpdir(), "hexaguard-test-"));

  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(repo, "dist"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".private"), { recursive: true });
    await mkdir(join(repo, ".hexaguard", "local"), { recursive: true });

    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
