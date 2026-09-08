# 在线玩家项目入口

本项目的剧本杀在线流程开发与维护，先读
`C:\Users\admin\.codex\skills\murder-mystery-online\SKILL.md`，再按任务读取本地案例参考及相关项目文件。

- 最新范围以 `FLOW.md`、`ZITENG-FLOW.md`、`README.md` 和用户最新要求为准；凶手/答案投票已取消，不自动恢复。紫藤夫人的地点投票是独立的原生搜证机制，不混为答题投票。
- 各幕材料映射与在线搜证规则逐本核对，不把本项目固定人数、轮次、隐藏额度套给其他本子。
- 用户确认的跨本默认交互见在线 Skill：拿牌后立即选择隐藏/公开，选完交给下一人，轮末匿名统一发布；不能退回“全轮拿完才允许选择”。额度和特殊限制仍逐本核对。
- 用户存档在 `state/`，原始材料在 `private/`；测试用独立临时数据。学习、整理或局部文案任务不推进真实游戏。
- 正式部署使用代码目录外独立 `STATE_DIR`，不得复制本地测试账号或进度。正式模式默认关闭测试辅助并使用 HTTPS；用户已分别授权线上应邪、紫藤的全流程单人测试，对应 `YINGXIE_TEST_ASSIST=1`、`ZITENG_TEST_ASSIST=1`，不默认扩展给新本。配置与恢复见 `DEPLOYMENT.md`，检查入口 `check-deployment.mjs`；紫藤六角色和分支覆盖见 `check-ziteng-assist.mjs`。现有服务器还有其他服务，替换仅限 Wisteria 网站。
- 用户已明确要求这两个测试本提供一键测试辅助。仅在启用的测试模式下，由玩家点击代操作其他角色；不后台自动运行，不替点击者选择/确认，不自动触发回忆，不重置存档。辅助实现和测试分别见 `test-assist.mjs`、`check-test-assist.mjs`，不默认扩展给其他剧本。
- 现有测试入口为 `check.mjs`、`check-search.mjs`、`check-third.mjs`，按改动范围选择，不做无收益的全套重跑。
- 剧本入口由 `library-server.mjs` 分流：原应邪化仆接口与存档保持不变；紫藤在 `/ziteng/`，独立 `private/ziteng/` 与 `state/ziteng/`。新增联测入口 `check-ziteng.mjs`；初始牌背映射见 `ZITENG-SOURCE-FACES.md`。两本规则引擎分开，不做万能规则引擎。
