# Business Parity Roadmap Design

> **For agentic workers:** This design is executed one phase at a time. Each phase must pass its own tests and differential probe before the next phase begins.

**Goal:** 将当前城市招聘复刻从协议字段兼容推进到可验证的业务闭环：响应模型、未知问题转换、激活规则、SQLite 调度、Dify provider、消息事件重试和逐步 parity 验证。

**Architecture:** 保留现有 Fastify + SQLite + 原始 Vue 静态资源架构，在 HTTP handler 与数据库之间增加明确的 response serializer、领域服务和任务执行边界。外部 Agent 通过 `DifyProvider` 接口隔离，调度通过 SQLite 任务表隔离，未来可以替换为 Redis/Celery，而不改变业务服务接口。每个阶段单独测试并运行目标站与本地的已脱敏 parity probe。

**Tech Stack:** Node.js 22、TypeScript、Fastify 5、`node:sqlite`、Vitest、现有 REA/parity 脚本；新增功能优先使用 Node 内置能力，不引入必须的外部服务。

## Global Constraints

- 目标 API 前缀继续使用 `/api/v1`。
- 目标站密码、JWT、Cookie、Authorization、Dify 密钥和个人数据不写入仓库或证据文件。
- 真实目标站只做读取和观察；所有写操作只在本地 SQLite 验证。
- 每个阶段先写失败测试，再实现最小完整闭环。
- 每个阶段结束时必须运行 `npm test`、`npm run build` 和对应 parity probe。
- 目标站真实数据和本地虚构种子数据分开处理；数量差异不能伪装成字段 parity。
- 外部依赖不可用时必须有明确的状态、错误和重试记录。

## Phase 1: Response Serializers

**Purpose:** 消除数据库内部字段泄漏和 12 个已登录响应差异中可由代码修复的字段差异。

**Public models:**

- `city`: 只输出目标页面需要的城市字段和稳定时间字段。
- `factory`: 输出目标工厂字段，隐藏 `data_json`。
- `servicePosition`: 显式输出 `base_sections`、`interview_days`、`interview_points`、`is_featured`，保证数组和数字类型稳定。
- `recruiter`: 显式输出 `recruiter_id`、`name`、`description`、`llm_config`、`sort_order`、`cities`。
- `candidate`: 输出目标字段，隐藏本地 `data_json` 和 `updated_at`，补齐 `wechat_id`。
- `agentDevice`: 输出目标实测的配置类型：`config.timeout` 是含 `enabled`、`interval_seconds`、`max_count`、`scripts` 的对象，`queue_stale` 是字符串；`last_online`、`last_offline` 保留字符串形式。
- `cityLinks`: 输出目标的城市字典和 links 结构。
- `evaluationOverview`、`metrics`、`statusDashboard`: 输出稳定数组和状态分布键。

**Boundary:** 所有 serializer 是纯函数，不读数据库、不改变状态；路由负责查询，serializer 负责公开响应形状。目标站自身 504 的 `/settings/sync` 和真实数据数量差异保留为证据中的外部/数据差异。

**Acceptance:** serializer 单元测试覆盖字段白名单、别名、空值和数组类型；customer parity 中除数据数量差异和目标站自身 504 外，不再出现可由响应模型修复的字段差异。

## Phase 2: Unknown Question Conversion

**Purpose:** 让未知问题可以转换成知识库条目并完成状态闭环。

**Flow:** 前端将已转换问题标为 `resolved`，内部迁移状态为 `pending -> resolved`；在同一 SQLite 事务中插入 `knowledge_items`，写入 question/answer/keywords/sort_order，并记录 `converted_knowledge_id` 和 `converted_at`。关联元数据不暴露为未知问题的公开存储字段。

**Rules:** 已转换的问题重复转换返回目标兼容的冲突错误；不存在的问题返回 404；缺少 answer 返回 422；转换失败事务回滚。

**Acceptance:** API、数据库、知识库列表和原问题详情四段式测试通过；浏览器从未知问题点击转换后能在知识库页面读到新条目。

**Implementation evidence (2026-10-23):** Migration `006_unknown_question_conversion.sql` stores the knowledge link and conversion time. The route uses one SQLite transaction, emits the UI-observed `resolved` state, and returns 404/409/422 for missing, repeated, or invalid conversions. Four endpoint tests cover success, visibility, conflict, validation and rollback; the local browser workflow was verified. Full suite: 45/45 tests; build passed. Post-Phase-2 read-only parity: 61 GETs, 48 verified, 13 data-dependent, 0 partial, 0 target-internal failures. Phase 3 has not started.

