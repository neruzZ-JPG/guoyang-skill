import test from "node:test";
import assert from "node:assert/strict";
import {
  createAiQueryPlan,
  createQueryPlan,
  loadExpansionRules,
} from "../scripts/lib.mjs";
import {
  beamSearchMajorTree,
  validateMajorTree,
} from "../scripts/major-tree.mjs";

const rules = await loadExpansionRules();

test("专业树结构合法且汉语言文学路径可追溯到专业不限", () => {
  const validation = validateMajorTree(rules.majorTree);
  assert.deepEqual(validation, { ok: true, errors: [] });

  const beam = beamSearchMajorTree("汉语言文学", rules.majorTree);
  const matched = beam.candidates.find((candidate) =>
    candidate.nodeId === "chinese-language-literature"
  );
  const unrestricted = beam.candidates.find((candidate) =>
    candidate.nodeId === rules.majorTree.rootId
  );

  assert.equal(beam.matched, true);
  assert.ok(matched);
  assert.deepEqual(
    matched.path.map((node) => node.label),
    ["专业不限", "文科/人文社科", "文学", "中国语言文学类", "汉语言文学"],
  );
  assert.equal(unrestricted?.kind, "unrestricted");
  assert.ok(unrestricted?.scanPath.some((node) => node.label === "文学"));
});

test("新闻传播和四川使用专业树 Beam 及城市扩展", () => {
  const profile = {
    education: "本科",
    major: "新闻传播",
    schoolTier: "211",
    locations: ["四川省"],
    sectors: ["传媒", "科技"],
    recruitTypes: ["校招"],
    keywords: ["品牌"],
    maxQueries: 80,
  };
  const first = createQueryPlan(profile, rules);
  const second = createQueryPlan(profile, rules);

  assert.equal(first.expansionVersion, rules.version);
  assert.equal(first.resolved.majorFamily, "journalism-communication");
  assert.equal(first.resolved.majorTreeVersion, "2.0.0");
  assert.equal(first.resolved.majorBeam.schema, "guoyang-major-beam/v1");
  assert.deepEqual(first.resolved.sectors, ["传媒文化", "科技数字"]);
  assert.deepEqual(first.resolved.recruitTypes, ["campus"]);
  assert.ok(first.resolved.majorAliases.includes("新闻学"));
  assert.ok(first.resolved.majorAliases.includes("传播学"));
  assert.ok(first.resolved.majorAliases.includes("文学类"));
  assert.ok(first.resolved.roleKeywords.includes("编辑"));
  assert.ok(first.resolved.expandedLocations.includes("成都"));
  assert.ok(first.resolved.expandedLocations.includes("绵阳"));
  assert.ok(first.queries.some((query) => query.filters.location === "成都"));
  assert.ok(first.queries.some((query) =>
    query.stage === "major-beam" &&
    query.majorCandidate?.path.some((node) => node.label === "文学")
  ));
  assert.ok(first.queries.some((query) => query.stage === "role-expanded"));
  assert.equal(new Set(first.queries.map((query) => query.id)).size, first.queries.length);
  assert.ok(first.queries.length <= profile.maxQueries);
  assert.deepEqual(
    first.queries.map(({ id, stage, filters, args }) => ({ id, stage, filters, args })),
    second.queries.map(({ id, stage, filters, args }) => ({ id, stage, filters, args })),
  );
});

test("未知行业产生警告且不会伪装为标准行业", () => {
  const plan = createQueryPlan({
    education: "硕士",
    major: "星际治理",
    locations: ["成都"],
    sectors: ["宇宙产业"],
    recruitTypes: ["校招"],
    maxQueries: 10,
  }, rules);

  assert.deepEqual(plan.resolved.sectors, []);
  assert.ok(plan.warnings.some((warning) => warning.includes("宇宙产业")));
  assert.ok(plan.warnings.some((warning) => warning.includes("未命中专业树")));
  assert.equal(plan.resolved.majorBeam.matched, false);
  assert.deepEqual(plan.resolved.majorAliases, ["星际治理"]);
  assert.ok(plan.queries.every((query) => !("sector" in query.filters)));
});

