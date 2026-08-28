#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  REPORT_SCHEMA,
  htmlEscape,
  readJson,
  safeHttpUrl,
  stablePositionKey,
  writeJson,
} from "./lib.mjs";

const BUCKET_LABELS = {
  priority: "优先投递",
  try: "可以尝试",
  observe: "继续观察",
};
const CHANGE_FIELDS = [
  "enterprise_name",
  "title",
  "work_location",
  "education",
  "major",
  "recruit_type",
  "employment_type",
  "deadline",
  "apply_url",
  "source",
  "quality_warnings",
];

function usage() {
  console.error(
    "用法: node scripts/generate-report.mjs --run <run.json> --out <report.html> (--analysis <ai-analysis.json> | --allow-fallback) [--log <report.log.json>] [--previous-log <previous.log.json>]",
  );
}

function defaultLogPath(outputPath) {
  const extension = extname(outputPath);
  return extension
    ? `${outputPath.slice(0, -extension.length)}.log.json`
    : `${outputPath}.log.json`;
}

function parseArgs(argv) {
  const result = {};
  const booleanArgs = new Set(["allow-fallback"]);
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

function text(value) {
  return String(value ?? "").trim();
}

function joinedPositionText(position) {
  return [
    position.enterprise_name,
    position.title,
    position.work_location,
    position.education,
    position.major,
    position.sector,
    position.desc,
    position.requirements,
    position.remarks,
  ].map(text).join(" ").toLowerCase();
}

function hasToken(haystack, token) {
  return token && haystack.includes(String(token).trim().toLowerCase());
}

function cleanLocation(value) {
  return text(value).replace(
    /(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u,
    "",
  );
}

function parseDeadline(value) {
  if (!value) return undefined;
  const normalized = String(value)
    .trim()
    .replace(/[年/.]/gu, "-")
    .replace(/月/gu, "-")
    .replace(/日/gu, "")
    .replace(/-(\d)(?=-|$)/gu, "-0$1");
  const full = normalized.match(/(20\d{2})-(\d{2})-(\d{2})/u);
  const timestamp = full ? Date.parse(`${full[1]}-${full[2]}-${full[3]}T23:59:59+08:00`) : NaN;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function baselineRecommendation(position, run) {
  const profile = run.profile ?? run.plan?.profile ?? {};
  const resolved = run.plan?.resolved ?? {};
  const haystack = joinedPositionText(position);
  const reasons = [];
  const risks = [];
  let score = 20;

  if (profile.major && hasToken(text(position.major).toLowerCase(), profile.major)) {
    score += 18;
    reasons.push("专业原文命中");
  } else if ((resolved.majorAliases ?? []).some((value) => hasToken(haystack, value))) {
    score += 12;
    reasons.push("相关专业命中");
  } else if (/不限/u.test(text(position.major))) {
    score += 8;
    reasons.push("专业不限");
  } else if (!position.major || /未标注|未知/u.test(text(position.major))) {
    score -= 10;
    risks.push("专业要求未明确");
  }

  const preferredLocations = [
    ...(profile.locations ?? []).map(cleanLocation),
    ...(resolved.expandedLocations ?? []).map(cleanLocation),
  ];
  if (preferredLocations.some((value) => hasToken(position.work_location, value))) {
    score += 14;
    reasons.push("地点匹配");
  } else if ((profile.locations ?? []).length) {
    score -= 8;
    risks.push("地点未明确命中意向范围");
  }

  if ((resolved.sectors ?? []).includes(position.sector)) {
    score += 12;
    reasons.push("行业匹配");
  }
  if ((resolved.recruitTypes ?? []).includes(position.recruit_type)) {
    score += 8;
    reasons.push("招聘类型匹配");
  }

  const keywordHits = [...new Set([
    ...(profile.keywords ?? []),
    ...(resolved.roleKeywords ?? []),
  ].filter((value) => hasToken(haystack, value)))];
  if (keywordHits.length) {
    score += Math.min(18, keywordHits.length * 6);
    reasons.push(`岗位词命中：${keywordHits.slice(0, 3).join("、")}`);
  }

  if (position.employment_type === "在编/正式") {
    score += 5;
    reasons.push("标注为在编/正式");
  } else if (position.employment_type === "劳务派遣") {
    score -= 28;
    risks.push("劳务派遣");
  } else if (!position.employment_type || position.employment_type === "未明确") {
    score -= 5;
    risks.push("用工性质未明确");
  }

  if (Number(position.headcount) >= 10) {
    score += 6;
    reasons.push("公开招聘人数较多");
  } else if (Number(position.headcount) >= 3) {
    score += 3;
    reasons.push("公开招聘人数不少于 3 人");
  }

  const sourceUrl = safeHttpUrl(position.apply_url) ?? safeHttpUrl(position.source) ??
    (position.source_urls ?? []).map(safeHttpUrl).find(Boolean);
  if (sourceUrl) {
    score += 4;
    reasons.push("有可核验入口");
  } else {
    score -= 25;
    risks.push("缺少有效投递或来源链接");
  }

  const deadline = parseDeadline(position.deadline);
  if (deadline !== undefined) {
    const remainingDays = Math.ceil((deadline - Date.now()) / 86_400_000);
    if (remainingDays < 0) {
      score -= 45;
      risks.push("标注截止时间已过");
    } else if (remainingDays <= 7) {
      score += 4;
      risks.push(`距标注截止时间约 ${remainingDays} 天`);
    }
  } else if (!position.deadline) {
    score -= 5;
    risks.push("截止时间未标注");
  } else {
    risks.push("截止时间无法可靠解析");
  }

  const qualityWarnings = Array.isArray(position.quality_warnings)
    ? position.quality_warnings.map(text).filter(Boolean)
    : [];
  if (qualityWarnings.length) {
    score -= Math.min(12, qualityWarnings.length * 3);
    risks.push(...qualityWarnings);
  }

  const hardObserve = risks.some((risk) =>
    /劳务派遣|截止时间已过|缺少有效投递/u.test(risk)
  );
  const bucket = !hardObserve && score >= 58
    ? "priority"
    : !hardObserve && score >= 32
      ? "try"
      : "observe";
  return {
    bucket,
    score: Math.max(0, Math.min(100, score)),
    reasons: [...new Set(reasons)],
    risks: [...new Set(risks)],
    nextAction: "打开来源页面核验资格条件，再决定是否投递。",
    confidence: "low",
    source: "deterministic-fallback",
    disclaimer: "投递优先级为启发式整理，不代表录取概率或官方评价。",
  };
}

function normalizeAiAnalysis(rawAnalysis, positionKeys) {
  if (!rawAnalysis) return undefined;
  if (!rawAnalysis || typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
    throw new Error("AI 报告分析必须是 JSON 对象");
  }
  if (rawAnalysis.schema !== "guoyang-report-analysis/v1") {
    throw new Error("AI 报告分析 schema 必须是 guoyang-report-analysis/v1");
  }
  const headline = text(rawAnalysis.headline);
  const executiveSummary = text(rawAnalysis.executiveSummary);
  const searchAssessment = text(rawAnalysis.searchAssessment);
  if (!headline || !executiveSummary || !searchAssessment) {
    throw new Error("AI 报告分析必须包含 headline、executiveSummary 和 searchAssessment");
  }
  const unassessedPolicy = text(rawAnalysis.unassessedPolicy || "error");
  if (!["error", "exclude", "fallback"].includes(unassessedPolicy)) {
    throw new Error("AI 报告分析 unassessedPolicy 只能是 error、exclude 或 fallback");
  }
  const assessments = Array.isArray(rawAnalysis.positionAssessments)
    ? rawAnalysis.positionAssessments
    : [];
  const seen = new Set();
  const normalizedAssessments = assessments.map((assessment, index) => {
    if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
      throw new Error(`positionAssessments[${index}] 必须是对象`);
    }
    const stableKey = text(assessment.stableKey);
    if (!positionKeys.has(stableKey)) {
      throw new Error(`AI 分析引用了本轮不存在的岗位：${stableKey || "(空 stableKey)"}`);
    }
    if (seen.has(stableKey)) throw new Error(`AI 分析重复评估岗位：${stableKey}`);
    seen.add(stableKey);
    const bucket = text(assessment.bucket);
    if (!["priority", "try", "observe"].includes(bucket)) {
      throw new Error(`AI 岗位 ${stableKey} 的 bucket 无效：${bucket}`);
    }
    const priority = Number(assessment.priority);
    if (!Number.isFinite(priority) || priority < 0 || priority > 100) {
      throw new Error(`AI 岗位 ${stableKey} 的 priority 必须在 0-100`);
    }
    const confidence = text(assessment.confidence || "medium");
    if (!["low", "medium", "high"].includes(confidence)) {
      throw new Error(`AI 岗位 ${stableKey} 的 confidence 无效：${confidence}`);
    }
    const reasons = [...new Set((assessment.reasons ?? []).map(text).filter(Boolean))];
    const risks = [...new Set((assessment.risks ?? []).map(text).filter(Boolean))];
    if (assessment.include !== false && reasons.length === 0) {
      throw new Error(`AI 岗位 ${stableKey} 至少需要一条 reasons`);
    }
    return {
      stableKey,
      include: assessment.include !== false,
      bucket,
      priority,
      confidence,
      reasons,
      risks,
      nextAction: text(assessment.nextAction),
    };
  });
  const normalizeTextItems = (items) =>
    [...new Set((Array.isArray(items) ? items : []).map(text).filter(Boolean))];
  const observations = (Array.isArray(rawAnalysis.marketObservations)
    ? rawAnalysis.marketObservations
    : []).map((observation, index) => {
    const title = text(observation?.title);
    const body = text(observation?.body);
    if (!title || !body) throw new Error(`marketObservations[${index}] 缺少 title 或 body`);
    const evidenceKeys = normalizeTextItems(observation.evidenceKeys);
    for (const key of evidenceKeys) {
      if (!positionKeys.has(key)) {
        throw new Error(`市场观察“${title}”引用了不存在的岗位：${key}`);
      }
    }
    return { title, body, evidenceKeys };
  });
  const customSections = (Array.isArray(rawAnalysis.customSections)
    ? rawAnalysis.customSections
    : []).map((section, index) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new Error(`customSections[${index}] 必须是对象`);
    }
    const title = text(section.title);
    if (!title) throw new Error(`customSections[${index}] 缺少 title`);
    const paragraphs = normalizeTextItems(section.paragraphs);
    const bullets = normalizeTextItems(section.bullets);
    if (!paragraphs.length && !bullets.length) {
      throw new Error(`customSections[${index}] 至少需要 paragraphs 或 bullets`);
    }
    const evidenceKeys = normalizeTextItems(section.evidenceKeys);
    for (const key of evidenceKeys) {
      if (!positionKeys.has(key)) {
        throw new Error(`自定义章节“${title}”引用了不存在的岗位：${key}`);
      }
    }
    return { title, paragraphs, bullets, evidenceKeys };
  });
  const allowedFollowUpFilters = new Set([
    "enterprise",
    "tier",
    "sector",
    "recruitType",
    "education",
    "major",
    "location",
    "employment",
    "keyword",
  ]);
  const followUpQueries = (Array.isArray(rawAnalysis.followUpQueries)
    ? rawAnalysis.followUpQueries
    : []).map((query, index) => {
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      throw new Error(`followUpQueries[${index}] 必须是对象`);
    }
    const purpose = text(query.purpose);
    if (!purpose) throw new Error(`followUpQueries[${index}] 缺少 purpose`);
    const filters = query.filters ?? {};
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
      throw new Error(`followUpQueries[${index}].filters 必须是对象`);
    }
    const unsupported = Object.keys(filters).filter((key) => !allowedFollowUpFilters.has(key));
    if (unsupported.length) {
      throw new Error(`followUpQueries[${index}] 包含不支持的字段：${unsupported.join("、")}`);
    }
    const normalizedFilters = {};
    for (const [key, value] of Object.entries(filters)) {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`followUpQueries[${index}].filters.${key} 必须是字符串或数字`);
      }
      const normalized = text(value);
      if (normalized) normalizedFilters[key] = normalized;
    }
    return { purpose, filters: normalizedFilters };
  });
  return {
    schema: rawAnalysis.schema,
    unassessedPolicy,
    headline,
    executiveSummary,
    searchAssessment,
    marketObservations: observations,
    customSections,
    actionPlan: normalizeTextItems(rawAnalysis.actionPlan),
    caveats: normalizeTextItems(rawAnalysis.caveats),
    followUpQueries,
    positionAssessments: normalizedAssessments,
  };
}

