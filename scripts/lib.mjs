import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beamSearchMajorTree, loadMajorTree } from "./major-tree.mjs";

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXPANSIONS_PATH = resolve(SKILL_ROOT, "references", "expansions.json");
export const MAJOR_TREE_PATH = resolve(SKILL_ROOT, "references", "major-tree.json");
export const REPORT_SCHEMA = "guoyang-report/v1";

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const raw of values.flat(Infinity)) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function stringArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return uniqueStrings(Array.isArray(value) ? value : [value]);
}

function boundedInt(value, fallback, min, max, name, warnings) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    warnings.push(`${name}=${JSON.stringify(value)} 无效，已使用默认值 ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function normalizeProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("profile 必须是 JSON 对象");
  }
  const warnings = [];
  const acceptedKeys = new Set([
    "education",
    "major",
    "schoolTier",
    "school_tier",
    "locations",
    "location",
    "sectors",
    "sector",
    "recruitTypes",
    "recruit_types",
    "recruitType",
    "recruit_type",
    "keywords",
    "excludeKeywords",
    "exclude_keywords",
    "acceptUnrestrictedMajor",
    "acceptRelocation",
    "maxQueries",
    "minimumResults",
    "resultLimitPerQuery",
    "scanLimit",
    "majorBeamWidth",
    "majorBeamDepth",
    "majorMaxCandidates",
  ]);
  const ignoredKeys = Object.keys(input).filter((key) => !acceptedKeys.has(key));
  if (ignoredKeys.length) {
    warnings.push(`未识别字段未写入画像：${ignoredKeys.join("、")}`);
  }
  const profile = {
    education: String(input.education ?? "").trim(),
    major: String(input.major ?? "").trim(),
    schoolTier: String(input.schoolTier ?? input.school_tier ?? "").trim(),
    locations: stringArray(input.locations ?? input.location),
    sectors: stringArray(input.sectors ?? input.sector),
    recruitTypes: stringArray(
      input.recruitTypes ?? input.recruit_types ?? input.recruitType ?? input.recruit_type,
    ),
    keywords: stringArray(input.keywords),
    excludeKeywords: stringArray(input.excludeKeywords ?? input.exclude_keywords),
    acceptUnrestrictedMajor: input.acceptUnrestrictedMajor !== false,
    acceptRelocation: input.acceptRelocation === true,
  };
  profile.maxQueries = boundedInt(input.maxQueries, 48, 1, 120, "maxQueries", warnings);
  profile.minimumResults = boundedInt(
    input.minimumResults, 20, 1, 500, "minimumResults", warnings,
  );
  profile.resultLimitPerQuery = boundedInt(
    input.resultLimitPerQuery, 30, 1, 100, "resultLimitPerQuery", warnings,
  );
  profile.scanLimit = boundedInt(input.scanLimit, 1500, 100, 5000, "scanLimit", warnings);
  profile.majorBeamWidth = boundedInt(
    input.majorBeamWidth, 8, 1, 64, "majorBeamWidth", warnings,
  );
  profile.majorBeamDepth = boundedInt(
    input.majorBeamDepth, 5, 0, 12, "majorBeamDepth", warnings,
  );
  profile.majorMaxCandidates = boundedInt(
    input.majorMaxCandidates, 24, 1, 200, "majorMaxCandidates", warnings,
  );
  if (profile.scanLimit < profile.resultLimitPerQuery) {
    warnings.push(
      `scanLimit 小于 resultLimitPerQuery，已提升为 ${profile.resultLimitPerQuery}`,
    );
    profile.scanLimit = profile.resultLimitPerQuery;
  }
  if (!profile.education) warnings.push("未提供学历；查询不会应用学历门槛");
  if (!profile.major) warnings.push("未提供专业；无法执行专业树 Beam 扫描");
  if (!profile.locations.length) warnings.push("未提供意向地区；查询不会限定地点");
  if (!profile.sectors.length) warnings.push("未提供意向行业；查询不会限定行业");
  if (!profile.recruitTypes.length) warnings.push("未提供招聘类型；查询会覆盖 CLI 可用类型");
  return { profile, warnings };
}

function cleanLocation(value) {
  return value
    .replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u, "")
    .trim();
}

function normalizeMajorTerm(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[（）()【】[\]、,，.。\s/_-]/gu, "")
    .replace(/专业$/u, "")
    .trim();
}

function resolveSector(value, rules) {
  const exact = rules.standardSectors.includes(value) ? value : undefined;
  return exact ?? rules.sectorAliases[value];
}

function resolveRecruitType(value, rules) {
  return rules.recruitTypeAliases[value] ??
    rules.recruitTypeAliases[String(value).toLowerCase()];
}

export async function loadExpansionRules(path = EXPANSIONS_PATH) {
  const rules = await readJson(path);
  if (!rules.version || !Array.isArray(rules.standardSectors)) {
    throw new Error(`扩展规则格式无效: ${path}`);
  }
  const majorTreePath = resolve(
    dirname(path),
    rules.majorTreeFile ?? MAJOR_TREE_PATH,
  );
  rules.majorTree = await loadMajorTree(majorTreePath);
  return rules;
}

function queryId(index, stage, filters) {
  const digest = createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex")
    .slice(0, 10);
  return `q${String(index + 1).padStart(3, "0")}-${stage}-${digest}`;
}

export function buildSearchArgs(filters, profile) {
  const args = ["search", "--format", "json"];
  const flags = [
    ["enterprise", filters.enterprise],
    ["tier", filters.tier],
    ["education", filters.education],
    ["major", filters.major],
    ["location", filters.location],
    ["sector", filters.sector],
    ["type", filters.recruitType],
    ["employment", filters.employment],
    ["keyword", filters.keyword],
  ];
  for (const [name, value] of flags) {
    if (!value) continue;
    const text = String(value);
    if (text.startsWith("--") || text.includes("\u0000") || text.length > 300) {
      throw new Error(`查询字段 ${name} 的值不安全或过长`);
    }
    args.push(`--${name}`, text);
  }
  args.push(
    "--limit", String(profile.resultLimitPerQuery),
    "--scan-limit", String(profile.scanLimit),
  );
  return args;
}

export function queryFingerprint(filters) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filters ?? {})
        .filter(([, value]) => value !== undefined && value !== "")
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function createAiQueryPlan(rawStrategy, baselinePlan, rules) {
  if (!rawStrategy || typeof rawStrategy !== "object" || Array.isArray(rawStrategy)) {
    throw new Error("AI 检索策略必须是 JSON 对象");
  }
  if (rawStrategy.schema !== "guoyang-search-strategy/v1") {
    throw new Error("AI 检索策略 schema 必须是 guoyang-search-strategy/v1");
  }
  const unknownStrategyKeys = Object.keys(rawStrategy).filter((key) =>
    ![
      "schema",
      "objective",
      "approach",
      "reasoning",
      "hypotheses",
      "stopCondition",
      "iteration",
      "queries",
    ].includes(key)
  );
  if (unknownStrategyKeys.length) {
    throw new Error(`AI 检索策略包含不支持的字段：${unknownStrategyKeys.join("、")}`);
  }
  if (!Array.isArray(rawStrategy.queries) || rawStrategy.queries.length === 0) {
    throw new Error("AI 检索策略至少需要一条 queries");
  }
  if (rawStrategy.queries.length > baselinePlan.profile.maxQueries) {
    throw new Error(
      `AI 检索策略包含 ${rawStrategy.queries.length} 条查询，超过 maxQueries=${baselinePlan.profile.maxQueries}`,
    );
  }
  const allowedFilterKeys = new Set([
    "enterprise",
    "tier",
    "sector",
    "recruitType",
    "recruit_type",
    "education",
    "major",
    "location",
    "employment",
    "keyword",
  ]);
  const tiers = new Set(["T0", "T1", "T2", "T3"]);
  const employments = new Set(["在编/正式", "合同制", "劳务派遣", "未明确"]);
  const fingerprints = new Set();
  const ids = new Set();
  const queries = rawStrategy.queries.map((query, index) => {
    if (!query || typeof query !== "object" || Array.isArray(query)) {
      throw new Error(`AI 查询 ${index + 1} 必须是对象`);
    }
    const unknownQueryKeys = Object.keys(query).filter((key) =>
      !["id", "stage", "purpose", "rationale", "hypothesis", "filters", "allowRepeat", "limit", "scanLimit"]
        .includes(key)
    );
    if (unknownQueryKeys.length) {
      throw new Error(`AI 查询 ${index + 1} 包含不支持的字段：${unknownQueryKeys.join("、")}`);
    }
    const rawFilters = query.filters ?? {};
    if (!rawFilters || typeof rawFilters !== "object" || Array.isArray(rawFilters)) {
      throw new Error(`AI 查询 ${index + 1} 的 filters 必须是对象`);
    }
    const unknownKeys = Object.keys(rawFilters).filter((key) => !allowedFilterKeys.has(key));
    if (unknownKeys.length) {
      throw new Error(`AI 查询 ${index + 1} 包含不支持的过滤字段：${unknownKeys.join("、")}`);
    }
    const nonScalarKeys = Object.entries(rawFilters)
      .filter(([, value]) =>
        value !== undefined &&
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number"
      )
      .map(([key]) => key);
    if (nonScalarKeys.length) {
      throw new Error(`AI 查询 ${index + 1} 的过滤值必须是字符串或数字：${nonScalarKeys.join("、")}`);
    }
    const filters = Object.fromEntries(
      Object.entries(rawFilters)
        .map(([key, value]) => [key === "recruit_type" ? "recruitType" : key, String(value ?? "").trim()])
        .filter(([, value]) => value),
    );
    if (filters.sector) {
      const sector = resolveSector(filters.sector, rules);
      if (!sector) throw new Error(`AI 查询 ${index + 1} 使用未知行业：${filters.sector}`);
      filters.sector = sector;
    }
    if (filters.recruitType) {
      const recruitType = resolveRecruitType(filters.recruitType, rules);
      if (!recruitType) {
        throw new Error(`AI 查询 ${index + 1} 使用未知招聘类型：${filters.recruitType}`);
      }
      filters.recruitType = recruitType;
    }
    if (filters.tier) {
      filters.tier = filters.tier.toUpperCase();
      if (!tiers.has(filters.tier)) throw new Error(`AI 查询 ${index + 1} 使用未知梯队：${filters.tier}`);
    }
    if (filters.employment && !employments.has(filters.employment)) {
      throw new Error(`AI 查询 ${index + 1} 使用未知用工性质：${filters.employment}`);
    }
    const fingerprint = queryFingerprint(filters);
    if (fingerprints.has(fingerprint) && query.allowRepeat !== true) {
      throw new Error(`AI 查询 ${index + 1} 与前序查询重复；如确需复查请设置 allowRepeat=true`);
    }
    fingerprints.add(fingerprint);
    const purpose = String(query.purpose ?? query.rationale ?? "").trim();
    if (!purpose) throw new Error(`AI 查询 ${index + 1} 缺少 purpose`);
    const stage = String(query.stage ?? "ai-directed").trim() || "ai-directed";
    if (!/^[a-zA-Z0-9._-]{1,80}$/u.test(stage)) {
      throw new Error(`AI 查询 ${index + 1} 的 stage 只能包含字母、数字、点、下划线和连字符`);
    }
    const proposedId = String(query.id ?? "").trim();
    if (proposedId && !/^[a-zA-Z0-9._-]{1,80}$/u.test(proposedId)) {
      throw new Error(`AI 查询 ${index + 1} 的 id 只能包含字母、数字、点、下划线和连字符`);
    }
    const id = proposedId || queryId(index, stage, filters);
    if (ids.has(id)) throw new Error(`AI 查询 id 重复：${id}`);
    ids.add(id);
    const limit = query.limit === undefined
      ? baselinePlan.profile.resultLimitPerQuery
      : Number(query.limit);
    const scanLimit = query.scanLimit === undefined
      ? baselinePlan.profile.scanLimit
      : Number(query.scanLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error(`AI 查询 ${index + 1} 的 limit 必须是 1-100 的整数`);
    }
    if (!Number.isInteger(scanLimit) || scanLimit < 100 || scanLimit > 5000) {
      throw new Error(`AI 查询 ${index + 1} 的 scanLimit 必须是 100-5000 的整数`);
    }
    if (scanLimit < limit) {
      throw new Error(`AI 查询 ${index + 1} 的 scanLimit 不能小于 limit`);
    }
    const queryProfile = {
      ...baselinePlan.profile,
      resultLimitPerQuery: limit,
      scanLimit,
    };
    return {
      id,
      stage,
      rationale: purpose,
      hypothesis: String(query.hypothesis ?? "").trim() || undefined,
      filters,
      limit,
      scanLimit,
      args: buildSearchArgs(filters, queryProfile),
      allowRepeat: query.allowRepeat === true || undefined,
    };
  });
  const objective = String(rawStrategy.objective ?? "").trim();
  if (!objective) throw new Error("AI 检索策略缺少 objective");
  if (
    rawStrategy.hypotheses !== undefined &&
    !Array.isArray(rawStrategy.hypotheses)
  ) {
    throw new Error("AI 检索策略 hypotheses 必须是字符串数组");
  }
  const hypotheses = rawStrategy.hypotheses ?? [];
  if (hypotheses.some((item) => typeof item !== "string")) {
    throw new Error("AI 检索策略 hypotheses 只能包含字符串");
  }
  return {
    ...baselinePlan,
    schema: "guoyang-ai-query-plan/v1",
    planningMode: "ai-directed",
    strategy: {
      schema: rawStrategy.schema,
      objective,
      approach: String(rawStrategy.approach ?? rawStrategy.reasoning ?? "").trim(),
      hypotheses: uniqueStrings(hypotheses),
      stopCondition: String(rawStrategy.stopCondition ?? "").trim(),
      iteration: Number.isInteger(rawStrategy.iteration) && rawStrategy.iteration > 0
        ? rawStrategy.iteration
        : 1,
    },
    policy: {
      ...baselinePlan.policy,
      minimumRequiredStages: [],
      stopAtStageBoundary: false,
    },
    queries,
  };
}

function selectQueriesByStage(candidates, maxQueries) {
  const stageOrder = [
    "exact",
    "major-beam",
    "location-expanded",
    "role-expanded",
    "sector-expanded",
    "unrestricted-major",
  ];
  const stageWeights = {
    exact: 2,
    "major-beam": 3,
    "location-expanded": 4,
    "role-expanded": 3,
    "sector-expanded": 2,
    "unrestricted-major": 1,
  };
  const groups = new Map(stageOrder.map((stage) => [
    stage,
    candidates.filter((candidate) => candidate.stage === stage),
  ]));
  const selectedCounts = new Map(stageOrder.map((stage) => [stage, 0]));
  let remaining = maxQueries;

  // Give every available stage one slot before distributing the rest. When the
  // budget is very small, the order preserves exact > major > location.
  for (const stage of stageOrder) {
    if (remaining === 0) break;
    if ((groups.get(stage)?.length ?? 0) === 0) continue;
    selectedCounts.set(stage, 1);
    remaining -= 1;
  }

  while (remaining > 0) {
    let progressed = false;
    for (const stage of stageOrder) {
      const group = groups.get(stage) ?? [];
      for (let turn = 0; turn < stageWeights[stage] && remaining > 0; turn += 1) {
        const count = selectedCounts.get(stage) ?? 0;
        if (count >= group.length) break;
        selectedCounts.set(stage, count + 1);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return stageOrder.flatMap((stage) =>
    (groups.get(stage) ?? []).slice(0, selectedCounts.get(stage) ?? 0)
  );
}

export function createQueryPlan(rawProfile, rules) {
  const normalized = normalizeProfile(rawProfile);
  const { profile } = normalized;
  const warnings = [...normalized.warnings];

  const sectors = uniqueStrings(profile.sectors.map((value) => {
    const resolved = resolveSector(value, rules);
    if (!resolved) warnings.push(`行业“${value}”无法映射为 guoyang-pro 标准行业，已跳过`);
    return resolved ?? "";
  }));
  const recruitTypes = uniqueStrings(profile.recruitTypes.map((value) => {
    const resolved = resolveRecruitType(value, rules);
    if (!resolved) warnings.push(`招聘类型“${value}”无法映射，已跳过`);
    return resolved ?? "";
  }));
  const originalLocations = uniqueStrings(profile.locations.map(cleanLocation));
  const expandedLocationMap = {};
  for (const original of originalLocations) {
    const expanded = rules.provinceCities[original] ?? rules.locationAliases[original] ?? [original];
    expandedLocationMap[original] = uniqueStrings(expanded.map(cleanLocation));
  }
  const expandedLocations = uniqueStrings(Object.values(expandedLocationMap));

  const majorBeam = profile.major
    ? beamSearchMajorTree(profile.major, rules.majorTree, {
        beamWidth: profile.majorBeamWidth,
        maxDepth: profile.majorBeamDepth,
        maxCandidates: profile.majorMaxCandidates,
      })
    : {
        schema: "guoyang-major-beam/v1",
        treeVersion: rules.majorTree.version,
        input: "",
        config: {
          beamWidth: profile.majorBeamWidth,
          maxDepth: profile.majorBeamDepth,
          maxCandidates: profile.majorMaxCandidates,
        },
        matched: false,
        seedNodeIds: [],
        candidates: [],
      };
  const unrestrictedNodeId = rules.majorTree.rootId;
  const actionableMajorCandidates = majorBeam.matched ? majorBeam.candidates : [];
  const majorAliases = uniqueStrings([
    profile.major,
    ...actionableMajorCandidates
      .filter((candidate) => candidate.nodeId !== unrestrictedNodeId)
      .flatMap((candidate) => candidate.queryTerms),
  ]);
  const roleKeywords = uniqueStrings([
    profile.keywords,
    ...actionableMajorCandidates.flatMap((candidate) => candidate.roleKeywords),
  ]);
  const relatedSectors = uniqueStrings(
    actionableMajorCandidates.flatMap((candidate) => candidate.relatedSectors),
  );
  if (profile.major && !majorBeam.matched) {
    warnings.push(`专业“${profile.major}”未命中专业树，仅使用原专业和用户关键词`);
  }

  const sectorValues = sectors.length ? sectors : [""];
  const typeValues = recruitTypes.length ? recruitTypes : [""];
  const originalLocationValues = originalLocations.length ? originalLocations : [""];
  const expandedLocationValues = expandedLocations.length ? expandedLocations : [""];
  const candidates = [];
  const fingerprints = new Set();

  const add = (stage, rationale, filters, metadata = {}) => {
    const cleaned = Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""),
    );
    const fingerprint = JSON.stringify(cleaned);
    if (fingerprints.has(fingerprint)) return;
    fingerprints.add(fingerprint);
    candidates.push({ stage, rationale, filters: cleaned, ...metadata });
  };

  for (const recruitType of typeValues) {
    for (const sector of sectorValues) {
      for (const location of originalLocationValues) {
        add("exact", "使用用户原始专业、地区和意向行业", {
          education: profile.education,
          major: profile.major,
          location,
          sector,
          recruitType,
        });
      }
    }
  }

  const majorTerms = [];
  const seenMajorTerms = new Set([profile.major].filter(Boolean).map(normalizeMajorTerm));
  for (const candidate of actionableMajorCandidates) {
    if (candidate.nodeId === unrestrictedNodeId) continue;
    for (const major of candidate.queryTerms) {
      const normalized = normalizeMajorTerm(major);
      if (!normalized || seenMajorTerms.has(normalized)) continue;
      seenMajorTerms.add(normalized);
      majorTerms.push({ major, candidate });
    }
  }
  for (const { major, candidate } of majorTerms) {
    for (const recruitType of typeValues) {
      for (const sector of sectorValues) {
        for (const location of originalLocationValues) {
          add("major-beam", `沿专业树路径检索“${major}”：${
            candidate.path.map((item) => item.label).join(" → ")
          }`, {
            education: profile.education,
            major,
            location,
            sector,
            recruitType,
          }, {
            majorCandidate: {
              nodeId: candidate.nodeId,
              kind: candidate.kind,
              score: candidate.score,
              path: candidate.path,
            },
          });
        }
      }
    }
  }

  for (const keyword of roleKeywords) {
    for (const recruitType of typeValues) {
      for (const sector of sectorValues) {
        for (const location of originalLocationValues) {
          add("role-expanded", `检索专业相关岗位词“${keyword}”`, {
            education: profile.education,
            location,
            sector,
            recruitType,
            keyword,
          });
        }
      }
    }
  }

  // 每个展开城市只安排一条较宽的原专业查询，避免“城市 × 行业 × 专业”
  // 快速耗尽查询预算。它排在专业和岗位词扩展之后，以保证必要阶段优先。
  for (const location of expandedLocationValues) {
    if (originalLocations.includes(location)) continue;
    for (const recruitType of typeValues) {
      add("location-expanded", `将意向地区展开到“${location}”`, {
        education: profile.education,
        major: profile.major,
        location,
        recruitType,
      });
    }
  }

  for (const sector of relatedSectors) {
    if (sectors.includes(sector)) continue;
    for (const recruitType of typeValues) {
      for (const location of originalLocationValues) {
        add("sector-expanded", `按专业树候选补充相关行业“${sector}”`, {
          education: profile.education,
          major: profile.major,
          location,
          sector,
          recruitType,
        });
      }
    }
  }

  if (profile.acceptUnrestrictedMajor) {
    const unrestrictedNode = rules.majorTree.nodes.find(
      (node) => node.id === unrestrictedNodeId,
    );
    for (const major of unrestrictedNode?.queryTerms ?? ["专业不限", "不限专业"]) {
      for (const recruitType of typeValues) {
        for (const sector of sectorValues) {
          for (const location of originalLocationValues) {
            add("unrestricted-major", `沿专业树根节点补充检索“${major}”岗位`, {
              education: profile.education,
              major,
              location,
              sector,
              recruitType,
            }, {
              majorCandidate: {
                nodeId: unrestrictedNodeId,
                kind: "unrestricted",
                score: majorBeam.candidates.find(
                  (candidate) => candidate.nodeId === unrestrictedNodeId,
                )?.score ?? 0,
                path: [{ nodeId: unrestrictedNodeId, label: unrestrictedNode?.label ?? "专业不限" }],
              },
            });
          }
        }
      }
    }
  }

  const selectedCandidates = selectQueriesByStage(candidates, profile.maxQueries);
  const truncated = candidates.length > selectedCandidates.length;
  if (truncated) {
    warnings.push(`候选查询 ${candidates.length} 条，已按 maxQueries=${profile.maxQueries} 截断`);
  }
  const queries = selectedCandidates.map((candidate, index) => ({
    id: queryId(index, candidate.stage, candidate.filters),
    ...candidate,
    args: buildSearchArgs(candidate.filters, profile),
  }));
  if (!queries.length) {
    add("exact", "未提供筛选条件，执行基础岗位查询", {});
  }

  const selectedStages = new Set(queries.map((query) => query.stage));
  const minimumRequiredStages = [
    "exact",
    selectedStages.has("major-beam") ? "major-beam" : undefined,
    selectedStages.has("location-expanded") ? "location-expanded" : undefined,
  ].filter(Boolean);
  return {
    schema: "guoyang-query-plan/v1",
    createdAt: new Date().toISOString(),
    planningMode: "deterministic-baseline",
    expansionVersion: rules.version,
    profile,
    resolved: {
      sectors,
      recruitTypes,
      originalLocations,
      expandedLocations,
      expandedLocationMap,
      majorFamily: majorBeam.seedNodeIds[0] ?? null,
      majorSeedNodeIds: majorBeam.seedNodeIds,
      majorTreeVersion: majorBeam.treeVersion,
      majorBeam,
      majorAliases,
      roleKeywords,
      relatedSectors,
    },
    policy: {
      minimumRequiredStages,
      minimumResults: profile.minimumResults,
      maxQueries: profile.maxQueries,
      stopAtStageBoundary: true,
    },
    warnings: uniqueStrings(warnings),
    totalCandidateQueries: candidates.length,
    truncated,
    queries,
  };
}

export function parseCliJson(stdout, label) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error(`${label} 未输出 JSON`);
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        // Fall through to the useful error below.
      }
    }
    throw new Error(`${label} 输出不是有效 JSON`);
  }
}

export function stablePositionKey(position) {
  if (position.source_id && position.source_position_id) {
    return `${position.source_id}:${position.source_position_id}`;
  }
  if (position.id) return String(position.id);
  const material = [
    position.enterprise_name,
    position.title,
    position.work_location,
    safeHttpUrl(position.apply_url) ?? safeHttpUrl(position.source) ?? "",
  ].map((value) => String(value ?? "").trim().toLowerCase()).join("\u0000");
  return `derived:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

export function safeHttpUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function jsonForHtml(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function isIsoDate(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u.test(value) &&
    Number.isFinite(Date.parse(value));
}
