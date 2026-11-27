# 0.3.5 架构和数据结构

## 0.3.5 遗留草稿与当前请求恢复

IndexedDB v7 增加 recovered_drafts 表，索引 id、discussionId、participantId、createdAt。RecoveredDraft 包含任务/成员/标签/地址、旧请求标记、完整内容、内容摘要、识别依据 saved_request 或 legacy_envelope、saved/cleared/changed/restored、尝试次数与时间。恢复副本进入快照与本任务 JSON 报告，清除本地数据时一起清除。

request-wire.ts 统一传输封套和历史格式识别。DraftRecovery 仅处理本任务专用页：完整旧请求可以与消息或大脑记录逐字匹配；记录已不存在时，要求完整历史协议前缀、各协议字段、唯一 64 位标记及尾部跟踪说明。legacy_envelope 只表示格式识别，不宣称找到了原所属记录。普通草稿不处理；所有被移动内容都先完整落库。页内 clear_draft 在变更前再次逐字比较，发现改动不替换，最多自动尝试三次。该操作不点击发送，也不触发 Enter。

restore_draft 只能显式从设置发起，拒绝运行中任务、未完成交付、已变化的地址或非空输入框，成功仅填回原文并记录日志。页面 DOM 操作保持 ISOLATED，不读取网页账号存储或网络私有接口。

重启/调度可为当前 foreground 的 DRAFT_PRESENT 初始任务重查，只有没有 sending/waiting/receipt 的当前任务通过准备后才恢复。USER_PAUSED、旧请求、无归属任务均不在此自动恢复范围。isCurrent 不再在存在前台请求时无条件放行 userRequestId 缺失的旧记录。

## 0.3.4 自动网站启动

PlatformAdapter 增加可选 prepareInitial(participant, discussionId)。DOM 适配器先绑定该任务专用页，实际检查输入与登录，经 SessionPreparer 确认或新建空白会话后允许初始尝试；不以既有回答为前置条件。initial 能力门只检查本任务的专用页，不借用其他标签的登录/回复状态。已有发送凭据时不会重置页面或重发。

CapabilityCheck.sessionPreparationAllowed 仅表示可尝试准备新会话，不能当成 canReadOutput、canDetectCompletion 或 unattendedAllowed。prepareInitial 结果仍按真实匹配记录这些能力。非配置首页且未观察到空白结构时，即使回复/用户选择器均为零，也进入自动新对话流程。SessionPreparer 另持久化 resetHadTranscript 与 preparedUrl，记录显式新建前有内容、随后清空的证据；网页地址不变也可确认准备完成，不依赖再次点击新建。

Discussion.startup 保存 startedAt/deadline/nextCheckAt/attempts/lastCode；QueueTask.preflightDeadline 保存发送前页面等待期限，大脑沿用其持久化 task 字段。页面加载、输入框延迟出现、切换新聊天等临时状态自动复查，默认 60 秒上限；SessionPreparer 切换上限仍为 30 秒。重启不把等待页一律变成暂停，也不重置 sending/waiting 凭据。数据字段可选，本版数据库仍为 v6。

site-access.ts 集中管理首次网站授权，只在点击/Enter 发起的 UI 动作中调用 Chrome permissions.request。后台只验证权限，不绕过浏览器授权。任务创建网页之前先检查 host access。任务准备可以激活自己的专用页促进页面渲染，用户手动只读检测保持被动；没有操作个人原标签的草稿。

## 0.3.3 侧边栏运行时

main.ts 首先导入 sidepanel/runtime/resize-observer.ts，随后才求值 App 和组件库；避免组件库在模块初始化时构造的共享 ResizeObserver 绕过逐帧批处理。每个目标只保留最新观察条目，批次在下个动画帧执行，unobserve/disconnect 清理待处理条目和帧；不安装全局错误过滤器。该模块仅用于侧边栏，不改变后台调度或模型网页。

ReportDialog.vue 使用浏览器原生 HTMLDialogElement.showModal/close：顶层模态、背景焦点隔离、Escape 和焦点返回由浏览器处理，显式可见关闭按钮拥有初始焦点；对外只有 show/markdown 和 update:show。没有禁用辅助技术、修改组件库源码或调用网页私有接口。本版数据库仍是 v6。

## 0.3.2 请求归属与点名聊天

IndexedDB v6 新增 runtime_state 表（主键 id，discussionId 索引），保存唯一 foreground 记录：requestId、discussionId?、brainRequestId?、updatedAt。Discussion 和 BrainRequest 增加可选 userRequestId。RequestCoordinator 在单个事务中暂停旧活动任务/路由并建立新请求；启动、路由应用、调度派发、重启恢复核对该归属。界面 selectedId 仅用于查看任务，不授权发送。手动创建且尚未绑定的任务兼容原有任务入口，明确启动时绑定归属。

