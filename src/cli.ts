#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Command } from "commander";

import { generateContextCard, MissingIndexError } from "./card.js";
import { indexRepository } from "./indexer.js";

const program = new Command();

const configJson = {
  version: 1,
  localDataDir: ".hexaguard/local",
  policies: {
    anchors: ".hexaguard/policies/anchors.yml",
  },
};

const anchorsYaml = `anchors: []
`;

async function writeFileIfMissing(filePath: string, content: string): Promise<"created" | "exists"> {
  try {
    await writeFile(filePath, content, { flag: "wx" });
    return "created";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return "exists";
    }

    throw error;
  }
}

async function initProject(cwd: string): Promise<void> {
  const hexaguardDir = join(cwd, ".hexaguard");
  const policiesDir = join(hexaguardDir, "policies");
  const localDir = join(hexaguardDir, "local");

  await mkdir(policiesDir, { recursive: true });
  await mkdir(localDir, { recursive: true });

  const files = [
    {
      path: join(hexaguardDir, "config.json"),
      label: ".hexaguard/config.json",
      content: `${JSON.stringify(configJson, null, 2)}\n`,
    },
    {
      path: join(policiesDir, "anchors.yml"),
      label: ".hexaguard/policies/anchors.yml",
      content: anchorsYaml,
    },
    {
      path: join(localDir, ".gitkeep"),
      label: ".hexaguard/local/.gitkeep",
      content: "",
    },
  ];

  console.log("Initializing HexaGuard project files...");

  for (const file of files) {
    const result = await writeFileIfMissing(file.path, file.content);

    if (result === "created") {
      console.log(`created ${file.label}`);
    } else {
      console.log(`exists ${file.label} - leaving unchanged`);
    }
  }
}

program
  .name("hexaguard")
  .description("Validity-first context cards for AI coding agents.")
  .version("0.1.0");

program
  .command("init")
  .description("Create the local HexaGuard project structure.")
  .action(async () => {
    try {
      await initProject(process.cwd());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`hexaguard init failed: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("index")
  .description("Scan the repository and record deterministic file facts.")
  .action(async () => {
    try {
      const index = await indexRepository(process.cwd());
      const securityAnchorCount = index.files.filter((file) => file.isSecurityAnchor).length;
      const testFileCount = index.files.filter((file) => file.isTest).length;

      console.log(`Indexed ${index.files.length} files.`);
      console.log(`Detected ${testFileCount} test files and ${securityAnchorCount} security anchors.`);
      console.log("Wrote .hexaguard/local/index.json");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`hexaguard index failed: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("card")
  .description("Generate a compact context card for a task.")
  .argument("<task>", "task description")
  .action(async (task: string) => {
    try {
      console.log(await generateContextCard(process.cwd(), task));
    } catch (error) {
      if (error instanceof MissingIndexError) {
        console.error(error.message);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`hexaguard card failed: ${message}`);
      }

      process.exitCode = 1;
    }
  });

program.parse();
