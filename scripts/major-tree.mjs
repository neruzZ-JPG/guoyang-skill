import { readFile } from "node:fs/promises";

const DEFAULT_CONFIG = {
  beamWidth: 8,
  maxDepth: 5,
  maxCandidates: 24,
  minimumSeedScore: 0.58,
  semanticWeight: 0.8,
};

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[（）()【】[\]、,，.。\s/_-]/gu, "")
    .replace(/专业$/u, "")
    .trim();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function bigrams(value) {
  const chars = [...value];
  if (chars.length < 2) return chars;
  return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
}

function diceSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) return 0;
  const remaining = new Map();
  for (const token of rightBigrams) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  }
  let intersection = 0;
  for (const token of leftBigrams) {
    const count = remaining.get(token) ?? 0;
    if (count <= 0) continue;
    intersection += 1;
    remaining.set(token, count - 1);
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function lexicalScore(query, term) {
  const q = normalize(query);
  const t = normalize(term);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const shortest = Math.min(q.length, t.length);
  const longest = Math.max(q.length, t.length);
  if (shortest >= 2 && (q.includes(t) || t.includes(q))) {
    return 0.7 + 0.22 * (shortest / longest);
  }
  return diceSimilarity(q, t) * 0.78;
}

function nodeTerms(node) {
  return uniqueStrings([node.label, ...(node.aliases ?? []), ...(node.queryTerms ?? [])]);
}

function compareState(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.depth !== right.depth) return left.depth - right.depth;
  return left.nodeId.localeCompare(right.nodeId);
}

function candidateKind(state, rootId) {
  if (state.nodeId === rootId) return "unrestricted";
  if (state.depth === 0) {
    if (state.exactMatch) return "matched";
    return state.seedSource === "semantic" ? "semantic" : "fuzzy";
  }
  const relations = state.transitions.map((item) => item.type);
  if (relations.every((type) => type === "parent")) return "ancestor";
  if (relations.every((type) => type === "child")) return "descendant";
  if (relations.includes("related")) return "related";
  return "adjacent";
}