v6 升级把旧活动讨论和路由置为 PAUSED/paused，保存恢复阶段和 UPGRADE_REVIEW_REQUIRED；不改写发送凭据、队列发送状态、消息或网页草稿。已发或结果未知的请求继续按原凭据核对，不能因新问题而重发。

mode=direct 的提示仅是本题 originalQuestion；跟踪标记由传输层附加。其收到的原始文本记为 RESPONSE / not_applicable，structuredData 不构造，待全部目标回复后完成并生成点名报告。mode=free 保持完整 JSON 讨论协议。旧 direct 队列只有在没有网页交付记录时才能把未发提示纠正为本题原话；已有交付记录时保留原文并阻止改写重发。

## 0.3.1 数据与恢复补充

数据库升级到 v5，保留旧任务与成员配置。v4 增加 chat_notices，v5 增加 brain_requests（索引 id、participantId、phase、createdAt、discussionId）。旧讨论补齐 free 模式和 independent_evidence 政策。新聊天可选择 discussion_only，设置随任务固化，报告分别披露讨论一致和事实核验。

BrainRequest 保存问题原话、提示、QueueTask 凭据、pending/sending/waiting/routing/done/paused/cancelled、恢复阶段、超时、原始回复、解析路由、关联任务 ID、纠错/确认/重试次数及错误。每次 tick 只推进一步；浏览器 worker 重建后从数据库继续。发送前保存 sending；未知结果最多五次只读核对。路由建任务和保存关联 ID 在同一事务内，重启不重复建题。

大脑会话使用 **brain**:请求作用域，与讨论页区分，每题隔离；修复同题协议仍用原作用域。只复用已经结束且无未完成交付的专用页。既有完整回复可经适配器 cachedResponse 在本地继续入库，无需伪造网页就绪。

ResponseProcessor 独立提交其原子事务，调度器之后持久化队列确认；中间重启利用 parseStatus 幂等继续。协议校验失败保存 parseError，数据库故障继续抛出，不伪装成模型 JSON 问题。历史窗口只影响发送载荷，所有消息和修订原文仍在本地。

## 分层

Side Panel（Vue / Naive UI）→ Pinia store → Chrome runtime 消息 → Zod 命令验证 → CouncilService → 独立业务模块 / 调度器 → Dexie。

后台是唯一业务写入口；界面从数据库快照显示状态，不能直接声明任务完成。运行消息要求浏览器提供的发送者扩展 ID 和精确侧边栏 URL 匹配。扩展侧边栏文档也可以在独立扩展标签页打开；网页内容脚本、其他扩展和普通网站不能以此入口写入业务状态。未声明外部消息权限。动态网页注入使用 scripting 和四个平台的可选网站权限，只有用户授予对应 origin 后才能执行。

服务把 UI 命令、调度与恢复串行化。持久化调度租约用于阻止重复 worker 派发。每个调度步骤不等待完整模型生成，发送和查询操作分别保存阶段及凭据。任务轮次结束、状态转换及下一轮入队在同一个数据库事务里提交。事务内密码摘要通过 `Dexie.waitFor` 保持事务有效。

## 数据库

强类型定义及输入 Zod schema 位于 `src/protocols/domain.ts`，命令协议位于 `src/protocols/commands.ts`。时间为 Unix 毫秒数。业务记录使用 `crypto.randomUUID()`，消息幂等键用 SHA-256 编码任务、目标参与者及事件 ID。

| 表                | 内容                                                                                                                 | 主要索引/约束                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| participants      | 名称、平台、HTTPS 网页地址、adapter ID/version、启用状态、检测证据、真实能力与限制原因                               | id、platform、updatedAt                                                          |
| discussions       | 不可变原始问题、背景、约束、期望结果、成员 ID 和名称快照、运行设置、状态、暂停前状态、当前轮次、无进展次数、结束原因 | id、status、updatedAt                                                            |
| messages          | 完整原始内容、类型、方向、任务/轮次/成员、关联请求、结构化结果、解析状态及交付状态                                   | id、唯一 dedupeKey、discussionId、roundId、replyTo、[discussionId+participantId] |
| rounds            | 初始/交叉审查/事件/确认轮次、状态、公共摘要、起止时间                                                                | 唯一 [discussionId+roundNumber]                                                  |
| claims            | 所有当前核心结论、所有者、稳定 key、版本、类别、是否关键、来源消息                                                   | id、discussionId、[discussionId+ownerId]                                         |
| claim_revisions   | 每次修订的历史文本、版本和来源                                                                                       | 唯一 [claimId+version]                                                           |
| positions         | 各成员对各结论的独立最终/非最终立场、所针对版本、具体理由、条件及证据 ID、来源消息与轮次                             | 唯一 [discussionId+participantId+claimId]                                        |
| objections        | 提出者、目标成员、结论版本、严重度、状态、证据、各成员解决意见及来源                                                 | id、discussionId、relatedClaimId                                                 |
| consensus_records | 每轮确定性判断、全部成员立场快照、阻断原因、未核实事实、稳定轮数、指纹                                               | 唯一 [discussionId+roundNumber]                                                  |
| fact_checks       | 用户文档/本地计算来源、说明、结论版本、核验状态、核验时间和计算操作数                                                | id、discussionId、claimId                                                        |
| task_queue        | 幂等事件键、任务/成员/消息/轮次、发送或轮询状态、凭据、有限重试、下一次时间、租约、错误原因                          | 唯一 dedupeKey、discussionId、status、[status+nextRetryAt]                       |
| logs              | 操作码、级别、任务归属、受控详情、时间                                                                               | id、discussionId、createdAt                                                      |
| reports           | Markdown / HTML / JSON、生成时的任务状态、时间                                                                       | 唯一 discussionId                                                                |
| leases            | 调度器所有者和到期时间                                                                                               | id                                                                               |

