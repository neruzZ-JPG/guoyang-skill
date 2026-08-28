#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  REPORT_SCHEMA,
  htmlEscape,
  isIsoDate,
  safeHttpUrl,
  stablePositionKey,
} from "./lib.mjs";

const ALLOWED_BUCKETS = new Set(["priority", "try", "observe"]);
const ALLOWED_CHANGES = new Set(["new", "changed", "seen-again"]);

function fail(errors, message) {
  errors.push(message);
}

function defaultLogPath(reportPath) {
  const extension = extname(reportPath);
  return extension
    ? `${reportPath.slice(0, -extension.length)}.log.json`
    : `${reportPath}.log.json`;
}

function parseArgs(argv) {
  if (!argv[0] || argv[0].startsWith("--")) {
    throw new Error("用法: node scripts/validate-report.mjs <report.html> [--log <report.log.json>]");
  }
  const result = { report: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--log") throw new Error(`未知参数: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--log 缺少值");
    result.log = value;
    index += 1;
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  {
    const reportPath = resolve(args.report);
    const logPath = resolve(args.log ?? defaultLogPath(reportPath));
    const html = await readFile(reportPath, "utf8");
    const report = JSON.parse(await readFile(logPath, "utf8"));
    const errors = [];
    if (!/<!doctype html>/iu.test(html)) fail(errors, "缺少 HTML doctype");
    if (!/<html\b[^>]*lang=["']zh-CN["']/iu.test(html)) fail(errors, "缺少 lang=zh-CN");
    if (/href=["']\s*(?:javascript|data|vbscript):/iu.test(html)) {
      fail(errors, "报告包含危险链接协议");
    }
    if (/<script\b/iu.test(html)) fail(errors, "用户报告不应包含脚本或内嵌机器数据");
    if (/guoyang-report-data|data-position-key|data-bucket|data-change/iu.test(html)) {
      fail(errors, "用户报告暴露了内部机器标记");
    }
    for (const marker of [
      "查询轨迹",
      "查询覆盖",
      "AI SEARCH STRATEGY",
      "guoyang-report/v1",
      "source_id",
      "stableKey",
    ]) {
      if (html.includes(marker)) fail(errors, `用户报告暴露内部信息: ${marker}`);
    }

    if (report.schema !== REPORT_SCHEMA) {
      fail(errors, `日志 schema 应为 ${REPORT_SCHEMA}`);
    }
    if (!isIsoDate(report.generatedAt)) fail(errors, "generatedAt 不是有效 ISO-8601");
    if (!isIsoDate(report.run?.startedAt)) fail(errors, "run.startedAt 不是有效 ISO-8601");
    if (!isIsoDate(report.run?.finishedAt)) fail(errors, "run.finishedAt 不是有效 ISO-8601");
    if (!Array.isArray(report.positions)) fail(errors, "positions 必须是数组");
    if (!report.comparison || typeof report.comparison !== "object") {
      fail(errors, "缺少 comparison 对象");
    }

    const positions = Array.isArray(report.positions) ? report.positions : [];
    const keys = new Set();
    for (const [index, position] of positions.entries()) {
      const prefix = `positions[${index}]`;
      const stableKey = position.stableKey ?? stablePositionKey(position);
      if (!position.stableKey) fail(errors, `${prefix} 缺少 stableKey`);
      if (keys.has(stableKey)) fail(errors, `${prefix} stableKey 重复: ${stableKey}`);
      keys.add(stableKey);
      if (!String(position.enterprise_name ?? "").trim()) fail(errors, `${prefix} 缺少企业名`);
      if (!String(position.title ?? "").trim()) fail(errors, `${prefix} 缺少岗位名`);
      const urls = [
        position.apply_url,
        position.source,
        ...(position.source_urls ?? []),
      ].map(safeHttpUrl).filter(Boolean);
      if (!urls.length) fail(errors, `${prefix} 缺少有效 http/https 来源或投递入口`);
      if (!ALLOWED_BUCKETS.has(position.recommendation?.bucket)) {
        fail(errors, `${prefix} recommendation.bucket 无效`);
      }
      if (!Number.isFinite(position.recommendation?.score)) {
        fail(errors, `${prefix} recommendation.score 必须是数字`);
      }
      if (position.recommendation?.score < 0 || position.recommendation?.score > 100) {
        fail(errors, `${prefix} recommendation.score 必须在 0-100`);
      }
      if (!["ai", "deterministic-fallback"].includes(position.recommendation?.source)) {
        fail(errors, `${prefix} recommendation.source 无效`);
      }
      if (!Array.isArray(position.recommendation?.reasons)) {
        fail(errors, `${prefix} recommendation.reasons 必须是数组`);
      }
      if (!ALLOWED_CHANGES.has(position.changeStatus)) {
        fail(errors, `${prefix} changeStatus 无效`);
      }
      if (!html.includes(`<h2>${htmlEscape(position.title)}</h2>`)) {
        fail(errors, `${prefix} 岗位标题未出现在用户报告`);
      }
      if (!html.includes(`<p class="enterprise">${htmlEscape(position.enterprise_name)}</p>`)) {
        fail(errors, `${prefix} 企业名未出现在用户报告`);
      }
    }

    const cardTags = [...html.matchAll(
      /<article\b[^>]*\bclass=["'][^"']*\bposition-card\b[^"']*["'][^>]*>/giu,
    )].map((match) => match[0]);
    if (cardTags.length !== positions.length) {
      fail(errors, `岗位卡片 ${cardTags.length} 张，与日志岗位 ${positions.length} 条不一致`);
    }

    const summary = report.run?.summary;
    if (!summary || typeof summary !== "object") {
      fail(errors, "缺少 run.summary");
    } else {
      if (summary.positions !== positions.length) {
        fail(errors, `summary.positions=${summary.positions} 与实际 ${positions.length} 不一致`);
      }
      const bucketCounts = { priority: 0, try: 0, observe: 0 };
      for (const position of positions) {
        if (position.recommendation?.bucket in bucketCounts) {
          bucketCounts[position.recommendation.bucket] += 1;
        }
      }
      for (const bucket of Object.keys(bucketCounts)) {
        if (summary.buckets?.[bucket] !== bucketCounts[bucket]) {
          fail(
            errors,
            `summary.buckets.${bucket}=${summary.buckets?.[bucket]} 与实际 ${bucketCounts[bucket]} 不一致`,
          );
        }
      }
    }

    if (!["ai-directed", "hybrid", "deterministic-fallback"].includes(
      report.run?.summary?.analysisMode,
    )) {
      fail(errors, "run.summary.analysisMode 无效");
    }
    const visibleAiCount = positions.filter(
      (position) => position.recommendation?.source === "ai",
    ).length;
    const visibleFallbackCount = positions.filter(
      (position) => position.recommendation?.source === "deterministic-fallback",
    ).length;
    if (report.run?.summary?.aiAssessed !== visibleAiCount) {
      fail(errors, "summary.aiAssessed 与可见岗位不一致");
    }
    if (report.run?.summary?.fallbackAssessed !== visibleFallbackCount) {
      fail(errors, "summary.fallbackAssessed 与可见岗位不一致");
    }
    const expectedAnalysisMode = report.analysis == null
      ? "deterministic-fallback"
      : visibleFallbackCount === 0
        ? "ai-directed"
        : "hybrid";
    if (report.run?.summary?.analysisMode !== expectedAnalysisMode) {
      fail(errors, `analysisMode 应为 ${expectedAnalysisMode}`);
    }
    if (report.run?.summary?.excludedPositions !== (report.excluded?.length ?? 0)) {
      fail(errors, "summary.excludedPositions 与 excluded 数量不一致");
    }
    if (report.analysis !== undefined && report.analysis !== null) {
      if (report.analysis.schema !== "guoyang-report-analysis/v1") {
        fail(errors, "analysis.schema 无效");
      }
      const assessedKeys = new Set();
      for (const assessment of report.analysis.positionAssessments ?? []) {
        if (assessedKeys.has(assessment.stableKey)) {
          fail(errors, `analysis 重复评估岗位: ${assessment.stableKey}`);
        }
        assessedKeys.add(assessment.stableKey);
      }
      if (report.analysis.unassessedPolicy === "error" && visibleFallbackCount !== 0) {
        fail(errors, "unassessedPolicy=error 时不应存在代码兜底岗位");
      }
    }

    const comparison = report.comparison ?? {};
    for (const field of ["new", "changed", "seenAgain", "notSeenThisRun"]) {
      if (!Array.isArray(comparison[field])) fail(errors, `comparison.${field} 必须是数组`);
    }
    const currentChangeKeys = new Set([
      ...(comparison.new ?? []),
      ...(comparison.changed ?? []).map((item) => item.stableKey),
      ...(comparison.seenAgain ?? []),
    ]);
    if (currentChangeKeys.size !== positions.length) {
      fail(errors, "comparison 当前岗位计数与 positions 不一致");
    }

    if (errors.length) {
      console.error(JSON.stringify({ ok: false, report: reportPath, log: logPath, errors }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({
        ok: true,
        report: reportPath,
        log: logPath,
        schema: report.schema,
        positions: report.positions.length,
      }, null, 2));
    }
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
