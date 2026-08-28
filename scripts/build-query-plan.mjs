#!/usr/bin/env node
import { resolve } from "node:path";
import {
  createQueryPlan,
  loadExpansionRules,
  readJson,
  writeJson,
} from "./lib.mjs";

function usage() {
  console.error(
    "用法: node scripts/build-query-plan.mjs --profile <profile.json> [--out <plan.json>] [--rules <expansions.json>]",
  );
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`未知参数: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} 缺少值`);
    result[name] = value;
    index += 1;
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.profile) {
    usage();
    process.exitCode = 2;
  } else {
    const profilePath = resolve(args.profile);
    const rules = await loadExpansionRules(args.rules ? resolve(args.rules) : undefined);
    const plan = createQueryPlan(await readJson(profilePath), rules);
    if (args.out) {
      const outputPath = resolve(args.out);
      await writeJson(outputPath, plan);
      console.log(JSON.stringify({
        ok: true,
        output: outputPath,
        queries: plan.queries.length,
        expansionVersion: plan.expansionVersion,
        warnings: plan.warnings,
      }, null, 2));
    } else {
      console.log(JSON.stringify(plan, null, 2));
    }
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}

