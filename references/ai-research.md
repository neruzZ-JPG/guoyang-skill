# AI 自主检索与报告分析

## 职责分界

代码负责：

- 校验 CLI 参数、查询数量和受支持枚举；
- 执行查询并保存原始响应；
- 生成稳定岗位键、去重、保留来源和覆盖状态；
- 计算历史事实变化、转义 HTML 并验证报告结构。

AI 负责：

- 根据用户画像提出检索假设；
- 选择、组合、排序和迭代查询，而不是机械执行全部候选；
- 阅读首轮结果后决定收窄、横向扩展、反证或停止；
- 判断岗位是否值得展示、如何分档以及理由；
- 撰写市场观察、策略复盘、行动建议和后续查询建议。

确定性扩展计划是候选库与兜底，不是 AI 必须照抄的清单。专业候选来自
`resolved.majorBeam`，每项包含匹配类型、得分、树路径和扫描路径；AI 应优先选择
路径短、得分高且符合用户目标的节点，再根据实际命中决定是否沿父级继续放宽或探索
显式关联分支。

不要因为两个节点拥有同一父节点就认定它们相似。父子边表示分类包含；只有
`relatedEdges` 才表示值得验证的跨专业方向。`search-overlap` 表示招聘专业口径
可能重叠，`skill-transfer` 表示能力可能迁移，两者都不是官方资格判断。

若运行环境提供 embedding，可先计算输入专业与节点文本的相似分数，再把分数作为
`semanticScores` 传给 Beam 扫描器。向量结果只用于补充起点召回，AI 必须明确说明
为何采用该候选，并通过真实岗位查询验证；不得因向量相似直接扩大到整组兄弟节点。

## 检索策略格式

AI 根据 `profile.json`、基线 `plan.json` 和已有运行结果编写：

```json
{
  "schema": "guoyang-search-strategy/v1",
  "objective": "优先寻找成都的新闻传播对口校招，同时验证科技央企的品牌内容岗位",
  "approach": "首轮先验证专业原文和职责词，再根据命中企业调整。",
  "hypotheses": [
    "岗位可能更常以宣传、品牌、内容运营命名，而不是新闻传播",
    "部分岗位会写专业不限，但职责与用户背景匹配"
  ],
  "stopCondition": "覆盖核心地点和两类岗位命名，且新增岗位明显递减",
  "iteration": 1,
  "queries": [
    {
      "id": "core-major-chengdu",
      "stage": "hypothesis-test",
      "purpose": "验证成都是否有直接限定新闻传播专业的岗位",
      "hypothesis": "专业字段存在直接命中",
      "limit": 20,
      "scanLimit": 1200,
      "filters": {
        "education": "本科",
        "major": "新闻传播",
        "location": "成都",
        "recruitType": "校招"
      }
    },
    {
      "id": "brand-role-tech",
      "stage": "adjacent-role",
      "purpose": "寻找科技数字行业中按职责命名的品牌岗位",
      "filters": {
        "location": "成都",
        "sector": "科技数字",
        "keyword": "品牌",
        "recruitType": "campus"
      }
    }
  ]
}
```

允许的 `filters`：

- `enterprise`
- `tier`
- `sector`
- `recruitType`
- `education`
- `major`
- `location`
- `employment`
- `keyword`

AI 可以省略某些条件以主动放宽，也可以组合未出现在基线计划中的合理查询。行业、招聘类型、梯队和用工性质仍须通过代码枚举校验。
每条查询还可单独设置 `limit`（1–100）和 `scanLimit`（100–5000），让 AI 根据假设价值与预期稀疏度分配扫描深度；不能超过总查询预算。
正式检索必须提供策略文件；只有调试或故障排查时才使用 `--use-baseline` 执行确定性候选计划。

## 迭代检索

推荐至少两轮：

1. **探索轮**：用少量差异明显的查询检验岗位命名、专业写法、地点和行业假设。
2. 阅读 `run.json` 中的岗位、失败源、覆盖状态、重复率和新增量。
3. **补充轮**：针对遗漏、异常或高价值方向编写新策略；不要只是换同义词重复查询。
4. 使用 `--previous-run` 合并前轮证据：

   ```bash
   node scripts/run-search.mjs \
     --profile profile.json \
     --strategy strategy-round-2.json \
     --previous-run run-1/run.json \
     --out run-2
   ```

