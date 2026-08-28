# guoyang-skill

## 功能

- 使用 `guoyang-pro` 查询真实的国央企企业、岗位与招聘时间线。
- 由 AI 根据求职画像自主规划和迭代检索。
- 使用覆盖 160 个节点的专业树和 Beam 扫描逐级扩展专业范围。
- 分析岗位匹配度、风险与投递价值，输出三档建议。
- 生成简洁的岗位清单 HTML，运行细节单独保存为日志。

## 安装与使用

从 GitHub 安装：

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo neruzZ-JPG/guoyang-skill \
  --path . \
  --name guoyang-skill \
  --ref main
```

安装完成后，在新的 Codex 对话中使用：

```text
使用 $guoyang-skill 帮我检索国央企岗位。
我的情况：本科，新闻传播学，211，2027 届；
优先成都，也接受重庆；偏好品牌、宣传和内容运营；
不接受劳务派遣。请自主检索并生成 HTML 报告。
```

需要 Node.js 18 或更高版本。首次查询可能需要授权访问网络。
