# 暗格 / Wisteria Online

一个面向多人剧本游戏的在线房间系统。玩家可以用用户名建立设备身份、加入房间、选择角色、调查地点、私藏线索，并把线索主动公开到全房间看板。

这个仓库是公开仓库。本文只记录公开安全的工程信息，不记录服务器地址、私钥路径、账号、原始剧本文件名、OCR 内容或任何剧情信息。

## 新会话先做这四件事

无论从家里电脑还是公司电脑开始，先运行：

```powershell
git status --short --branch
git log -3 --oneline --decorate
git pull --ff-only origin main
Get-Content -TotalCount 120 .\docs\DEVLOG.md
```

如果 `git status` 显示本地改动，先阅读和确认改动来源，不要直接清理、重置或覆盖。

随后让 Codex：

> 阅读 README.md、docs/DEVLOG.md 最新一条记录、当前 git status 和最近三条提交；用不超过十条要点说明当前状态、已验证内容、未完成事项和建议的唯一下一步。不要修改文件。

## 当前工程快照

- 技术栈：Next.js 16、React 19、TypeScript、Node.js 内置 SQLite。
- Node.js：`>=22.13.0`。
- 包管理器：pnpm，使用锁文件安装。
- 当前稳定基线：`97a76c6`（2026-08-28 推送到远端 `main`）。
- 运行时权限测试：7 项通过。
- 生产构建：通过。
- 当前产品阶段：阶段 3 已完成；通用宅邸氛围、透明紫藤和轻纹理已经生成、压缩并接入三端首页。
- 下一阶段：阶段 4，按既定信息架构改造房间大厅；继续保留现有创建、加入、退出和房间跳转行为。

会变化的进度以 [开发日志](docs/DEVLOG.md) 最新记录和 Git 历史为准，不要只相信本节里的提交号。

## 本地启动

```powershell
pnpm install --frozen-lockfile
pnpm run dev
```

默认开发地址由 Next.js 输出。首次运行会在仓库下创建被忽略的 `.data/`，其中包含本机开发数据库。

常用验证：

```powershell
pnpm run lint
pnpm run test:runtime
pnpm run build
```

剧本包安装属于单独的私密流程。不要为了让页面出现内容而自行复制原始剧本、扫描件或 bundle 到仓库或 `public/`。

## 页面与模块地图

| 路径 | 职责 |
| --- | --- |
| `app/page.tsx` | 品牌首页、玩家身份入口、玩法和公开看板预览 |
| `app/rooms/page.tsx` | 创建房间、加入房间、玩家已有房间 |
| `app/rooms/[code]/page.tsx` | 角色选择、角色内容、搜证、线索、阶段推进与玩家列表 |
| `app/api/auth/` | 用户名设备身份、会话与退出 |
| `app/api/rooms/` | 房间、角色、搜证、发牌、公开线索和阶段变更接口 |
| `lib/auth.ts` | 会话 Cookie 和当前用户 |
| `lib/identity.ts` | 用户名与设备凭据绑定 |
| `lib/rooms.ts` | 房间状态和需要事务保护的游戏操作 |
| `lib/blind-runtime.ts` | 根据当前身份与阶段生成最小授权投影 |
| `lib/packs.ts` | 校验并读取冻结剧本、运行策略和受保护内容源 |
| `lib/investigation/` | 解析并执行按版本绑定的服务端运行策略 |
| `lib/render-manifest.ts` | 校验按版本绑定的私有页面渲染清单 |
| `lib/db.ts` | SQLite 路径、表结构和连接 |
| `scripts/` | 剧本包安装、数据库备份和运行时测试 |
| `deploy/` | systemd、Nginx 和备份配置模板 |

## 核心玩家路径

1. 输入用户名，在当前设备建立玩家身份。
2. 创建房间或凭六位房间码加入。
3. 房主锁定一个已经验证、冻结的剧本版本。
4. 每位玩家选择唯一角色。
5. 房主开局并推进阶段。
6. 玩家调查地点，获得只对自己可见的线索。
7. 玩家主动公开线索后，它才进入全房间公开看板。

## 视觉改版方向

主题暂定为“紫藤深宅”：豪门宅邸、温室、紫藤、旧金属、丝绒和象牙纸，整体以深茄紫、灰紫、旧金和墨黑为主。

响应式不是简单缩放：

- 电脑：游戏状态、当前任务、公开看板可形成三栏。
- Pad：双栏主体，公开看板使用抽屉或可切换侧栏。
- 手机：单栏内容，并提供“当前阶段 / 我的角色 / 私藏 / 公开看板”底部导航。

原创位图只用于氛围主图、透明紫藤装饰和轻量纹理。图标、边框和简单纹样优先使用 CSS 或 SVG。所有公开美术必须是通用氛围素材，不得包含真实角色、线索、凶案物件或剧情暗示。

阶段 1 的长期设计资料：

- [视觉规范](docs/DESIGN_SYSTEM.md)：色彩、排版、组件语义、响应式和可访问性基线。
- [信息架构与线框](docs/WIREFRAMES.md)：首页、大厅、游戏房间的电脑 / Pad / 手机布局与关键交互。
- [原创视觉资产](docs/ART_ASSETS.md)：阶段 3 交付文件、生成方式、最终 Prompt 与复核要求。

交互式审稿板属于 Codex 会话视觉，不提交到公开仓库；跨电脑继续工作时以上述两份文档为准。