是否继续由 AI 根据证据判断，但累计查询不得超过 `maxQueries`。说明停止理由；不要为了“跑满预算”执行低价值查询。
与前轮过滤条件完全相同的查询默认会被拒绝；若为了检查岗位状态变化确需重跑，应设置 `allowRepeat: true` 并在 `purpose` 中说明。

多轮合并后的 `run.json` 是累计证据集。使用这些字段区分当前轮与前轮：

- `execution.currentReturnedPositions`：当前轮各查询返回条数之和，包含重复；
- `execution.currentNewPositions`：当前轮首次加入累计证据集的岗位数；
- `execution.currentDistinctPositions`：当前轮至少再次出现过一次的去重岗位数；
- `position.discovery.seenInCurrentRound`：该岗位是否在当前轮被实际返回；
- `position.discovery.lastSeenIteration`：最近一次出现在哪轮 AI 策略。

前轮遗留且 `seenInCurrentRound=false` 的岗位仍可用于累计分析，但不能写成“本轮新命中”。

## 报告分析格式

阅读最终 `run.json` 后，为所有值得考虑的岗位编写分析：

```json
{
  "schema": "guoyang-report-analysis/v1",
  "unassessedPolicy": "error",
  "headline": "成都宣传类岗位有限，但品牌与内容运营方向出现可投机会",
  "executiveSummary": "本轮更有效的检索方式是按职责词而非专业名搜索……",
  "searchAssessment": "专业原文命中较少；品牌、宣传和新媒体查询贡献了主要新增岗位。",
  "marketObservations": [
    {
      "title": "岗位命名偏职责化",
      "body": "多个岗位未在标题中出现新闻传播，但职责涉及品牌与内容。",
      "evidenceKeys": ["iguopin:123", "ncss:456"]
    }
  ],
  "customSections": [
    {
      "title": "简历与作品准备",
      "paragraphs": ["这些岗位共同重视内容策划和跨部门沟通。"],
      "bullets": ["准备一份品牌传播案例", "量化内容运营成果"],
      "evidenceKeys": ["iguopin:123"]
    }
  ],
  "actionPlan": [
    "今天核验优先投递岗位的应届年份和专业目录",
    "为品牌宣传岗准备两份内容作品案例"
  ],
  "caveats": [
    "部分来源扫描未到底，报告不能代表全量岗位"
  ],
  "followUpQueries": [
    {
      "purpose": "补查成都央企子公司的融媒体岗位",
      "filters": {"location": "成都", "keyword": "融媒体"}
    }
  ],
  "positionAssessments": [
    {
      "stableKey": "iguopin:123",
      "include": true,
      "bucket": "priority",
      "priority": 88,
      "confidence": "medium",
      "reasons": ["职责与内容运营经历高度相关", "地点满足核心意向"],
      "risks": ["专业目录只写大类，需要向招聘方核验"],
      "nextAction": "先核验专业代码，确认后在 3 天内投递"
    },
    {
      "stableKey": "ncss:789",
      "include": false,
      "bucket": "observe",
      "priority": 20,
      "confidence": "high",
      "reasons": ["岗位方向偏销售"],
      "risks": ["与用户明确排除项冲突"],
      "nextAction": "不纳入本轮清单"
    }
  ]
}
```

约束：

- 只能引用 `run.json` 中存在的 `stableKey`，不得新增或改写岗位事实。
- `unassessedPolicy` 决定未逐项评估岗位的处理：正式报告默认用 `error` 强制完整评估；`exclude` 表示不展示；只有用户接受混合报告时才用 `fallback`。
- `bucket` 只能为 `priority`、`try`、`observe`。
- `priority` 为 0–100 的相对投递顺序，不是录取概率。
- `reasons`、`risks` 和正文可以体现综合判断，但事实陈述必须能由画像、岗位或查询元数据支持。
- `customSections` 允许 AI 自主增加比较、准备策略、企业选择等章节；其中的 `evidenceKeys` 同样必须来自本轮岗位。
- `include=false` 是报告取舍，不表示岗位关闭。
- 未提供 `analysis.json` 时，报告生成器默认拒绝生成正式报告；只有调试时显式传 `--allow-fallback` 才使用全代码兜底。
