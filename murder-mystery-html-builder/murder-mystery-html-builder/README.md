# 剧本杀 PDF → 离线多角色 HTML Skill

这是一个可分享、可安装的 Codex/Agent Skill。它把本地剧本杀 PDF、角色本、线索卡和流程手册整理为纯离线 HTML，并把结构判断与页面生成分开：先建立 `project.json`，再由脚本确定性地生成和审计结果。

## 核心原则

| 原则 | 实际约束 |
|---|---|
| 不剧透 | 默认使用 `participant-safe`；只报告文件、页数、角色/幕次/线索数量、歧义和验证结果 |
| 页面优先 | 优先按 PDF 页面或局部截图切分；不默认全文 OCR，不把全文抄进 HTML |
| 角色隔离 | 单文件模式做界面级隔离；需要物理隔离时使用 `split`，未解锁内容不会进入该角色文件 |
| 幕次隔离 | 每个角色按 `stages` 顺序解锁，不能通过普通导航跳过锁定幕次 |
| 线索独立 | 线索使用 `clueGroups`，与角色本分开；可按轮次解锁 |
| 纯离线 | 结果不依赖服务器、账号、CDN、在线字体或外部资源，可通过 `file://` 直接打开 |
| 无主持人 | 把准备、推进、发放线索、结算步骤写成分阶段 `manualSteps`，由页面引导玩家共同推进 |

## 推荐目录结构

```text
murder-mystery-html-builder/
├─ SKILL.md
├─ README.md
├─ requirements.txt
├─ agents/
│  └─ openai.yaml
├─ assets/
│  ├─ interactive-shell.html
│  └─ progress.js
├─ references/
│  ├─ discovery-guide.md
│  ├─ manifest-schema.md
│  └─ qa-checklist.md
├─ scripts/
│  ├─ inspect_sources.py
│  ├─ build_interactive.py
│  └─ validate_output.py
└─ examples/
   └─ project.minimal.json
```

实际剧本源文件不要放进 Skill 文件夹。建议另建工作目录：

```text
my-game/
├─ source/
│  ├─ roles/
│  │  ├─ role-a.pdf
│  │  └─ role-b.pdf
│  ├─ clues/
│  │  └─ round-1.pdf
│  └─ guide.pdf
├─ project.json
└─ output/
```

## 安装

1. 解压后保留顶层目录名 `murder-mystery-html-builder`。
2. 把整个目录复制到你的 Skill 目录。例如：
   - Codex：`~/.codex/skills/murder-mystery-html-builder/`
   - 跨运行时目录：`~/.agents/skills/murder-mystery-html-builder/`
   - Claude Code：`~/.claude/skills/murder-mystery-html-builder/`
3. 开启一个新会话，并说：`Use $murder-mystery-html-builder ...`。

运行脚本需要 Python 3.10+、Pillow、pypdf，以及能在命令行找到的 Poppler `pdftoppm`：

```powershell
python -m pip install -r requirements.txt
pdftoppm -v
```

在 Codex 桌面版中，PDF/图片运行环境通常已随工作区依赖提供；若脚本提示找不到 `pdftoppm`，请先加载 PDF 工作区运行环境或安装 Poppler。

## 最小使用示例

假设 `my-game/source/` 按上面的结构放好文件：

```powershell
# 1. 只做结构盘点，不全文 OCR
python scripts/inspect_sources.py "C:\path\to\my-game\source" --output "C:\path\to\my-game\inventory.json"

# 2. 复制并修改示例清单；只填写角色、幕次、线索和页码边界
Copy-Item examples/project.minimal.json "C:\path\to\my-game\project.json"

# 3. 生成一个纯离线 HTML
python scripts/build_interactive.py "C:\path\to\my-game\source" "C:\path\to\my-game\project.json" "C:\path\to\my-game\output\game.html"

# 4. 审计外部依赖、媒体数量与结构
python scripts/validate_output.py "C:\path\to\my-game\output\game.html"
```

最后双击 `game.html` 即可离线运行。若要更强的防剧透隔离，把清单中的 `mode` 改为 `split`，并把输出参数改为空目录；生成器会创建入口页和相互分离的角色/幕次/线索/流程页面。

默认盘点只记录文件结构、页数和页面尺寸，不读取 PDF 页面文字层或目录/书签文本。只有不参与游戏的组织者明确需要目录与文字候选时，才可额外传入 `--include-text-candidates`。

## 模式选择

| 模式 | 适合场景 | 隔离强度 |
|---|---|---|
| `guided-single` | 手机分享、一个文件、带进度和顺序解锁 | 界面级；全部资源仍在同一文件中 |
| `open-single` | 所有人可自由查看全部内容 | 不做防剧透隔离 |
| `split` | 分角色发送、未解锁内容不能出现在同一文件中 | 文件级，最强 |

## 清单就是配置

本包不引入第二套配置格式。`project.json` 同时是内容 manifest 和构建 config，字段定义见 `references/manifest-schema.md`。示例 `examples/project.minimal.json` 演示了两名角色、两幕、独立线索和无主持人流程。

## 使用边界

- 文件名或页码边界有两种合理解释时，应停止生成并只询问一个结构问题，不根据剧情猜测。
- CSS 隐藏不等于物理隔离；强防剧透需求必须选 `split`。
- 本工具不绕过 PDF 密码、DRM 或版权限制。只处理你有权转换和分享的材料。
- 最终交付前必须运行 `validate_output.py`；审计失败时不要把结果描述为已完成。