test("Beam 宽度和深度限制专业候选且不会横跳到无关兄弟学科", () => {
  const narrow = beamSearchMajorTree("计算机科学与技术", rules.majorTree, {
    beamWidth: 2,
    maxDepth: 2,
    maxCandidates: 10,
  });

  assert.ok(narrow.candidates.length <= 5);
  assert.ok(narrow.candidates.some((candidate) => candidate.nodeId === "computer-science"));
  assert.ok(narrow.candidates.some((candidate) => candidate.nodeId === "computer"));
  assert.equal(
    narrow.candidates.some((candidate) => candidate.nodeId === "civil-engineering"),
    false,
  );
  assert.equal(
    narrow.candidates.some((candidate) => candidate.nodeId === "software-engineering"),
    false,
  );

  const leaf = beamSearchMajorTree("软件工程", rules.majorTree);
  assert.ok(leaf.candidates.some((candidate) => candidate.nodeId === "software-engineering"));
  assert.equal(
    leaf.candidates.some((candidate) => candidate.nodeId === "computer-science"),
    false,
  );
  assert.equal(
    leaf.candidates.some((candidate) => candidate.nodeId === "data-ai"),
    false,
  );
});

test("向量分数只召回候选起点，不直接证明专业兼容", () => {
  const semantic = beamSearchMajorTree("智能内容技术", rules.majorTree, {
    beamWidth: 2,
    maxDepth: 1,
    maxCandidates: 5,
    semanticScores: {
      "journalism-communication": 0.9,
      computer: 0.84,
    },
  });

  assert.equal(semantic.matched, false);
  assert.equal(semantic.semanticRecallUsed, true);
  assert.ok(semantic.candidates.some((candidate) =>
    candidate.nodeId === "journalism-communication" &&
    candidate.kind === "semantic" &&
    candidate.seedSource === "semantic"
  ));
  assert.ok(semantic.candidates
    .filter((candidate) => candidate.kind === "semantic")
    .every((candidate) => candidate.exactMatch === false));
});

test("专业树校验拒绝同层歧义词和无依据关联边", () => {
  const ambiguousTree = structuredClone(rules.majorTree);
  ambiguousTree.nodes.push({
    id: "duplicate-journalism",
    parentId: "literature",
    label: "重复新闻传播",
    level: "category",
    aliases: ["新闻传播"],
    queryTerms: ["重复新闻传播"],
  });
  const ambiguous = validateMajorTree(ambiguousTree);
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.errors.some((error) => error.includes("同层专业词重复")));

  const unsupportedEdge = structuredClone(rules.majorTree);
  unsupportedEdge.relatedEdges.push({
    from: "computer",
    to: "civil-architecture",
    weight: 0.9,
    relation: "similar-sibling",
    reason: "",
  });
  const invalidEdge = validateMajorTree(unsupportedEdge);
  assert.equal(invalidEdge.ok, false);
  assert.ok(invalidEdge.errors.some((error) => error.includes("relation")));
  assert.ok(invalidEdge.errors.some((error) => error.includes("缺少 reason")));
});

test("扩充后的专业目录覆盖国央企常见专业方向", () => {
  assert.ok(rules.majorTree.nodes.length >= 150);
  for (const [major, expected] of [
    ["石油工程", "petroleum-engineering"],
    ["水利水电工程", "water-resources-engineering"],
    ["遥感科学与技术", "remote-sensing"],
    ["临床医学", "clinical-medicine"],
    ["行政管理", "administrative-management"],
    ["视觉传达设计", "visual-communication-design"],
  ]) {
    const beam = beamSearchMajorTree(major, rules.majorTree);
    assert.equal(beam.seedNodeIds[0], expected, major);
    assert.equal(beam.candidates[0].kind, "matched", major);
  }
});