新增表：browser_sessions（id、discussionId、participantId、tabId、origin、createdAt，唯一 [discussionId+participantId]）；browser_deliveries（幂等 ID、任务/参与者/标签、请求标记、prepared/submitted/complete、最近文本、变化时间、观察次数、是否见过生成状态、完整原文）。它们包含在任务删除、全部数据清空、快照和报告 JSON 中。

数据库 v1 建立基础表；v2 增加结论修订和立场表，补齐恢复字段；v3 增加网页会话及发送记录。实际升级测试验证旧记录保留并升级至 v3。修改表或索引必须新增 Dexie 版本和迁移函数，禁止删除数据库代替迁移。0.2.4 新增兼容旧记录的可选字段，无表或索引变更，仍使用 v3。

0.2.4 增加 `CapabilityCheck.firstMessageAllowed`、诊断中的 `emptyConversation` 和参与者状态 `first_message_ready`。这些字段只表示已确认空白页可尝试首条问题，`technicalVerified`、读取、完成与无人值守能力仍为 false。`QueueTask.confirmationAttempts` 保存只读发送核对次数，旧记录按 0 处理；计数不混入安全发送重试次数。

0.2.5 的 `BrowserSession.preparation` 保存 reset_requested/ready/blocked、点击前时间、最近检查时间、编辑器状态、用户/助手消息数量及受控原因；`readProof` 保存该专用页面清空前实际完成样例的适配器版本和检查时间，不保存页面正文。字段可选、无需改变表或索引。

历史原始消息保留所有立场变化，positions 是当前投影，consensus_records 是每轮快照；报告 JSON 导出完整消息、结论修订和审计日志。UI 日志仅显示最近 200 条，不影响数据库保留记录或报告按任务导出。

## 任务状态机

`CREATED → INITIALIZING → INITIAL_ANSWERS → FREE_DISCUSSION → OBJECTION_REVIEW → CONSENSUS_CHECK`。

通过严格共识后进入 `FINALIZING → COMPLETED`。状态完成和最终报告在同一事务提交。未通过时按事件或确认进入下一轮；达到最大轮数或连续三轮无语义进展进入 `UNRESOLVED`。重大运行异常可以进入 `FAILED`；可处理的权限、网页、格式、超时及结果未知问题进入 `PAUSED` 并保留 resumeStatus。

人工终止是 `UNRESOLVED / USER_STOPPED`，不会标记为共识完成。原始问题没有编辑命令。用户可以暂停、恢复、终止或删除任务。

## 网页适配器与能力门

适配器接口含 inspect、submit、reconcile、poll。BrowserDomAdapter 接受独立的平台配置，Chrome BrowserPort 执行自包含 pageOperation 函数，运行在 ISOLATED 世界。生产脚本不接触 cookies、localStorage、应用内部状态或网络接口。

本版按用户后续指令把规则信息与技术就绪分开：interactionMode=browser_dom 时不再因 policy=restricted 硬编码禁用。technicalVerified 表示输入、已完成回复样例和完成控件在当前页面匹配，能力每次重查，不能由配置直接强制声明。标签页存在本身仍不够；未登录、验证阻断、缺少输入/回复/完成区域都会暂停。

DeepSeek 首页路径、已观察到的欢迎语、空输入框、无消息/完成控件且无验证阻断共同证明空白会话时，允许初始问题试发；不能只凭未找到回复就推断空白。Gemini、ChatGPT 已确认空白首页同样允许首轮，其他未识别页面仍需完成样例。首次任务创建独立会话，后续仅复用已结束专用页并切换新对话，不沿用样例上下文。新会话有历史时尝试明确的新对话按钮，无法确认空白则不发送，不覆盖草稿。