## 无剧透与数据边界

这些要求优先于视觉便利和调试效率：

- 原始剧本、扫描件、OCR、完整 bundle 和剧情派生物不得进入 Git、`public/`、静态构建、浏览器缓存、日志或截图。
- `.data/` 和 `WISTERIA_DATA_DIR` 是私密可变状态，不通过 Git 在电脑之间同步。
- 玩家只能收到服务端根据当前身份、房间、角色、阶段和线索持有状态生成的投影。
- 私藏线索在可靠的公开事件提交前，只能被持有者看到。
- 线索正反面必须通过稳定 ID 和验证证据绑定，不能依赖文件名或数组顺序。
- 未授权对象和不存在对象应保持不可区分的响应。
- 受保护响应保持 `Cache-Control: private, no-store`。
- 部署与剧本包安装是两个独立授权步骤。

原始资料处理、内容复核和发布前权限矩阵必须在仓库外的受控私密流程中完成；公开仓库不内置或复制内容处理技能，也不保存其私有产物。

## 每包运行策略与本地安装

应用代码只提供通用房间能力。每个冻结版本的 canonical bundle、runtime policy 与 render manifest 都保存在服务端私有数据区，剧本专属规则、原始内容和渲染页不进入源码、静态资源或浏览器包。

- 已安装版本必须在追加式注册表中绑定明确的运行配置。新安装使用经过验证的私有 sidecar；既有版本只有被明确登记时才允许使用 canonical 或兼容模式，不根据 bundle 内容猜测或自动回退。
- sidecar 使用版本化、可确定序列化的结构，并同时绑定冻结版本、canonical payload hash、自身语义 hash 和安装文件字节 hash。结构错误、未知 kind / version、引用越界或任一绑定不一致都会拒绝加载。
- render manifest 只登记 canonical 图片内容实际引用的页面，并绑定每个私有 WebP 的固定路径、尺寸、字节数和哈希。缺页、多页、错尺寸、替换文件或目录越界都会拒绝安装或读取。
- runtime policy 是 canonical 权限的收窄层，不是第二套授权来源。实际可执行动作、可见对象和可读内容始终取 canonical 投影与运行策略限制的交集。
- 受保护请求每次都由服务端根据当前房间、版本、阶段、成员、角色、持有状态、公开账本和授权版本重新计算。状态变更在事务内复核这些条件，并拒绝过期或不完整的请求。

本地安装只接受仓库外新建、已经通过 canonical 校验的私有运行根目录。先生成并验证与冻结 bundle 绑定的 runtime policy 证明，再执行追加安装：

```powershell
pnpm run validate:runtime-policy -- --run-root PRIVATE_RUN_ROOT --canonical-validator-python ABSOLUTE_PYTHON_EXECUTABLE --canonical-validator-script ABSOLUTE_VALIDATE_BUNDLE_SCRIPT
pnpm run test:runtime-policy
pnpm run install:pack -- --run-root PRIVATE_RUN_ROOT --data-dir LOCAL_DATA_DIR --label SAFE_PUBLIC_LABEL --canonical-validator-python ABSOLUTE_PYTHON_EXECUTABLE --canonical-validator-script ABSOLUTE_VALIDATE_BUNDLE_SCRIPT
pnpm run test:runtime
```

两个入口都会使用显式指定的受信 Python 与校验脚本，独立执行一次现有 canonical 产物的完整复验；二者必须是私有运行根和安装数据根之外的绝对普通文件路径。证明只绑定校验脚本的字节哈希，不记录解释器或脚本的本机路径。

校验器和安装器只应输出固定状态码；失败时不得改写已有版本。安装成功也不代表已经发布，生产部署与实际包多身份权限矩阵仍是独立关卡。

## 跨电脑协作规则

- 每次开始前先拉取远端并查看日志；不要凭聊天记忆猜当前状态。
- 每次结束前运行与改动相称的验证，并在 `docs/DEVLOG.md` 顶部追加一条记录。
- README 只放长期稳定的架构、规则和启动方式；阶段性事实放 DEVLOG。
- 不在公开文档中记录公网 IP、SSH 用户、私钥位置、口令、真实主机目录或公司内部信息。
- 不提交 `.env*`、`*.pem`、`.data/`、`murderScripts/`、构建目录或依赖目录。
- 如果两台电脑都有未提交改动，先分别保存和比较，不通过强制重置解决冲突。

## Codex 推理档位建议

- `high`：默认档。适合单个页面、组件、样式、普通测试和小范围修复。
- `max`：用于重要架构决策、复杂房间状态、权限审计、数据库并发和最终质量检查。
- `ultra`：用于能明确拆成多个独立工作流的任务，例如同时审查视觉、响应式、测试与安全。它更接近多智能体并行，不是每次都需要开启的“更强 max”。

本项目建议日常使用 `high`；每个大阶段第一次落地和最终收口使用 `max`；只有整站并行审计或明确要求多智能体时使用 `ultra`。

官方参考：[OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)。

## 开发日志维护方法

`docs/DEVLOG.md` 采用“最新记录在最上方”的方式：

1. 不重写旧记录。
2. 每次有可交接的代码、设计决策、验证结果或阻塞时新增一条。
3. 记录起止提交、修改范围、实际运行的检查、遗留风险和唯一下一步。
4. 没有运行的检查必须明确写“未运行”。
5. 不记录秘密、剧情语义或本机敏感信息。
