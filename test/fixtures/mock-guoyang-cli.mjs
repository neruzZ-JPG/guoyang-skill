#!/usr/bin/env node
const args = process.argv.slice(2);
const verb = args[0];

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

if (verb === "help") {
  console.log("mock guoyang-pro help: search --education --major --location --sector --type --keyword");
} else if (verb === "version") {
  console.log("0.2.0-mock");
} else if (verb === "sources" && args.includes("--static")) {
  console.log(JSON.stringify({
    total: 1,
    configured_live: 1,
    adapters: [{
      id: "mock",
      name: "Mock 招聘源",
      configured_live: true,
      coverage: "test-only",
    }],
  }));
} else if (verb === "enterprises") {
  console.log(JSON.stringify({
    total: 1,
    enterprises: [{
      id: "mock-enterprise",
      name: "示例国有传媒集团",
      short: "示例传媒",
      tier: "T2",
      sector: flag("sector") ?? "传媒文化",
      regulator: "local",
      hq: "成都",
      recruit_site: "https://example.com/jobs",
    }],
  }));
} else if (verb === "calendar") {
  console.log(JSON.stringify({
    total: 1,
    note: "mock calendar",
    entries: [{
      sector: flag("sector") ?? "传媒文化",
      recruit_type: flag("type") ?? "campus",
      window: "9月-11月",
      note: "典型招聘窗口，仅供参考",
      examples: ["示例国有传媒集团"],
    }],
  }));
} else if (verb === "search") {
  const major = flag("major") ?? "";
  const location = flag("location") ?? "成都";
  const keyword = flag("keyword") ?? "";
  const isExpanded = major.includes("新闻学") || keyword.includes("宣传");
  console.log(JSON.stringify({
    ok: true,
    total: 1,
    data: {
      mode: "live",
      fetched_at: "2026-08-28T04:00:00.000Z",
      degraded: false,
      complete: true,
      scanned: 12,
      sources: [{
        id: "mock",
        ok: true,
        count: 1,
        scanned: 12,
        exhausted: true,
        truncated: false,
        fetched_at: "2026-08-28T04:00:00.000Z",
      }],
      note: "mock complete",
    },
    positions: [{
      id: "mock:position-1",
      source_id: "mock",
      source_position_id: "position-1",
      enterprise_id: "mock-enterprise",
      enterprise_name: "示例国有传媒集团",
      title: isExpanded ? "品牌宣传岗" : "新闻宣传岗",
      tier: "T2",
      sector: "传媒文化",
      recruit_type: "campus",
      work_location: location,
      headcount: 5,
      education: "本科及以上",
      major: "新闻传播学类、中文类",
      employment_type: "在编/正式",
      deadline: "2026-12-31",
      apply_url: "https://example.com/jobs/position-1",
      source: "https://example.com/jobs/position-1",
      source_urls: ["https://example.com/jobs/position-1"],
      fetched_at: "2026-08-28T04:00:00.000Z",
      match_confidence: "exact"
    }]
  }));
} else {
  console.error(JSON.stringify({ ok: false, error: `unsupported mock command: ${args.join(" ")}` }));
  process.exitCode = 1;
}