## Phase 3: Activation Rule Engine

**Purpose:** 用可测试规则替换 `matched: false` 占位。

**Rules:**

- `no_reply`: 最近客户消息后超过沉默阈值且没有新回复。
- `date_trigger`: 面试/岗位日期进入策略窗口。
- `misjudge`: 会话被标记为不符合但存在可恢复条件。
- `paused`: 客户处于暂停状态且达到重新触达日期。

规则输出统一为 `{matched, reason, strategy, next_push_at, eligible}`。规则只读输入快照；生成激活记录由独立 service 负责。

**Acceptance:** 每条规则有边界测试，策略测试接口返回真实匹配结果；激活名单由同一规则 engine 生成，避免 dashboard 和写接口各自实现一套条件。

**Implementation evidence (2026-10-23):** `activation.rules.ts` evaluates all four strategies from a read-only snapshot and applies enabled/global-pause/cooldown gates. Migration 007 persists strategy code configuration. The strategy save/test routes share the evaluator, and the UI preview displays a human-readable evidence summary. Ten rule/API tests pass; full suite is 55/55 with build passing. Phase 3 read-only parity is 48 verified, 13 data-dependent, 0 partial and 0 target-internal failures. Phase 4 has not started.

## Phase 4: SQLite Scheduler

**Purpose:** 先在本地跑通任务生成、领取、重试和完成，再保留 Redis/Celery 适配点。

**Tables:** `jobs`、`job_attempts`、`job_locks`，任务包含 kind、payload、status、run_at、attempts、last_error、locked_until、completed_at。

**Interfaces:** `JobStore` 负责 SQLite 持久化，`Scheduler` 负责轮询、领取、执行、退避和完成，`JobExecutor` 按任务类型分发。

**Acceptance:** 任务不会重复领取；失败按指数退避；超过最大次数进入 dead-letter 状态；进程重启后未完成任务可恢复；用 fake clock 测试而不是等待真实时间。

**Implementation evidence (2026-10-24):** Migration 008 adds `jobs`, `job_attempts`, and `job_locks`. `JobStore` and `Scheduler` implement transactional claim/reclaim/success/retry/dead-letter flows with injectable Clock, and `JobExecutor` provides typed kind dispatch. Eight focused scheduler/database tests pass. The core scheduler is verified; activation scan and message-send handlers are intentionally not wired yet.

## Phase 5: DifyProvider

**Purpose:** 把外部 Agent 调用从业务逻辑中隔离。

**Interfaces:** `DifyProvider.sendMessage(input)`、`healthCheck()`，返回统一的 success/message_id/error 结果。

**Providers:** `MockDifyProvider` 用于测试和本地默认运行；`HttpDifyProvider` 使用 fetch、超时、非 2xx 处理和密钥从环境变量读取。业务层只依赖接口，不直接拼 HTTP 请求。

**Acceptance:** mock provider 能驱动消息任务；HTTP provider 覆盖成功、超时、4xx、5xx；密钥不出现在日志和证据中。

## Phase 6: Events, Retry, Webhook Logs

**Purpose:** 参考 SmartATS 的可追踪消息处理方式，记录事件、重试和 webhook。

**Tables:** `message_events`、`message_deliveries`、`webhook_logs`。

**Flow:** 收到/发送消息先落事件，再进入 delivery；provider 失败记录 attempt 和 error；webhook 原始正文只保留脱敏摘要和 hash，敏感字段不落盘。

**Acceptance:** 相同事件幂等；消息失败可重试；webhook 成功、重复、无效签名都有可查日志；dashboard 可读取失败计数。

## Phase 7: Differential Gate

**Purpose:** 每个已完成模块都用同一条目标站/本地路径验证。

**Probe output:** 只记录方法、路径、状态码、顶层字段、字段类型、数组形状和差异原因；动态 ID、时间和敏感值归一化。

**Acceptance:** 阶段报告明确写出 `verified`、`partial` 或 `unknown`；不使用“接口返回 200”替代业务验证；下一阶段只能在当前阶段门槛通过后开始。

## Phase Ordering

严格按 Phase 1 到 Phase 7 执行。Phase 1 未通过前不实现 Phase 2；Phase 2 未通过前不实现规则引擎，以此类推。每一阶段都保留独立测试和证据文件，便于下一位 Agent 继续工作。
