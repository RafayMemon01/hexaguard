# HexaGuard

HexaGuard is a validity-first context governor for AI coding agents. It is a small TypeScript CLI that scans a repository, records cheap deterministic file facts, and generates compact context cards for coding tasks.

Core principle:

> Memory is evidence, not authority.

Current source code and tests always outrank generated memory, summaries, previous agent output, and behavioral hints.

## Problem

AI coding agents often need context, but retrieved context can be stale, over-compressed, or too trusted. HexaGuard helps by generating context from facts that can be checked locally: file paths, hashes, imports, exports, test detection, and security-anchor detection.

The goal is not bigger memory. The goal is accountable context.

## What It Is Not

HexaGuard is not a general AI memory system. The MVP does not use LLM APIs, embeddings, vector databases, cloud sync, MCP, background daemons, or authoritative behavioral memory.

Behavioral hints are placeholder-only in the MVP and must be treated as uncertain evidence.

## Local Usage

Requirements:

- Node.js 20+
- npm

Install and build:

```bash
npm install
npm run build
```

Initialize HexaGuard files:

```bash
node dist/cli.js init
```

This creates:

- `.hexaguard/config.json`
- `.hexaguard/policies/anchors.yml`
- `.hexaguard/local/.gitkeep`

Build the local deterministic index:

```bash
node dist/cli.js index
```

Generate a context card:

```bash
node dist/cli.js card "fix auth bug"
```

## Commands

- `hexaguard init`: creates the local `.hexaguard` project structure.
- `hexaguard index`: scans repository files and writes `.hexaguard/local/index.json`.
- `hexaguard card "<task>"`: reads the index and prints a compact context card.

The indexer ignores generated, private, and secret-like paths such as `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.private`, `.hexaguard/local`, `.env`, and `.env.*`.

## Example Context Card

```text
HexaGuard Context Card

Task: fix auth bug

Likely relevant files:
- [T0_SOURCE] src/auth.ts
- [T1_TEST_CONFIG_SCHEMA] tests/auth.test.ts

Certified current facts:
- [T0_SOURCE] VALID src/auth.ts; current hash matches index (sha256:abc123...); type source
- [T1_TEST_CONFIG_SCHEMA] VALID tests/auth.test.ts; current hash matches index (sha256:def456...); type test

Must verify before editing:
- [T0_SOURCE] src/auth.ts
- [T1_TEST_CONFIG_SCHEMA] tests/auth.test.ts

Security anchors:
- [T0_SOURCE] src/auth.ts

Uncertain behavioral hints:
- None in MVP. Future behavioral hints are T4_AGENT_OBSERVATION/T5_AGENT_SUMMARY: evidence only, never authority.

Trust rule:
- T0_SOURCE and T1_TEST_CONFIG_SCHEMA facts are trusted only when current files match the index.
- T2_HUMAN_POLICY may flag anchors, but it does not override current source or tests.
- Current source code and tests override memory.
```

## Trust And Validity

HexaGuard labels context so agents can see what kind of evidence they are using:

- `T0_SOURCE`: current source files.
- `T1_TEST_CONFIG_SCHEMA`: tests, config, and schema-like files.
- `T2_HUMAN_POLICY`: human-written policy files such as `.hexaguard/policies/anchors.yml`.

Certified facts are checked against the current filesystem:

- `VALID`: the current file hash matches the indexed hash.
- `STALE`: the file exists, but its current hash differs from the indexed hash. Run `hexaguard index`.
- `MISSING`: the file was in the index but no longer exists. Resolve the missing file or re-index.

## MVP Limitations

- No LLM APIs.
- No embeddings.
- No vector database.
- No cloud sync.
- No MCP yet.
- No behavioral memory authority.
- No semantic code understanding beyond cheap deterministic signals.
