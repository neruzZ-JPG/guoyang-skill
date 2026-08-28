#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  createAiQueryPlan,
  createQueryPlan,
  loadExpansionRules,
  parseCliJson,
  queryFingerprint,
  readJson,
  stablePositionKey,
  writeJson,
} from "./lib.mjs";

function usage() {
  console.error([
    "用法: node scripts/run-search.mjs --profile <profile.json> --out <run-dir>",
    "       (--strategy <ai-strategy.json> | --use-baseline)",
    "       [--previous-run <run.json>]",
    "       [--cli-bin guoyang-pro | --cli-package @neruzz-jpg/guoyang-pro@latest]",
    "       [--rules <expansions.json>]",
  ].join("\n"));
}

function parseArgs(argv) {
  const result = {};
  const booleanArgs = new Set(["use-baseline"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`未知参数: ${token}`);
    const name = token.slice(2);
    if (booleanArgs.has(name)) {
      result[name] = "true";
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} 缺少值`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function cliCommand(args) {
  if (options.cliBin) return { command: options.cliBin, args };
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", options.cliPackage, ...args],
  };
}

function runProcess(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        signal,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
        error: timedOut ? `命令超过 ${timeoutMs}ms` : undefined,
      });
    });
  });
}

async function runCli(args, timeoutMs) {
  const invocation = cliCommand(args);
  return {
    command: invocation.command,
    args: invocation.args,
    ...(await runProcess(invocation.command, invocation.args, { timeoutMs })),
  };
}

async function runReferenceCommand(args, label, timeoutMs = 90_000) {
  const execution = await runCli(args, timeoutMs);
  let payload;
  let parseError;
  try {
    payload = parseCliJson(execution.stdout, label);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: execution.ok && payload?.ok !== false && !parseError,
    args,
    payload,
    error: execution.error ?? parseError ?? payload?.error ??
      (!execution.ok ? execution.stderr.trim() || `${label} 失败` : undefined),
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
  };
}

function mergePosition(map, position, query, strategyIteration) {
  const stableKey = stablePositionKey(position);
  const current = map.get(stableKey);
  if (!current) {
    map.set(stableKey, {
      ...position,
      stableKey,
      discovery: {
        firstQueryId: query.id,
        firstStage: query.stage,
        queryIds: [query.id],
        stages: [query.stage],
        lastQueryId: query.id,
        lastStage: query.stage,
        lastSeenAt: position.fetched_at ?? new Date().toISOString(),
        lastSeenIteration: strategyIteration,
        seenInCurrentRound: true,
      },
    });
    return true;
  }
  const previousDiscovery = current.discovery;
  const sourceUrls = new Set([
    ...(current.source_urls ?? []),
    ...(position.source_urls ?? []),
    current.source,
    current.apply_url,
    position.source,
    position.apply_url,
  ].filter(Boolean));
  const qualityWarnings = [
    ...new Set([...(current.quality_warnings ?? []), ...(position.quality_warnings ?? [])]),
  ];
  Object.assign(current, position, {
    stableKey,
    source_urls: [...sourceUrls],
    quality_warnings: qualityWarnings,
    discovery: previousDiscovery,
  });
  current.discovery ??= {
    firstQueryId: query.id,
    firstStage: query.stage,
    queryIds: [],
    stages: [],
  };
  if (!current.discovery.queryIds.includes(query.id)) current.discovery.queryIds.push(query.id);
  if (!current.discovery.stages.includes(query.stage)) current.discovery.stages.push(query.stage);
  current.discovery.lastQueryId = query.id;
  current.discovery.lastStage = query.stage;
  current.discovery.lastSeenAt = position.fetched_at ?? new Date().toISOString();
  current.discovery.lastSeenIteration = strategyIteration;
  current.discovery.seenInCurrentRound = true;
  return false;
}

const args = parseArgs(process.argv.slice(2));
if (!args.profile || !args.out) {
  usage();
  process.exit(2);
}
function failEarly(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
if (args["cli-bin"] && args["cli-package"]) {
  failEarly("--cli-bin 与 --cli-package 只能使用一个");
}
if (args.strategy && args["use-baseline"]) {
  failEarly("--strategy 与 --use-baseline 只能使用一个");
}
if (!args.strategy && !args["use-baseline"]) {
  failEarly(
    "正式检索需要 --strategy <ai-strategy.json>；仅调试确定性兜底时显式传 --use-baseline",
  );
}

const options = {
  cliBin: args["cli-bin"],
  cliPackage: args["cli-package"] ?? "@neruzz-jpg/guoyang-pro@latest",
};
const profilePath = resolve(args.profile);
const outDir = resolve(args.out);
await mkdir(resolve(outDir, "raw"), { recursive: true });
const sessionStartedAt = new Date().toISOString();

try {
  const profileInput = await readJson(profilePath);
  const rules = await loadExpansionRules(args.rules ? resolve(args.rules) : undefined);
  const baselinePlan = createQueryPlan(profileInput, rules);
  const strategyInput = args.strategy ? await readJson(resolve(args.strategy)) : undefined;
  const plan = strategyInput
    ? createAiQueryPlan(strategyInput, baselinePlan, rules)
    : baselinePlan;
  const previousRunPath = args["previous-run"] ? resolve(args["previous-run"]) : undefined;
  const previousRun = previousRunPath ? await readJson(previousRunPath) : undefined;
  if (previousRun && previousRun.schema !== "guoyang-search-run/v1") {
    throw new Error(`--previous-run schema 不兼容: ${previousRun.schema ?? "缺失"}`);
  }
  if (previousRun && JSON.stringify(previousRun.profile) !== JSON.stringify(plan.profile)) {
    throw new Error("--previous-run 的画像与当前规范化画像不一致；画像变化时请开始新的检索链路");
  }
  const previousQueryCount = previousRun?.queryRuns?.length ?? 0;
  if (previousQueryCount + plan.queries.length > plan.profile.maxQueries) {
    throw new Error(
      `累计查询将达到 ${previousQueryCount + plan.queries.length} 条，超过 maxQueries=${plan.profile.maxQueries}`,
    );
  }
  const previousFingerprints = new Set(
    (previousRun?.queryRuns ?? []).map((queryRun) => queryFingerprint(queryRun.filters)),
  );
  const previousQueryIds = new Set(
    (previousRun?.queryRuns ?? []).map((queryRun) => queryRun.queryId),
  );
  for (const query of plan.queries) {
    if (previousQueryIds.has(query.id)) {
      throw new Error(`AI 查询 id 与前轮重复：${query.id}`);
    }
    if (previousFingerprints.has(queryFingerprint(query.filters)) && query.allowRepeat !== true) {
      throw new Error(
        `AI 查询 ${query.id} 与前轮条件重复；如为状态复查，请在策略中设置 allowRepeat=true`,
      );
    }
  }
  if (previousRun && plan.strategy) {
    const previousIterations = (
      previousRun.strategies ??
      (previousRun.plan?.strategy ? [previousRun.plan.strategy] : [])
    )
      .map((strategy) => Number(strategy.iteration))
      .filter(Number.isFinite);
    const highestPreviousIteration = previousIterations.length
      ? Math.max(...previousIterations)
      : 0;
    if (plan.strategy.iteration <= highestPreviousIteration) {
      throw new Error(
        `AI 策略 iteration=${plan.strategy.iteration} 必须大于前轮 ${highestPreviousIteration}`,
      );
    }
  }
  await writeJson(resolve(outDir, "profile.json"), plan.profile);
  if (strategyInput) {
    await writeJson(resolve(outDir, "baseline-plan.json"), baselinePlan);
    await writeJson(resolve(outDir, "strategy.json"), strategyInput);
  }
  await writeJson(resolve(outDir, "plan.json"), plan);

  const helpResult = await runCli(["help"], 30_000);
  if (!helpResult.ok) {
    throw new Error(`无法运行 guoyang-pro help: ${helpResult.error ?? helpResult.stderr.trim()}`);
  }
  const versionResult = await runCli(["version"], 30_000);
  const sourcesResult = await runCli(["sources", "--static"], 60_000);
  let sourceConfig;
  try {
    sourceConfig = sourcesResult.ok
      ? parseCliJson(sourcesResult.stdout, "sources --static")
      : undefined;
  } catch {
    sourceConfig = undefined;
  }

  const cli = {
    invocation: options.cliBin
      ? { kind: "binary", value: options.cliBin }
      : { kind: "npx-package", value: options.cliPackage },
    version: versionResult.ok ? versionResult.stdout.trim() : null,
    helpChecked: true,
    helpExcerpt: helpResult.stdout.slice(0, 2_000),
    sourceConfig,
    sourceConfigError: sourcesResult.ok
      ? undefined
      : sourcesResult.error ?? sourcesResult.stderr.trim(),
  };
  const sectorReferences = [...new Set([
    ...plan.resolved.sectors,
    ...plan.resolved.relatedSectors,
    ...plan.queries.map((query) => query.filters.sector).filter(Boolean),
  ])].slice(0, 4);
  const recruitTypeReferences = [...new Set([
    ...plan.resolved.recruitTypes,
    ...plan.queries.map((query) => query.filters.recruitType).filter(Boolean),
  ])];
  const enterpriseReferences = [];
  for (const sector of sectorReferences) {
    enterpriseReferences.push(await runReferenceCommand(
      ["enterprises", "--sector", sector, "--limit", "20", "--format", "json"],
      `enterprises --sector ${sector}`,
    ));
  }
  const calendarReferences = [];
  if (sectorReferences.length) {
    for (const sector of sectorReferences) {
      if (recruitTypeReferences.length) {
        for (const recruitType of recruitTypeReferences) {
          calendarReferences.push(await runReferenceCommand(
            ["calendar", "--sector", sector, "--type", recruitType],
            `calendar --sector ${sector} --type ${recruitType}`,
          ));
        }
      } else {
        calendarReferences.push(await runReferenceCommand(
          ["calendar", "--sector", sector],
          `calendar --sector ${sector}`,
        ));
      }
    }
  } else {
    calendarReferences.push(await runReferenceCommand(["calendar"], "calendar"));
  }
  const references = {
    enterprises: [...(previousRun?.references?.enterprises ?? []), ...enterpriseReferences],
    calendar: [...(previousRun?.references?.calendar ?? []), ...calendarReferences],
  };
  await writeJson(resolve(outDir, "references.json"), references);

  const queryRuns = (previousRun?.queryRuns ?? []).map((queryRun) => ({
    ...queryRun,
    importedFrom: previousRunPath
      ? relative(outDir, previousRunPath).replaceAll("\\", "/")
      : undefined,
    rawFile: queryRun.rawFile
      ? relative(
          outDir,
          resolve(previousRunPath ? dirname(previousRunPath) : outDir, queryRun.rawFile),
        ).replaceAll("\\", "/")
      : undefined,
  }));
  const currentQueryRuns = [];
  const positions = new Map();
  for (const position of previousRun?.positions ?? []) {
    const imported = structuredClone(position);
    imported.discovery ??= {
      firstQueryId: undefined,
      firstStage: undefined,
      queryIds: [],
      stages: [],
    };
    imported.discovery.seenInCurrentRound = false;
    positions.set(imported.stableKey ?? stablePositionKey(imported), imported);
  }
  const requiredStages = new Set(plan.policy.minimumRequiredStages);
  let stopReason = null;
  let activeStage = plan.queries[0]?.stage;
  let completedStages = new Set();

  for (const query of plan.queries) {
    if (activeStage && query.stage !== activeStage) {
      completedStages.add(activeStage);
      const requiredDone = [...requiredStages].every((stage) =>
        completedStages.has(stage) || !plan.queries.some((item) => item.stage === stage)
      );
      if (
        plan.policy.stopAtStageBoundary &&
        requiredDone &&
        positions.size >= plan.policy.minimumResults
      ) {
        stopReason =
          `已完成必要阶段并获得 ${positions.size} 个去重岗位，达到 minimumResults=${plan.policy.minimumResults}`;
        break;
      }
      activeStage = query.stage;
    }

    const rawName = `${query.id}.json`;
    const execution = await runCli(query.args, 180_000);
    let payload;
    let parseError;
    try {
      payload = parseCliJson(execution.stdout, query.id);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
    const rawRecord = {
      query,
      execution: {
        command: execution.command,
        args: execution.args,
        exitCode: execution.exitCode,
        signal: execution.signal,
        timedOut: execution.timedOut,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        stderr: execution.stderr,
        error: execution.error,
      },
      payload,
      parseError,
    };
    await writeJson(resolve(outDir, "raw", rawName), rawRecord);

    const queryOk = execution.ok && payload?.ok !== false && !parseError;
    const returned = queryOk && Array.isArray(payload?.positions) ? payload.positions : [];
    let added = 0;
    for (const position of returned) {
      if (
        position &&
        typeof position === "object" &&
        mergePosition(positions, position, query, plan.strategy?.iteration)
      ) {
        added += 1;
      }
    }
    const queryRun = {
      queryId: query.id,
      stage: query.stage,
      rationale: query.rationale,
      hypothesis: query.hypothesis,
      filters: query.filters,
      limit: query.limit,
      scanLimit: query.scanLimit,
      rawFile: `raw/${rawName}`,
      ok: queryOk,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      error: execution.error ?? parseError ?? payload?.error ??
        (!execution.ok ? execution.stderr.trim() || "CLI 查询失败" : undefined),
      returned: returned.length,
      added,
      data: payload?.data,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      planningMode: plan.planningMode,
      strategyIteration: plan.strategy?.iteration,
    };
    queryRuns.push(queryRun);
    currentQueryRuns.push(queryRun);
  }
  if (activeStage) completedStages.add(activeStage);

  const allPositions = [...positions.values()];
  const currentSuccessfulQueries = currentQueryRuns.filter((item) => item.ok).length;
  const previousSuccessfulQueries = (previousRun?.queryRuns ?? [])
    .filter((item) => item.ok)
    .length;
  if (currentSuccessfulQueries === 0 && previousSuccessfulQueries === 0) {
    throw new Error("所有岗位查询都失败；已保留原始运行记录，不生成正常推荐数据");
  }
  if (currentSuccessfulQueries === 0) {
    stopReason = "本轮追加查询全部失败；已保留前轮证据，覆盖状态需要谨慎解读";
  } else if (!stopReason && currentQueryRuns.length === plan.queries.length) {
    stopReason = plan.planningMode === "ai-directed"
      ? "已执行 AI 本轮选择的全部查询；是否继续由 AI 阅读结果后判断"
      : "已执行完整确定性查询计划";
  }
  const successfulQueries = queryRuns.filter((item) => item.ok).length;
  const aggregateStartedAt = previousRun?.startedAt ?? sessionStartedAt;
  const currentReturnedPositions = currentQueryRuns.reduce(
    (sum, queryRun) => sum + queryRun.returned,
    0,
  );
  const currentNewPositions = currentQueryRuns.reduce(
    (sum, queryRun) => sum + queryRun.added,
    0,
  );
  const currentDistinctPositions = allPositions.filter(
    (position) => position.discovery?.seenInCurrentRound,
  ).length;
  const strategies = [
    ...(previousRun?.strategies ??
      (previousRun?.plan?.strategy ? [previousRun.plan.strategy] : [])),
    ...(plan.strategy ? [plan.strategy] : []),
  ];

  const run = {
    schema: "guoyang-search-run/v1",
    startedAt: aggregateStartedAt,
    finishedAt: new Date().toISOString(),
    profile: plan.profile,
    cli,
    plan,
    strategies,
    references,
    execution: {
      stopReason,
      planningMode: plan.planningMode,
      strategy: plan.strategy,
      sessionStartedAt,
      previousRun: previousRunPath
        ? relative(outDir, previousRunPath).replaceAll("\\", "/")
        : undefined,
      previousQueries: previousQueryCount,
      currentPlannedQueries: plan.queries.length,
      currentExecutedQueries: currentQueryRuns.length,
      currentSuccessfulQueries,
      currentReturnedPositions,
      currentNewPositions,
      currentDistinctPositions,
      plannedQueries: previousQueryCount + plan.queries.length,
      executedQueries: queryRuns.length,
      successfulQueries,
      failedQueries: queryRuns.length - successfulQueries,
      skippedQueries: plan.queries.length - currentQueryRuns.length,
      completedStages: [...completedStages],
    },
    queryRuns,
    positions: allPositions,
  };
  await writeJson(resolve(outDir, "run.json"), run);
  console.log(JSON.stringify({
    ok: true,
    output: resolve(outDir, "run.json"),
    planningMode: plan.planningMode,
    plannedQueries: previousQueryCount + plan.queries.length,
    executedQueries: queryRuns.length,
    successfulQueries,
    positions: allPositions.length,
    stopReason,
  }, null, 2));
} catch (error) {
  const failure = {
    schema: "guoyang-search-run-failure/v1",
    startedAt: sessionStartedAt,
    finishedAt: new Date().toISOString(),
    profilePath,
    outputDirectory: outDir,
    error: error instanceof Error ? error.message : String(error),
  };
  await writeJson(resolve(outDir, "failure.json"), failure);
  await writeFile(
    resolve(outDir, "FAILED"),
    `${failure.error}\n查看 ${basename(resolve(outDir, "failure.json"))}\n`,
    "utf8",
  );
  console.error(JSON.stringify({ ok: false, ...failure }, null, 2));
  process.exitCode = 1;
}
