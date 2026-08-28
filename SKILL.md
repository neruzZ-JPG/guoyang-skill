---
name: guoyang-skill
description: 让 AI 使用 guoyang-pro CLI 自主提出检索假设、迭代查询、分析岗位并生成可验证且可与历史结果对比的 HTML 求职报告。适用于国央企岗位研究、择岗和周期性复查；不用于代投简历或把 AI 判断当作官方结论。
metadata:
  short-description: AI 自主检索与国央企岗位分析报告
---

# 国央企岗位检索与规划

用 `@neruzz-jpg/guoyang-pro` 的真实结果完成岗位检索，不凭常识编造岗位。AI 是研究者和报告作者：提出检索假设、选择查询、根据结果迭代、判断岗位价值并撰写结论；脚本只负责提供候选扩展、执行与留痕、事实校验、历史比较和安全渲染。

## 先收集画像

在首次检索前补齐对结果有实质影响的信息：

- 学历、专业、院校层级；
- 意向地区（可多选）、行业（可多选）；
- 招聘类型（校招、社招或实习）；
- 岗位关键词与明确排除项；
- 对劳务派遣、异地工作等硬约束。

一次集中询问缺失项即可，不要求用户重复已经提供的信息。不要收集身份证号、手机号、账号密码或完整简历。把确认后的画像保存为 JSON；字段和示例见 [references/profile-and-expansion.md](references/profile-and-expansion.md)。

## 执行流程

1. 在输出目录写入 `profile.json`，保留用户原始表述。
2. 生成确定性基线计划，把它当作查询候选库而不是必须执行的清单：

   ```bash
   node scripts/build-query-plan.mjs --profile profile.json --out baseline-plan.json
   ```

3. 阅读画像和基线候选，重点查看 `resolved.majorBeam` 的专业节点、得分和路径，
   提出本轮检索目标、假设、查询组合与停止条件，写入 `strategy-round-1.json`。
   格式及判断方法见 [references/ai-research.md](references/ai-research.md)。AI 可以
   选择继续沿父级放宽、探索显式关联分支、创造基线中没有的合理组合、按企业检索或
   主动省略条件，但必须说明每条查询的用途。
4. 执行 AI 选定的查询并保留每次 CLI 原始结果：

   ```bash
   node scripts/run-search.mjs \
     --profile profile.json \
     --strategy strategy-round-1.json \
     --out run-1
   ```

   执行器会先调用 CLI 的 `help`、`version` 和静态来源清单，并查询相关企业名录、招聘时间线，再按计划逐条执行 `search`。不得跳过实际查询后直接写推荐。
   未提供 `--strategy` 时执行器默认拒绝运行；`--use-baseline` 仅用于调试确定性兜底。
5. 阅读 `run-1/run.json`，分析哪些查询有新增、哪些假设被支持、哪些覆盖不足。必要时写第二轮策略并用 `--previous-run` 合并证据。不要机械跑满预算；也不要仅因已有少量结果就过早停止。
6. 检索结束后，AI 阅读最终 `run.json`，为报告撰写 `analysis.json`：

   - 决定哪些岗位进入报告；
   - 自主进行“优先投递 / 可以尝试 / 继续观察”分档和排序；
   - 为每个岗位给出针对用户的理由、风险和下一步动作；
   - 总结市场观察、检索复盘、行动计划及值得继续验证的问题。

   分析必须引用已有 `stableKey`，不得修改岗位事实或虚构来源。正式报告默认设置 `unassessedPolicy: "error"`，逐项覆盖所有非硬排除岗位；详见 [references/ai-research.md](references/ai-research.md)。
7. 用 AI 分析生成用户 HTML 与旁路日志；如果有上次日志，传入
   `--previous-log`：

   ```bash
   node scripts/generate-report.mjs \
     --run run-2/run.json \
     --analysis analysis.json \
     --out guoyang-report.html \
     --previous-log previous-report.log.json
   ```

   不存在历史日志时省略 `--previous-log`。生成器自动写出
   `guoyang-report.log.json` 并调用验证逻辑；也可单独运行：

   ```bash
   node scripts/validate-report.mjs guoyang-report.html
   ```

8. 向用户只交付 HTML 岗位清单和简短结论。查询策略、覆盖状态、失败来源、历史
   差异和机器数据保留在 `.log.json` 中，不主动展示给用户。

## 查询与放宽原则

- 先形成可被结果证伪或支持的检索假设，例如“目标岗位更可能写作品牌而非新闻传播”，再选择能区分假设的查询。
- 专业树 Beam、城市、行业和岗位词扩展提供候选；AI 可以选用、重组、跳过或
  补充，不得把候选表当作必须穷举的固定流程。
- 不把同父节点视为相似专业。树边只表示分类包含与逐级放宽；跨专业只采用带权重和
  理由的显式关联边。可用向量相似度补充未知专业的起点召回，但向量结果不能直接
  证明资格兼容或触发兄弟节点扩展。
- 依据实际结果迭代：观察新增量、重复率、岗位命名、企业分布和来源覆盖，再决定收窄、扩展、换维度或停止。
- 查询计划有累计上限，避免无界搜索。每条新增查询必须有清楚目的，不能只是无意义地改写同义词。
- 每轮都使用 CLI 的 JSON 输出。保留 `mode`、`degraded`、`complete`、`scanned`、`sources` 和 `fetched_at`，不要把部分扫描写成全量结论。
- 某条查询失败时记录错误并继续安全的后续查询；所有岗位查询都失败时，不生成看似正常的推荐报告。
- CLI 返回零结果只表示当前来源和扫描窗口未命中，不等于全网没有岗位。
- AI 分档、`priority`、CLI 的 `fit_score` 和企业梯队均是择岗辅助，不代表官方评价、录取概率或 offer 保证。

## 报告与历史对比

输出必须符合 [references/report-contract.md](references/report-contract.md)：

- 用户 HTML 只包含分档岗位卡片、岗位事实、推荐理由、风险、下一步动作和投递入口；
- HTML 不展示画像、专业树、策略、查询轨迹、扫描覆盖、历史差异或机器 JSON；
- `.log.json` 保存完整策略、证据、AI 分析、来源、抓取时间和历史比较；
- 后续运行读取日志进行比较，不依赖解析用户 HTML。

“本轮未再检出”只代表当前查询没有返回该岗位。除非官方页面明确确认，否则不得写成“已下线”或“已关闭”。任何截止时间、资格条件和用工性质都提醒用户在官方投递页复核。

AI 可以从报告中隐藏低价值岗位，但必须通过 `include=false` 留下取舍记录。未提供 `analysis.json` 时脚本默认拒绝生成正式报告；只有调试时显式传 `--allow-fallback` 才启用代码兜底，且不得把兜底评分伪装成 AI 判断。

## 修改确定性规则

只有在用户需求或已验证样例表明候选库不足时才更新
`references/major-tree.json` 或 `references/expansions.json`。前者维护专业层级和
关联边，后者维护地区与行业等规则；它们不限制 AI 的全部检索空间。修改后运行
`npm test`，并检查：

- 相同画像重复生成完全相同的基线候选；
- 专业树无环、节点引用有效，Beam 宽度、深度和候选数均受限；
- AI 策略只能使用 CLI 支持的参数且不超过查询预算；
- 不支持的行业不会被伪装成 CLI 标准行业；
- 城市扩展仍属于用户选择的省级地区；
- AI 报告只能引用本轮已有岗位，不能改写事实；
- HTML 不暴露内部数据，旁路日志可解析、计数一致且链接协议安全。