function normalizedComparable(value) {
  if (Array.isArray(value)) return [...value].map(text).sort();
  if (value === undefined || value === null) return null;
  return value;
}

function comparePositions(
  current,
  previous,
  currentEvidenceKeys = new Set(current.map((item) => item.stableKey)),
) {
  const previousMap = new Map((previous?.positions ?? []).map((position) => [
    position.stableKey ?? stablePositionKey(position),
    position,
  ]));
  const added = [];
  const changed = [];
  const seenAgain = [];
  for (const position of current) {
    const old = previousMap.get(position.stableKey);
    if (!old) {
      added.push(position.stableKey);
      position.changeStatus = "new";
      continue;
    }
    const differences = [];
    for (const field of CHANGE_FIELDS) {
      const before = normalizedComparable(old[field]);
      const after = normalizedComparable(position[field]);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        differences.push({ field, before, after });
      }
    }
    if (differences.length) {
      changed.push({ stableKey: position.stableKey, differences });
      position.changeStatus = "changed";
    } else {
      seenAgain.push(position.stableKey);
      position.changeStatus = "seen-again";
    }
  }
  const notSeenThisRun = [];
  for (const [stableKey, position] of previousMap) {
    if (!currentEvidenceKeys.has(stableKey)) {
      notSeenThisRun.push({
        stableKey,
        enterprise_name: position.enterprise_name,
        title: position.title,
        previousBucket: position.recommendation?.bucket,
        note: "本轮未再检出；不代表岗位已关闭，请到官方来源复核。",
      });
    }
  }
  return {
    previousGeneratedAt: previous?.generatedAt ?? null,
    new: added,
    changed,
    seenAgain,
    notSeenThisRun,
  };
}