能力门区分新的已验证发送、首轮尝试和只读观察。已有 sending/waiting 队列可在生成中继续核对/轮询，读取与完成判断仍由实际专用标签、请求标记及 DOM 观察验证。只读核对若证明未发送，必须重新通过发送能力检查，不能拿轮询权限发送后续消息。

SessionPreparer 独立管理首次发送前的空白会话准备。先持久化 reset_requested，再点击有明确名称的新对话控件；后续步骤只观察，不重复点击。超出 30 秒未确认空白则 blocked 并暂停，原文/草稿不被删除。SESSION_INITIALIZING 是准备阶段，调度器延后检查而不增加发送重试次数。关闭原样例页后，只允许带匹配任务/参与者和同版本 readProof 的首轮尝试继续，不能跨任务借用证明，不能授权后续已验证发送，也不会将读取、完成或无人值守标记改成 true。

网页输入通过原生 textarea setter 和 input 事件，或 contenteditable 编辑和同步事件；点击发送按钮，缺少明确按钮时触发 Enter 处理。富文本输入可能短暂激活目标标签，之后恢复原标签。DOM 事件不等于可信硬件输入；若网站拒绝，只能根据未确认结果暂停，不能宣称支持。

每次请求附有唯一 AI_COUNCIL_REQUEST 标记。发送确认必须从用户消息区域查到标记，不能仅凭 click/输入成功。回复必须在该请求之后，且没有生成中状态、出现完成控件、至少两次观察及四秒文本稳定，才被接收。不在页面时不挪用其他回复，关掉专用标签后不盲目重开重发。

Chrome 网站权限仅包含 DeepSeek、豆包、ChatGPT、Gemini 四个 origin 的可选权限；页面检查按钮在用户手势中请求。元数据适配器仍支持无浏览器环境和未接入的 Claude，自定义平台没有可执行脚本配置入口。

## 消息与异常

发送前先持久化消息和队列，然后保存 `sending`；收到凭据后才变为 `waiting / delivered`。收到完整原始回复后先保存原文，再原子解析并应用结论、争议和立场。解析失败保留原文并最多请求两次格式整理；仍然失败就暂停，不生成替代结构化观点。

结果未知时保留 `sending` 和幂等键，自动进行最多五次只读 reconcile，期间不再 submit。确认未发送才回到 pending 并重查发送能力，确认已提交才转 waiting；五次后仍未知则暂停。只有适配器明确报告“可重试且没有发送”才自动重试提交。回答超时仅对原凭据重新查询，不创建新请求；先查询可读取结果，再处理超时。明确恢复会刷新等待窗口，保留原凭据、发送记录及审计历史。成功交付/核对/接收清除队列当前 lastError，历史失败仍留在 logs。

页面退出登录、不可用、限制撤销、检查失败、数据库失败和上下文超限都有可见错误和审计码。日志不保存原始网页异常、账号信息、Cookie、Token 或完整提示词。问题和消息本身可能敏感，保存在业务表，不写入操作日志。

## 讨论和严格共识

初始提示词完全相同，不含其他成员回复。后续共享原始任务、全部原始入站消息、结论版本、证据、争议和确定性公共摘要。当前上下文上限为 180,000 字符，超限暂停，保留全部原文；不静默截断历史。

交叉审查后根据未解决争议选择目标成员和提出者，按争议 ID + 结论版本 + 成员去重，不固定 GPT → Gemini → Claude 轮转。没有新事件时请求各成员逐项最终表态以验证共识。

每项结论需全体成员对当前版本有理由地认可；最终表态需来自本轮，拒绝只重复运行检查函数来增加稳定次数。CONDITIONAL 条件必须有独立核验证据；AGREE 不能夹带隐藏条件。重大/关键争议不能未解决；关键事实/计算/未验证结论必须具有当前版本 VERIFIED 证据；最新矛盾证据会阻断共识。规则不使用多数投票。

共识指纹包括结论版本、全体立场、条件、未解决争议及证据。连续至少两个不同讨论轮次满足相同完整条件才通过。新结论、新版本、新分歧或证据变化重置稳定计数。

重大争议只在提出者附具体理由撤回，或全部相关成员附具体理由认可新修订版本后关闭；简单“我同意”不能关闭。当前实现采用保守的可验证流程，不试图用关键词猜测自然语言语义。

## 事实与报告的边界

外部事实不会因为多模型同意被核实。用户可以保存文档片段及自己的核验结论（明确标记 user_document）；本地求和、乘积验证标记 local_calculation，只证明算式，不能证明输入参数来自可靠规格书。模型不能写入 VERIFIED 事实。证据绑定结论版本，不适用不能替代事实或计算核验。

报告按已有结论和记录整理，不调用模型润色、填补或综合虚构方案。未完成任务可以导出阶段性报告，报告标题和状态明确反映未达成共识。HTML 转义全部原始文本并限制脚本，侧边栏不使用 v-html。
