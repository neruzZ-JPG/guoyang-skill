import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mockCli = resolve(root, "test", "fixtures", "mock-guoyang-cli.mjs");
const runSearch = resolve(root, "scripts", "run-search.mjs");
const generateReport = resolve(root, "scripts", "generate-report.mjs");
const validateReport = resolve(root, "scripts", "validate-report.mjs");

function invoke(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    `command failed: ${process.execPath} ${script} ${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

function invokeFailure(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0, `command unexpectedly succeeded: ${result.stdout}`);
  return JSON.parse(result.stderr);
}

test("mock CLI 查询、报告生成和验证形成闭环", async () => {
  await chmod(mockCli, 0o755);
  const work = await mkdtemp(resolve(tmpdir(), "guoyang-skill-"));
  const profilePath = resolve(work, "profile.json");
  const strategyPath = resolve(work, "strategy.json");
  const strategyRound2Path = resolve(work, "strategy-round-2.json");
  const analysisPath = resolve(work, "analysis.json");
  const runDir = resolve(work, "run");
  const runDir2 = resolve(work, "run-2");
  const reportPath = resolve(work, "report.html");
  await writeFile(profilePath, JSON.stringify({
    education: "本科",
    major: "新闻传播学",
    schoolTier: "211",
    locations: ["成都"],
    sectors: ["传媒"],
    recruitTypes: ["校招"],
    keywords: ["宣传"],
    excludeKeywords: ["劳务派遣"],
    minimumResults: 1,
    maxQueries: 12,
    resultLimitPerQuery: 5,
    scanLimit: 100,
  }), "utf8");
  await writeFile(strategyPath, JSON.stringify({
    schema: "guoyang-search-strategy/v1",
    objective: "验证成都新闻传播专业的直接岗位和宣传岗位",
    reasoning: "先比较专业字段查询与职责关键词查询的结果。",
    hypotheses: ["岗位可能以宣传而不是新闻传播命名"],
    stopCondition: "完成专业与职责词两类查询",
    iteration: 1,
    queries: [
      {
        id: "direct-major",
        stage: "hypothesis-test",
        purpose: "验证直接专业命中",
        filters: {
          education: "本科",
          major: "新闻传播学",
          location: "成都",
          sector: "传媒",
          recruitType: "校招",
        },
      },
      {
        id: "role-word",
        stage: "hypothesis-test",
        purpose: "验证宣传职责词命中",
        hypothesis: "岗位可能按职责而非专业命名",
        filters: {
          education: "本科",
          location: "成都",
          keyword: "宣传",
          recruitType: "校招",
        },
      },
    ],
  }), "utf8");

  const runResult = invoke(runSearch, [
    "--profile", profilePath,
    "--strategy", strategyPath,
    "--out", runDir,
    "--cli-bin", mockCli,
  ]);
  assert.equal(runResult.ok, true);
  assert.equal(runResult.planningMode, "ai-directed");
  assert.equal(runResult.positions, 1);
  assert.equal(runResult.executedQueries, 2);
  assert.equal(runResult.executedQueries, runResult.plannedQueries);

  const run = JSON.parse(await readFile(resolve(runDir, "run.json"), "utf8"));
  assert.equal(run.cli.version, "0.2.0-mock");
  assert.equal(run.plan.strategy.objective, "验证成都新闻传播专业的直接岗位和宣传岗位");
  assert.equal(run.execution.successfulQueries, run.queryRuns.length);
  assert.equal(run.positions.length, 1);
  assert.ok(run.positions[0].discovery.queryIds.length >= 2);
  assert.equal(run.references.enterprises[0].ok, true);
  assert.equal(run.references.enterprises[0].payload.enterprises.length, 1);
  assert.equal(run.references.calendar[0].ok, true);
  await writeFile(strategyRound2Path, JSON.stringify({
    schema: "guoyang-search-strategy/v1",
    objective: "根据首轮结果补查品牌岗位命名",
    reasoning: "首轮说明职责词有价值，第二轮换用品牌而非重复宣传条件。",
    hypotheses: ["品牌是另一类常见岗位命名"],
    stopCondition: "完成品牌关键词验证后停止",
    iteration: 2,
    queries: [{
      id: "brand-follow-up",
      stage: "follow-up",
      purpose: "验证品牌关键词是否带来新岗位",
      filters: {
        education: "本科",
        location: "成都",
        keyword: "品牌",
        recruitType: "校招",
      },
    }],
  }), "utf8");
  const runResult2 = invoke(runSearch, [
    "--profile", profilePath,
    "--strategy", strategyRound2Path,
    "--previous-run", resolve(runDir, "run.json"),
    "--out", runDir2,
    "--cli-bin", mockCli,
  ]);
  assert.equal(runResult2.planningMode, "ai-directed");
  assert.equal(runResult2.plannedQueries, 3);
  assert.equal(runResult2.executedQueries, 3);
  const run2 = JSON.parse(await readFile(resolve(runDir2, "run.json"), "utf8"));
  assert.equal(run2.execution.previousQueries, 2);
  assert.equal(run2.execution.currentExecutedQueries, 1);
  assert.equal(run2.execution.currentReturnedPositions, 1);
  assert.equal(run2.execution.currentNewPositions, 0);
  assert.equal(run2.execution.currentDistinctPositions, 1);
  assert.equal(run2.positions[0].discovery.queryIds.length, 3);
  assert.equal(run2.positions[0].discovery.seenInCurrentRound, true);
  assert.equal(run2.positions[0].discovery.lastSeenIteration, 2);
  assert.equal(run2.strategies.length, 2);
  assert.deepEqual(run2.strategies.map((strategy) => strategy.iteration), [1, 2]);

  const missingAnalysis = invokeFailure(generateReport, [
    "--run", resolve(runDir2, "run.json"),
    "--out", resolve(work, "should-not-exist.html"),
  ]);
  assert.match(missingAnalysis.error, /正式报告需要 --analysis/u);

  await writeFile(analysisPath, JSON.stringify({
    schema: "guoyang-report-analysis/v1",
    unassessedPolicy: "error",
    headline: "宣传岗位值得优先核验",
    executiveSummary: "专业检索和职责词检索都命中了同一岗位，说明该岗位与当前方向关联较强。",
    searchAssessment: "两条不同假设收敛到同一岗位，继续堆叠同义词的边际价值较低。",
    marketObservations: [{
      title: "职责词有补充价值",
      body: "宣传关键词可以覆盖专业字段之外的岗位表达。",
      evidenceKeys: ["mock:position-1"],
    }],
    customSections: [{
      title: "作品准备",
      paragraphs: ["这类岗位需要用具体内容案例证明能力。"],
      bullets: ["准备一份品牌传播案例"],
      evidenceKeys: ["mock:position-1"],
    }],
    actionPlan: ["今天核验专业目录并准备宣传作品案例"],
    caveats: ["样例来源仅用于测试"],
    followUpQueries: [{
      purpose: "如需扩大范围，再检索品牌岗位",
      filters: { location: "成都", keyword: "品牌" },
    }],
    positionAssessments: [{
      stableKey: "mock:position-1",
      include: true,
      bucket: "priority",
      priority: 91,
      confidence: "high",
      reasons: ["两种检索路径均命中", "专业、地点与招聘类型匹配"],
      risks: ["仍需核验专业代码"],
      nextAction: "今天打开来源页核验并准备投递",
    }],
  }), "utf8");

  const generated = invoke(generateReport, [
    "--run", resolve(runDir2, "run.json"),
    "--analysis", analysisPath,
    "--out", reportPath,
  ]);
  assert.equal(generated.ok, true);
  assert.equal(generated.analysisMode, "ai-directed");
  assert.equal(generated.aiAssessed, 1);
  assert.equal(generated.positions, 1);
  assert.equal(generated.comparison.new, 1);
  assert.equal(generated.log, resolve(work, "report.log.json"));

  const validation = invoke(validateReport, [reportPath]);
  assert.equal(validation.ok, true);
  assert.equal(validation.positions, 1);

  const html = await readFile(reportPath, "utf8");
  assert.doesNotMatch(html, /guoyang-report\/v1/u);
  assert.doesNotMatch(html, /data-position-key|stableKey|查询轨迹|查询覆盖/u);
  assert.doesNotMatch(html, /目标企业与招聘节奏|AI SEARCH STRATEGY|作品准备/u);
  assert.match(html, /示例国有传媒集团/u);
  assert.match(html, /新闻宣传岗/u);
  assert.match(html, /查看岗位并投递/u);
  const report = JSON.parse(await readFile(generated.log, "utf8"));
  assert.equal(report.run.summary.analysisMode, "ai-directed");
  assert.equal(report.run.strategies.length, 2);
  assert.equal(report.positions[0].recommendation.source, "ai");
  assert.equal(report.positions[0].recommendation.score, 91);
});

test("AI 报告不能引用不存在的岗位或漏评估岗位", async () => {
  const work = await mkdtemp(resolve(tmpdir(), "guoyang-analysis-guard-"));
  const runPath = resolve(work, "run.json");
  const outputPath = resolve(work, "report.html");
  const analysisPath = resolve(work, "analysis.json");
  const position = {
    id: "mock:known",
    stableKey: "mock:known",
    source_id: "mock",
    source_position_id: "known",
    enterprise_name: "示例国企",
    title: "宣传岗",
    sector: "传媒文化",
    recruit_type: "campus",
    work_location: "成都",
    headcount: 1,
    education: "本科",
    major: "新闻传播",
    employment_type: "未明确",
    source: "https://example.com/jobs/known",
    fetched_at: "2026-08-28T01:00:00.000Z",
  };
  await writeFile(runPath, JSON.stringify({
    schema: "guoyang-search-run/v1",
    startedAt: "2026-08-28T01:00:00.000Z",
    finishedAt: "2026-08-28T01:05:00.000Z",
    profile: { excludeKeywords: [] },
    cli: { version: "test" },
    plan: { queries: [], resolved: {}, policy: {} },
    execution: { plannedQueries: 0, planningMode: "ai-directed" },
    queryRuns: [],
    positions: [position],
  }), "utf8");
  const baseAnalysis = {
    schema: "guoyang-report-analysis/v1",
    unassessedPolicy: "error",
    headline: "测试",
    executiveSummary: "测试摘要",
    searchAssessment: "测试复盘",
    marketObservations: [],
    actionPlan: [],
    caveats: [],
    followUpQueries: [],
  };
  await writeFile(analysisPath, JSON.stringify({
    ...baseAnalysis,
    positionAssessments: [{
      stableKey: "mock:unknown",
      include: true,
      bucket: "priority",
      priority: 80,
      confidence: "medium",
      reasons: ["测试"],
      risks: [],
      nextAction: "核验",
    }],
  }), "utf8");
  const unknown = invokeFailure(generateReport, [
    "--run", runPath,
    "--analysis", analysisPath,
    "--out", outputPath,
  ]);
  assert.match(unknown.error, /不存在的岗位/u);

  await writeFile(analysisPath, JSON.stringify({
    ...baseAnalysis,
    positionAssessments: [],
  }), "utf8");
  const missing = invokeFailure(generateReport, [
    "--run", runPath,
    "--analysis", analysisPath,
    "--out", outputPath,
  ]);
  assert.match(missing.error, /未覆盖岗位 mock:known/u);
});

test("检索默认要求 AI 策略，确定性基线必须显式启用", async () => {
  await chmod(mockCli, 0o755);
  const work = await mkdtemp(resolve(tmpdir(), "guoyang-baseline-guard-"));
  const profilePath = resolve(work, "profile.json");
  await writeFile(profilePath, JSON.stringify({
    education: "本科",
    major: "新闻传播",
    locations: ["成都"],
    maxQueries: 3,
    resultLimitPerQuery: 3,
    scanLimit: 100,
  }), "utf8");

  const missingStrategy = invokeFailure(runSearch, [
    "--profile", profilePath,
    "--out", resolve(work, "missing"),
    "--cli-bin", mockCli,
  ]);
  assert.match(missingStrategy.error, /正式检索需要 --strategy/u);

  const fallback = invoke(runSearch, [
    "--profile", profilePath,
    "--use-baseline",
    "--out", resolve(work, "baseline"),
    "--cli-bin", mockCli,
  ]);
  assert.equal(fallback.planningMode, "deterministic-baseline");
});

test("历史报告区分变化、新增和本轮未再检出", async () => {
  const work = await mkdtemp(resolve(tmpdir(), "guoyang-history-"));
  const oldRunPath = resolve(work, "old-run.json");
  const newRunPath = resolve(work, "new-run.json");
  const oldReportPath = resolve(work, "old.html");
  const newReportPath = resolve(work, "new.html");
  const oldLogPath = resolve(work, "old.log.json");
  const newLogPath = resolve(work, "new.log.json");

  const base = {
    schema: "guoyang-search-run/v1",
    startedAt: "2026-08-28T01:00:00.000Z",
    finishedAt: "2026-08-28T01:05:00.000Z",
    profile: {
      education: "本科",
      major: "新闻传播学",
      locations: ["成都"],
      sectors: ["传媒文化"],
      recruitTypes: ["campus"],
      keywords: ["宣传"],
      excludeKeywords: [],
    },
    cli: { version: "0.2.0-test" },
    plan: {
      expansionVersion: "1.0.0",
      resolved: {
        sectors: ["传媒文化"],
        recruitTypes: ["campus"],
        expandedLocations: ["成都"],
        majorAliases: ["新闻传播学", "新闻学"],
        roleKeywords: ["宣传"],
      },
      warnings: [],
      policy: {},
      queries: [{ id: "q001" }],
    },
    execution: { stopReason: "test" },
    queryRuns: [{
      queryId: "q001",
      stage: "exact",
      filters: { location: "成都" },
      ok: true,
      returned: 2,
      added: 2,
      data: {
        mode: "live",
        complete: true,
        degraded: false,
        scanned: 2,
        sources: [{
          id: "mock",
          ok: true,
          count: 2,
          scanned: 2,
          exhausted: true,
          truncated: false,
        }],
      },
    }],
  };
  const position = (id, title, deadline) => ({
    id: `mock:${id}`,
    source_id: "mock",
    source_position_id: id,
    enterprise_name: "示例国企",
    title,
    sector: "传媒文化",
    recruit_type: "campus",
    work_location: "成都",
    headcount: 3,
    education: "本科及以上",
    major: "新闻传播学类",
    employment_type: "在编/正式",
    deadline,
    apply_url: `https://example.com/jobs/${id}`,
    source: `https://example.com/jobs/${id}`,
    fetched_at: "2026-08-28T01:00:00.000Z",
    discovery: { firstQueryId: "q001", firstStage: "exact", queryIds: ["q001"], stages: ["exact"] },
  });
  await writeFile(oldRunPath, JSON.stringify({
    ...base,
    positions: [
      position("keep", "宣传岗", "2026-11-01"),
      position("gone", "编辑岗", "2026-10-01"),
    ],
  }), "utf8");
  invoke(generateReport, ["--run", oldRunPath, "--out", oldReportPath, "--allow-fallback"]);

  await writeFile(newRunPath, JSON.stringify({
    ...base,
    startedAt: "2026-08-29T01:00:00.000Z",
    finishedAt: "2026-08-29T01:05:00.000Z",
    positions: [
      position("keep", "品牌宣传岗", "2026-11-15"),
      position("new", "内容运营岗", "2026-12-01"),
    ],
  }), "utf8");
  invoke(generateReport, [
    "--run", newRunPath,
    "--out", newReportPath,
    "--previous-log", oldLogPath,
    "--allow-fallback",
  ]);

  const html = await readFile(newReportPath, "utf8");
  assert.doesNotMatch(html, /本轮未再检出|guoyang-report-data|stableKey/u);
  const report = JSON.parse(await readFile(newLogPath, "utf8"));
  assert.equal(report.comparison.new.length, 1);
  assert.equal(report.comparison.changed.length, 1);
  assert.equal(report.comparison.seenAgain.length, 0);
  assert.equal(report.comparison.notSeenThisRun.length, 1);
  assert.equal(report.comparison.notSeenThisRun[0].stableKey, "mock:gone");
  assert.match(report.comparison.notSeenThisRun[0].note, /不代表岗位已关闭/u);
  assert.equal(report.positions.find((item) => item.stableKey === "mock:keep").changeStatus, "changed");
});