async function readPreviousReport(path) {
  const content = await readFile(path, "utf8");
  try {
    const parsed = JSON.parse(content);
    if (parsed.schema !== REPORT_SCHEMA) {
      throw new Error(`历史日志 schema 不兼容: ${parsed.schema ?? "缺失"}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Compatibility with reports generated before the sidecar log split.
    } else {
      throw error;
    }
  }
  const matches = [...content.matchAll(
    /<script\b[^>]*\bid=["']guoyang-report-data["'][^>]*>([\s\S]*?)<\/script>/giu,
  )];
  if (matches.length !== 1) {
    throw new Error(`历史报告必须包含唯一 guoyang-report-data JSON 块: ${path}`);
  }
  const parsed = JSON.parse(matches[0][1]);
  if (parsed.schema !== REPORT_SCHEMA) {
    throw new Error(`历史报告 schema 不兼容: ${parsed.schema ?? "缺失"}`);
  }
  return parsed;
}

function sourceSummary(run) {
  const bySource = new Map();
  for (const query of run.queryRuns ?? []) {
    for (const source of query.data?.sources ?? []) {
      const current = bySource.get(source.id) ?? {
        id: source.id,
        queries: 0,
        successfulQueries: 0,
        failedQueries: 0,
        scanned: 0,
        returned: 0,
        truncatedQueries: 0,
        errors: [],
      };
      current.queries += 1;
      current.scanned += Number(source.scanned) || 0;
      current.returned += Number(source.count) || 0;
      if (source.ok) current.successfulQueries += 1;
      else current.failedQueries += 1;
      if (source.truncated) current.truncatedQueries += 1;
      if (source.error && !current.errors.includes(source.error)) current.errors.push(source.error);
      bySource.set(source.id, current);
    }
  }
  return [...bySource.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildSummary(run, positions, excluded, analysis) {
  const queryRuns = run.queryRuns ?? [];
  const modes = {};
  let scanned = 0;
  let degradedQueries = 0;
  let completeQueries = 0;
  for (const query of queryRuns) {
    const mode = query.data?.mode ?? "unknown";
    modes[mode] = (modes[mode] ?? 0) + 1;
    scanned += Number(query.data?.scanned) || 0;
    if (query.data?.degraded) degradedQueries += 1;
    if (query.data?.complete) completeQueries += 1;
  }
  const buckets = { priority: 0, try: 0, observe: 0 };
  for (const position of positions) buckets[position.recommendation.bucket] += 1;
  const aiAssessed = positions.filter(
    (position) => position.recommendation.source === "ai",
  ).length;
  const analysisMode = !analysis
    ? "deterministic-fallback"
    : aiAssessed === positions.length
      ? "ai-directed"
      : "hybrid";
  return {
    positions: positions.length,
    excludedPositions: excluded.length,
    planningMode: run.execution?.planningMode ?? run.plan?.planningMode ?? "unknown",
    analysisMode,
    aiAssessed,
    fallbackAssessed: positions.length - aiAssessed,
    plannedQueries: run.execution?.plannedQueries ??
      run.plan?.queries?.length ??
      queryRuns.length,
    executedQueries: queryRuns.length,
    successfulQueries: queryRuns.filter((query) => query.ok).length,
    failedQueries: queryRuns.filter((query) => !query.ok).length,
    skippedQueries: Math.max(
      0,
      (run.execution?.plannedQueries ?? run.plan?.queries?.length ?? queryRuns.length) -
        queryRuns.length,
    ),
    scanned,
    completeQueries,
    degradedQueries,
    modes,
    buckets,
    coverageComplete: queryRuns.length > 0 &&
      queryRuns.every((query) => query.ok && query.data?.complete === true),
    sources: sourceSummary(run),
  };
}

function compareSort(left, right) {
  const order = { priority: 0, try: 1, observe: 2 };
  const bucketDelta = order[left.recommendation.bucket] - order[right.recommendation.bucket];
  if (bucketDelta) return bucketDelta;
  if (right.recommendation.score !== left.recommendation.score) {
    return right.recommendation.score - left.recommendation.score;
  }
  const leftDeadline = parseDeadline(left.deadline) ?? Number.MAX_SAFE_INTEGER;
  const rightDeadline = parseDeadline(right.deadline) ?? Number.MAX_SAFE_INTEGER;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
  return [
    text(left.enterprise_name),
    text(left.title),
    left.stableKey,
  ].join("\u0000").localeCompare([
    text(right.enterprise_name),
    text(right.title),
    right.stableKey,
  ].join("\u0000"), "zh-CN");
}

function renderUserPosition(position) {
  const recommendation = position.recommendation;
  const recruitTypeLabels = {
    campus: "校招",
    social: "社招",
    intern: "实习",
    unknown: "未标注",
  };
  const url = safeHttpUrl(position.apply_url) ?? safeHttpUrl(position.source) ??
    (position.source_urls ?? []).map(safeHttpUrl).find(Boolean);
  const facts = [
    position.work_location && `地点：${position.work_location}`,
    position.education && `学历：${position.education}`,
    position.major && `专业：${position.major}`,
    position.recruit_type &&
      `类型：${recruitTypeLabels[position.recruit_type] ?? position.recruit_type}`,
    position.employment_type && `用工：${position.employment_type}`,
    Number(position.headcount) > 1 && `人数：${position.headcount}`,
    position.salary_ref && `薪资：${position.salary_ref}`,
    position.deadline && `截止：${position.deadline}`,
  ].filter(Boolean);
  const reasons = recommendation.reasons?.length
    ? `<ul class="reasons">${recommendation.reasons.map((reason) =>
      `<li>${htmlEscape(reason)}</li>`
    ).join("")}</ul>`
    : "";
  const risks = recommendation.risks?.length
    ? `<div class="risks"><strong>需要核验：</strong>${htmlEscape(
      recommendation.risks.join("；"),
    )}</div>`
    : "";
  return `
    <article class="position-card">
      <div class="card-heading">
        <span class="bucket bucket-${recommendation.bucket}">${
          BUCKET_LABELS[recommendation.bucket]
        }</span>
        ${position.deadline ? `<span class="deadline">${htmlEscape(position.deadline)}</span>` : ""}
      </div>
      <h2>${htmlEscape(position.title)}</h2>
      <p class="enterprise">${htmlEscape(position.enterprise_name)}</p>
      <p class="facts">${facts.map(htmlEscape).join(" · ") || "岗位要求请打开来源页面核验"}</p>
      ${reasons}
      ${risks}
      ${recommendation.nextAction
        ? `<p class="action"><strong>建议：</strong>${htmlEscape(recommendation.nextAction)}</p>`
        : ""}
      ${url
        ? `<a class="apply" href="${htmlEscape(url)}" target="_blank" rel="noopener noreferrer">查看岗位并投递 ↗</a>`
        : '<span class="apply disabled">暂无可用投递链接</span>'}
    </article>`;
}

function renderUserHtml(report) {
  const groups = ["priority", "try", "observe"]
    .map((bucket) => ({
      bucket,
      positions: report.positions.filter((position) =>
        position.recommendation.bucket === bucket
      ),
    }))
    .filter((group) => group.positions.length > 0);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>国央企岗位清单</title>
  <style>
    :root { --ink:#17211d; --muted:#67716c; --paper:#f4f2ea; --card:#fffdf8;
      --line:#d8d4c9; --green:#176b4d; --green-soft:#dcecdf; --gold:#95600f;
      --gold-soft:#f5e8c8; --red:#98372f; --red-soft:#f2ded9; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink);
      font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
    .wrap { width:min(980px,calc(100% - 28px)); margin:0 auto; }
    header { padding:42px 0 22px; }
    h1 { margin:0; font-size:clamp(30px,6vw,48px); }
    header p { margin:8px 0 0; color:var(--muted); }
    main { padding-bottom:56px; }
    .bucket-section { margin:24px 0 34px; }
    .section-title { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
    .section-title h2 { margin:0; font-size:22px; }
    .count { color:var(--muted); font-size:13px; }
    .position-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
    .position-card { background:var(--card); border:1px solid var(--line); border-radius:14px;
      padding:19px; box-shadow:0 5px 18px #26332d10; }
    .card-heading { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .bucket { border-radius:999px; padding:5px 9px; font-size:12px; font-weight:750; }
    .bucket-priority { color:var(--green); background:var(--green-soft); }
    .bucket-try { color:var(--gold); background:var(--gold-soft); }
    .bucket-observe { color:var(--red); background:var(--red-soft); }
    .deadline { color:var(--muted); font-size:12px; }
    .position-card h2 { margin:14px 0 5px; font-size:20px; }
    .enterprise { margin:0; color:var(--green); font-weight:700; }
    .facts { color:var(--muted); font-size:13px; line-height:1.65; }
    .reasons { margin:12px 0; padding-left:20px; line-height:1.6; }
    .risks,.action { margin:10px 0; padding:10px 11px; border-radius:8px; font-size:13px; line-height:1.55; }
    .risks { color:var(--red); background:var(--red-soft); }
    .action { background:#edf2e9; }
    .apply { display:inline-block; margin-top:5px; padding:9px 12px; border-radius:8px;
      color:white; background:var(--ink); text-decoration:none; font-size:13px; font-weight:700; }
    .apply.disabled { background:#999f9b; }
    .empty { color:var(--muted); padding:18px 0; }
    footer { color:var(--muted); font-size:12px; padding-bottom:36px; }
    @media (max-width:720px) { .position-list { grid-template-columns:1fr; } }
    @media print {
      body { background:white; }
      .position-card { box-shadow:none; break-inside:avoid; }
    }
  </style>
</head>
<body>
  <header class="wrap">
    <h1>国央企岗位清单</h1>
    <p>共 ${report.positions.length} 个岗位；岗位状态和资格条件请以投递页面为准。</p>
  </header>
  <main class="wrap">
    ${groups.length ? groups.map(({ bucket, positions }) => `
      <section class="bucket-section">
        <div class="section-title">
          <h2>${BUCKET_LABELS[bucket]}</h2>
          <span class="count">${positions.length} 个岗位</span>
        </div>
        <div class="position-list">
          ${positions.map(renderUserPosition).join("")}
        </div>
      </section>`).join("") : '<p class="empty">本轮没有可展示的岗位。</p>'}
  </main>
  <footer class="wrap">请在投递前核验官方页面中的截止时间、专业目录和用工性质。</footer>
</body>
</html>
`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.run || !args.out) {
    usage();
    process.exitCode = 2;
  } else {
    const runPath = resolve(args.run);
    const outputPath = resolve(args.out);
    const logPath = resolve(args.log ?? defaultLogPath(outputPath));
    const run = await readJson(runPath);
    if (run.schema !== "guoyang-search-run/v1") {
      throw new Error(`运行记录 schema 不兼容: ${run.schema ?? "缺失"}`);
    }
    const allPositionKeys = new Set((run.positions ?? []).map((position) =>
      position.stableKey ?? stablePositionKey(position)
    ));
    const allowFallback = args["allow-fallback"] === "true";
    if (!args.analysis && !allowFallback) {
      throw new Error(
        "正式报告需要 --analysis <ai-analysis.json>；仅调试代码兜底时显式传 --allow-fallback",
      );
    }
    const analysis = args.analysis
      ? normalizeAiAnalysis(await readJson(resolve(args.analysis)), allPositionKeys)
      : undefined;
    const assessmentByKey = new Map(
      (analysis?.positionAssessments ?? []).map((assessment) => [
        assessment.stableKey,
        assessment,
      ]),
    );
    const excludeKeywords = (run.profile?.excludeKeywords ?? []).map(text).filter(Boolean);
    const excluded = [];
    const candidates = [];
    for (const rawPosition of run.positions ?? []) {
      const stableKey = rawPosition.stableKey ?? stablePositionKey(rawPosition);
      const haystack = joinedPositionText(rawPosition);
      const matchedExclusions = excludeKeywords.filter((keyword) => hasToken(haystack, keyword));
      if (matchedExclusions.length) {
        excluded.push({
          stableKey,
          enterprise_name: rawPosition.enterprise_name,
          title: rawPosition.title,
          excludedBy: "hard-profile-constraint",
          matchedExclusions,
        });
        continue;
      }
      const aiAssessment = assessmentByKey.get(stableKey);
      if (aiAssessment?.include === false) {
        excluded.push({
          stableKey,
          enterprise_name: rawPosition.enterprise_name,
          title: rawPosition.title,
          excludedBy: "ai-editorial-judgment",
          reasons: aiAssessment.reasons,
          risks: aiAssessment.risks,
        });
        continue;
      }
      if (!aiAssessment && analysis?.unassessedPolicy === "exclude") {
        excluded.push({
          stableKey,
          enterprise_name: rawPosition.enterprise_name,
          title: rawPosition.title,
          excludedBy: "ai-unassessed-policy",
          reasons: ["AI 未将该岗位纳入最终清单"],
          risks: [],
        });
        continue;
      }
      if (!aiAssessment && analysis?.unassessedPolicy === "error") {
        throw new Error(
          `AI 分析未覆盖岗位 ${stableKey}；请补充 assessment，或显式设置 unassessedPolicy=exclude/fallback`,
        );
      }
      const fallback = baselineRecommendation(rawPosition, run);
      const recommendation = aiAssessment
        ? {
            bucket: aiAssessment.bucket,
            score: aiAssessment.priority,
            confidence: aiAssessment.confidence,
            reasons: aiAssessment.reasons,
            risks: aiAssessment.risks,
            nextAction: aiAssessment.nextAction,
            source: "ai",
            disclaimer: "AI 综合判断仅用于安排投递优先级，不代表录取概率或官方评价。",
          }
        : fallback;
      candidates.push({
        ...rawPosition,
        stableKey,
        recommendation,
      });
    }
    const previousPath = args["previous-log"] ?? args.previous;
    const previous = previousPath ? await readPreviousReport(resolve(previousPath)) : undefined;
    const comparison = comparePositions(candidates, previous, allPositionKeys);
    candidates.sort(compareSort);
    const summary = buildSummary(run, candidates, excluded, analysis);
    const generatedAt = new Date().toISOString();
    const report = {
      schema: REPORT_SCHEMA,
      generatedAt,
      profile: run.profile,
      run: {
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        cli: run.cli,
        plan: {
          expansionVersion: run.plan?.expansionVersion,
          planningMode: run.plan?.planningMode,
          strategy: run.plan?.strategy,
          resolved: run.plan?.resolved,
          warnings: run.plan?.warnings ?? [],
          policy: run.plan?.policy,
        },
        execution: run.execution,
        strategies: run.strategies ?? (run.plan?.strategy ? [run.plan.strategy] : []),
        references: run.references,
        queryRuns: run.queryRuns,
        summary,
      },
      positions: candidates,
      excluded,
      analysis,
      comparison,
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderUserHtml(report), "utf8");
    await writeJson(logPath, report);

    const validatorPath = resolve(dirname(new URL(import.meta.url).pathname), "validate-report.mjs");
    const { spawnSync } = await import("node:child_process");
    const validation = spawnSync(process.execPath, [validatorPath, outputPath, "--log", logPath], {
      encoding: "utf8",
    });
    if (validation.status !== 0) {
      throw new Error(`报告已生成但校验失败：${validation.stderr || validation.stdout}`);
    }
    console.log(JSON.stringify({
      ok: true,
      output: outputPath,
      log: logPath,
      positions: candidates.length,
      analysisMode: summary.analysisMode,
      aiAssessed: candidates.filter((position) => position.recommendation.source === "ai").length,
      buckets: summary.buckets,
      comparison: {
        new: comparison.new.length,
        changed: comparison.changed.length,
        seenAgain: comparison.seenAgain.length,
        notSeenThisRun: comparison.notSeenThisRun.length,
      },
      validation: JSON.parse(validation.stdout),
    }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