test("专业不限由专业树根节点生成，而不是岗位关键词模拟", () => {
  const plan = createQueryPlan({
    education: "本科",
    major: "新闻传播学",
    locations: ["成都"],
    recruitTypes: ["校招"],
    acceptUnrestrictedMajor: true,
    maxQueries: 30,
  }, rules);
  const unrestricted = plan.queries.find((query) =>
    query.stage === "unrestricted-major"
  );

  assert.ok(unrestricted);
  assert.equal(unrestricted.filters.major, "专业不限");
  assert.equal(unrestricted.filters.keyword, undefined);
  assert.equal(unrestricted.majorCandidate.nodeId, "any-major");
});

test("查询预算严格限制计划长度", () => {
  const plan = createQueryPlan({
    education: "本科",
    major: "计算机科学与技术",
    locations: ["四川"],
    sectors: ["科技", "通信"],
    recruitTypes: ["校招", "实习"],
    maxQueries: 7,
  }, rules);

  assert.equal(plan.queries.length, 7);
  assert.equal(plan.truncated, true);
  assert.ok(plan.totalCandidateQueries > plan.queries.length);
  assert.ok(plan.warnings.some((warning) => warning.includes("maxQueries=7")));
});

test("未知画像字段不会进入持久化画像", () => {
  const plan = createQueryPlan({
    education: "本科",
    major: "法学",
    locations: ["北京"],
    phone: "13800000000",
    resume: "不应进入运行记录",
    maxQueries: 5,
  }, rules);

  assert.equal("phone" in plan.profile, false);
  assert.equal("resume" in plan.profile, false);
  assert.ok(plan.warnings.some((warning) => warning.includes("phone")));
  assert.ok(plan.warnings.some((warning) => warning.includes("resume")));
});

test("AI 可以自主选择查询组合，但代码校验参数和预算", () => {
  const baseline = createQueryPlan({
    education: "本科",
    major: "新闻传播",
    locations: ["四川"],
    sectors: ["传媒"],
    recruitTypes: ["校招"],
    maxQueries: 6,
  }, rules);
  const strategy = createAiQueryPlan({
    schema: "guoyang-search-strategy/v1",
    objective: "验证成都的品牌内容岗位，并补查具体企业",
    reasoning: "岗位标题不一定出现专业名。",
    hypotheses: ["品牌岗可能比新闻岗更多"],
    stopCondition: "两类命名均已验证",
    queries: [
      {
        id: "brand-chengdu",
        stage: "hypothesis-test",
        purpose: "验证品牌岗位命名",
        limit: 12,
        scanLimit: 800,
        filters: {
          location: "成都",
          sector: "科技",
          recruitType: "校招",
          keyword: "品牌",
        },
      },
      {
        id: "enterprise-focus",
        stage: "target-enterprise",
        purpose: "补查目标企业所有相关岗位",
        filters: {
          enterprise: "中国移动",
          location: "成都",
          keyword: "内容",
        },
      },
    ],
  }, baseline, rules);

  assert.equal(strategy.planningMode, "ai-directed");
  assert.equal(strategy.queries.length, 2);
  assert.equal(strategy.queries[0].filters.sector, "科技数字");
  assert.equal(strategy.queries[0].limit, 12);
  assert.equal(strategy.queries[0].scanLimit, 800);
  assert.deepEqual(
    strategy.queries[0].args.slice(-4),
    ["--limit", "12", "--scan-limit", "800"],
  );
  assert.ok(strategy.queries[1].args.includes("--enterprise"));
  assert.deepEqual(strategy.policy.minimumRequiredStages, []);
  assert.equal(strategy.policy.stopAtStageBoundary, false);

  assert.throws(() => createAiQueryPlan({
    schema: "guoyang-search-strategy/v1",
    objective: "非法行业测试",
    queries: [{
      purpose: "验证非法行业被拒绝",
      filters: { sector: "宇宙产业" },
    }],
  }, baseline, rules), /未知行业/u);

  assert.throws(() => createAiQueryPlan({
    schema: "guoyang-search-strategy/v1",
    objective: "非法阶段测试",
    queries: [{
      stage: "../escape",
      purpose: "验证路径型阶段被拒绝",
      filters: { location: "成都" },
    }],
  }, baseline, rules), /stage/u);
});