export function validateMajorTree(tree) {
  const errors = [];
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    return { ok: false, errors: ["专业树必须是 JSON 对象"] };
  }
  if (!tree.version) errors.push("缺少 version");
  if (!tree.rootId) errors.push("缺少 rootId");
  if (tree.policy?.siblingTraversal !== false) {
    errors.push("policy.siblingTraversal 必须显式为 false");
  }
  if (!Array.isArray(tree.nodes) || tree.nodes.length === 0) {
    errors.push("nodes 必须是非空数组");
    return { ok: false, errors };
  }

  const ids = new Set();
  const termOwnersByLevel = new Map();
  const allowedLevels = new Set([
    "root",
    "broad",
    "discipline",
    "category",
    "major-group",
    "major",
  ]);
  for (const [index, node] of tree.nodes.entries()) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`nodes[${index}] 必须是对象`);
      continue;
    }
    if (!node.id || !/^[a-z0-9-]+$/u.test(node.id)) {
      errors.push(`nodes[${index}].id 无效`);
    } else if (ids.has(node.id)) {
      errors.push(`节点 id 重复: ${node.id}`);
    } else {
      ids.add(node.id);
    }
    if (!String(node.label ?? "").trim()) errors.push(`nodes[${index}] 缺少 label`);
    if (!String(node.level ?? "").trim()) errors.push(`nodes[${index}] 缺少 level`);
    if (node.level && !allowedLevels.has(node.level)) {
      errors.push(`节点 ${node.id ?? index} 的 level 无效: ${node.level}`);
    }
    for (const field of ["aliases", "queryTerms", "roleKeywords", "relatedSectors"]) {
      if (node[field] !== undefined && !Array.isArray(node[field])) {
        errors.push(`节点 ${node.id ?? index} 的 ${field} 必须是数组`);
      }
    }
    if (node.id && node.level) {
      for (const term of nodeTerms(node)) {
        const normalizedTerm = normalize(term);
        if (!normalizedTerm) continue;
        const key = `${node.level}:${normalizedTerm}`;
        const owners = termOwnersByLevel.get(key) ?? new Set();
        owners.add(node.id);
        termOwnersByLevel.set(key, owners);
      }
    }
  }
  if (!ids.has(tree.rootId)) errors.push(`rootId 不存在: ${tree.rootId}`);
  const root = tree.nodes.find((node) => node.id === tree.rootId);
  if (root?.level !== "root") errors.push("rootId 对应节点的 level 必须是 root");
  for (const [key, owners] of termOwnersByLevel) {
    if (owners.size > 1) {
      errors.push(`同层专业词重复: ${key} -> ${[...owners].join(",")}`);
    }
  }

  const parentById = new Map();
  for (const node of tree.nodes) {
    if (!node?.id) continue;
    if (node.id === tree.rootId && node.parentId) {
      errors.push("根节点不能有 parentId");
    }
    if (node.id !== tree.rootId && !node.parentId) {
      errors.push(`非根节点缺少 parentId: ${node.id}`);
    }
    if (node.parentId && !ids.has(node.parentId)) {
      errors.push(`节点 ${node.id} 的父节点不存在: ${node.parentId}`);
    }
    parentById.set(node.id, node.parentId);
  }

  for (const id of ids) {
    const visited = new Set();
    let cursor = id;
    while (cursor) {
      if (visited.has(cursor)) {
        errors.push(`专业树存在环: ${[...visited, cursor].join(" -> ")}`);
        break;
      }
      visited.add(cursor);
      cursor = parentById.get(cursor);
    }
    if (!visited.has(tree.rootId)) {
      errors.push(`节点 ${id} 无法追溯到根节点 ${tree.rootId}`);
    }
  }

  if (tree.relatedEdges !== undefined && !Array.isArray(tree.relatedEdges)) {
    errors.push("relatedEdges 必须是数组");
  }
  for (const [index, edge] of (tree.relatedEdges ?? []).entries()) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      errors.push(`relatedEdges[${index}] 引用了不存在的节点`);
    }
    if (edge.from === edge.to) errors.push(`relatedEdges[${index}] 不能自环`);
    if (!Number.isFinite(edge.weight) || edge.weight <= 0 || edge.weight > 1) {
      errors.push(`relatedEdges[${index}].weight 必须在 0-1`);
    }
    if (!["search-overlap", "skill-transfer"].includes(edge.relation)) {
      errors.push(
        `relatedEdges[${index}].relation 必须是 search-overlap 或 skill-transfer`,
      );
    }
    if (!String(edge.reason ?? "").trim()) {
      errors.push(`relatedEdges[${index}] 缺少 reason`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function loadMajorTree(path) {
  const tree = JSON.parse(await readFile(path, "utf8"));
  const validation = validateMajorTree(tree);
  if (!validation.ok) {
    throw new Error(`专业树格式无效: ${validation.errors.join("；")}`);
  }
  return tree;
}

function buildGraph(tree) {
  const nodeById = new Map(tree.nodes.map((node) => [node.id, node]));
  const childrenById = new Map(tree.nodes.map((node) => [node.id, []]));
  for (const node of tree.nodes) {
    if (node.parentId) childrenById.get(node.parentId)?.push(node.id);
  }
  const relatedById = new Map(tree.nodes.map((node) => [node.id, []]));
  for (const edge of tree.relatedEdges ?? []) {
    relatedById.get(edge.from)?.push(edge);
  }
  for (const children of childrenById.values()) children.sort();
  for (const edges of relatedById.values()) {
    edges.sort((left, right) =>
      right.weight - left.weight || left.to.localeCompare(right.to)
    );
  }
  return { nodeById, childrenById, relatedById };
}

function seedStates(
  input,
  tree,
  nodeById,
  minimumSeedScore,
  beamWidth,
  semanticScores,
  semanticWeight,
) {
  const scored = [];
  for (const node of tree.nodes) {
    if (node.id === tree.rootId) continue;
    let best = 0;
    let matchedTerm = "";
    let exactMatch = false;
    for (const term of nodeTerms(node)) {
      const score = lexicalScore(input, term);
      const exact = normalize(input) === normalize(term);
      if (score > best || (score === best && exact && !exactMatch)) {
        best = score;
        matchedTerm = term;
        exactMatch = exact;
      }
    }
    const semanticScore = Number(semanticScores?.[node.id] ?? 0);
    if (!Number.isFinite(semanticScore) || semanticScore < 0 || semanticScore > 1) {
      throw new Error(`semanticScores.${node.id} 必须在 0-1`);
    }
    const weightedSemanticScore = semanticScore * semanticWeight;
    const score = exactMatch ? 1 : Math.max(best, weightedSemanticScore);
    const seedSource = exactMatch
      ? "exact"
      : weightedSemanticScore > best
        ? "semantic"
        : "lexical";
    if (score >= minimumSeedScore) {
      scored.push({
        nodeId: node.id,
        score,
        depth: 0,
        path: [node.id],
        transitions: [],
        matchedTerm,
        exactMatch,
        seedSource,
        lexicalScore: best,
        semanticScore,
      });
    }
  }
  scored.sort(compareState);
  if (!scored.length) return [];
  const exact = scored.filter((state) => state.exactMatch);
  if (exact.length) {
    const specificity = {
      major: 6,
      "major-group": 5,
      category: 4,
      discipline: 3,
      broad: 2,
      root: 1,
    };
    const bestSpecificity = Math.max(
      ...exact.map((state) => specificity[nodeById.get(state.nodeId)?.level] ?? 0),
    );
    return exact
      .filter((state) =>
        (specificity[nodeById.get(state.nodeId)?.level] ?? 0) === bestSpecificity
      )
      .slice(0, beamWidth);
  }
  const bestScore = scored[0].score;
  return scored
    .filter((state) => state.score >= Math.max(minimumSeedScore, bestScore - 0.16))
    .slice(0, beamWidth)
    .filter((state) => nodeById.has(state.nodeId));
}

function expandState(state, graph, rootId) {
  const node = graph.nodeById.get(state.nodeId);
  const transitions = [];
  if (
    (!state.mode || state.mode === "up") &&
    node.parentId &&
    !state.path.includes(node.parentId)
  ) {
    transitions.push({
      to: node.parentId,
      type: "parent",
      mode: "up",
      factor: node.parentId === rootId ? 0.72 : 0.86,
      reason: "向上放宽专业口径",
    });
  }
  if ((!state.mode || state.mode === "down") && state.nodeId !== rootId) {
    for (const childId of graph.childrenById.get(state.nodeId) ?? []) {
      if (state.path.includes(childId)) continue;
      transitions.push({
        to: childId,
        type: "child",
        mode: "down",
        factor: 0.78,
        reason: "探索同一上位专业下的具体分支",
      });
    }
  }
  for (const edge of graph.relatedById.get(state.nodeId) ?? []) {
    if (state.path.includes(edge.to)) continue;
    transitions.push({
      to: edge.to,
      type: "related",
      mode: "related",
      factor: edge.weight,
      reason: edge.reason,
      relation: edge.relation,
    });
  }
  return transitions.map((transition) => ({
    nodeId: transition.to,
    score: state.score * transition.factor,
    depth: state.depth + 1,
    path: [...state.path, transition.to],
    transitions: [...state.transitions, transition],
    matchedTerm: state.matchedTerm,
    exactMatch: state.exactMatch,
    seedSource: state.seedSource,
    lexicalScore: state.lexicalScore,
    semanticScore: state.semanticScore,
    mode: transition.mode,
  }));
}

function taxonomyPath(nodeId, nodeById) {
  const path = [];
  const visited = new Set();
  let cursor = nodeId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = nodeById.get(cursor);
    if (!node) break;
    path.unshift({ nodeId: node.id, label: node.label });
    cursor = node.parentId;
  }
  return path;
}

export function beamSearchMajorTree(input, tree, options = {}) {
  const validation = validateMajorTree(tree);
  if (!validation.ok) {
    throw new Error(`专业树格式无效: ${validation.errors.join("；")}`);
  }
  const config = {
    ...DEFAULT_CONFIG,
    ...(tree.defaults ?? {}),
    ...options,
  };
  for (const [name, min, max] of [
    ["beamWidth", 1, 64],
    ["maxDepth", 0, 12],
    ["maxCandidates", 1, 200],
  ]) {
    if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max) {
      throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
    }
  }
  if (
    !Number.isFinite(config.minimumSeedScore) ||
    config.minimumSeedScore < 0 ||
    config.minimumSeedScore > 1
  ) {
    throw new Error("minimumSeedScore 必须在 0-1");
  }
  if (
    !Number.isFinite(config.semanticWeight) ||
    config.semanticWeight < 0 ||
    config.semanticWeight > 1
  ) {
    throw new Error("semanticWeight 必须在 0-1");
  }

  const graph = buildGraph(tree);
  const semanticScores = options.semanticScores ?? {};
  if (!semanticScores || typeof semanticScores !== "object" || Array.isArray(semanticScores)) {
    throw new Error("semanticScores 必须是 nodeId 到 0-1 分数的对象");
  }
  for (const nodeId of Object.keys(semanticScores)) {
    if (!graph.nodeById.has(nodeId)) throw new Error(`semanticScores 包含未知节点: ${nodeId}`);
  }
  const seeds = seedStates(
    input,
    tree,
    graph.nodeById,
    config.minimumSeedScore,
    config.beamWidth,
    semanticScores,
    config.semanticWeight,
  );
  let frontier = seeds;
  const bestByNode = new Map();
  for (const state of frontier) bestByNode.set(state.nodeId, state);

  for (let depth = 0; depth < config.maxDepth && frontier.length; depth += 1) {
    const expanded = frontier.flatMap((state) => expandState(state, graph, tree.rootId));
    expanded.sort(compareState);
    const next = [];
    const nextIds = new Set();
    for (const state of expanded) {
      if (nextIds.has(state.nodeId)) continue;
      const previous = bestByNode.get(state.nodeId);
      if (previous && previous.score >= state.score) continue;
      bestByNode.set(state.nodeId, state);
      nextIds.add(state.nodeId);
      next.push(state);
      if (next.length >= config.beamWidth) break;
    }
    frontier = next;
  }

  const candidates = [...bestByNode.values()]
    .sort(compareState)
    .slice(0, config.maxCandidates)
    .map((state) => {
      const node = graph.nodeById.get(state.nodeId);
      return {
        nodeId: node.id,
        label: node.label,
        level: node.level,
        kind: candidateKind(state, tree.rootId),
        score: Number(state.score.toFixed(4)),
        distance: state.depth,
        matchedTerm: state.matchedTerm,
        exactMatch: state.exactMatch,
        seedSource: state.seedSource,
        lexicalScore: Number(state.lexicalScore.toFixed(4)),
        semanticScore: Number(state.semanticScore.toFixed(4)),
        queryTerms: uniqueStrings([node.label, ...(node.queryTerms ?? [])]),
        roleKeywords: uniqueStrings(node.roleKeywords ?? []),
        relatedSectors: uniqueStrings(node.relatedSectors ?? []),
        path: taxonomyPath(node.id, graph.nodeById),
        scanPath: state.path.map((id) => ({
          nodeId: id,
          label: graph.nodeById.get(id)?.label ?? id,
        })),
        transitions: state.transitions.map((transition) => ({
          type: transition.type,
          relation: transition.relation,
          reason: transition.reason,
        })),
      };
    });

  return {
    schema: "guoyang-major-beam/v1",
    treeVersion: tree.version,
    input: String(input ?? "").trim(),
    config: {
      beamWidth: config.beamWidth,
      maxDepth: config.maxDepth,
      maxCandidates: config.maxCandidates,
      minimumSeedScore: config.minimumSeedScore,
      semanticWeight: config.semanticWeight,
    },
    matched: candidates.some((candidate) => candidate.kind === "matched"),
    semanticRecallUsed: candidates.some((candidate) => candidate.seedSource === "semantic"),
    seedNodeIds: seeds.map((state) => state.nodeId),
    exactSeedNodeIds: seeds.filter((state) => state.exactMatch).map((state) => state.nodeId),
    candidates,
  };
}
