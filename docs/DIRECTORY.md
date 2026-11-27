# 完整项目目录（0.3.5）

实际源码、测试、配置和文档目录如下。

```text
AI-council/
├── docs/
│   ├── images/
│   │   ├── chatroom.png
│   │   ├── participant.png
│   │   └── settings.png
│   ├── results/
│   │   ├── automatic-start.json
│   │   ├── brain-dom-flow.json
│   │   ├── chat-sidepanel.png
│   │   ├── compliance.json
│   │   ├── coverage.json
│   │   ├── dashboard-sidepanel.png
│   │   ├── dom-blank-start-flow.json
│   │   ├── dom-flow.json
│   │   ├── dom-restored-session-flow.json
│   │   ├── e2e.json
│   │   ├── participants-sidepanel.png
│   │   ├── playwright-results.json
│   │   ├── report-sidepanel.png
│   │   ├── settings-sidepanel.png
│   │   ├── stale-draft.json
│   │   ├── ui-runtime.json
│   │   └── unit-tests.json
│   ├── ARCHITECTURE.md
│   ├── CHANGELOG.md
│   ├── DIRECTORY.md
│   ├── FEATURES.md
│   ├── IMPLEMENTATION.md
│   ├── PLATFORM-VERIFICATION.md
│   ├── RELEASE-0.3.5.md
│   └── TEST-REPORT.md
├── public/
│   ├── manifest.json
│   └── ro-guard.js
├── scripts/
│   ├── check-compliance.mjs
│   ├── package.mjs
│   └── test.mjs
├── src/
│   ├── adapters/
│   │   ├── base/
│   │   │   ├── adapter.interface.ts
│   │   │   ├── capability.ts
│   │   │   ├── compliance-gate.ts
│   │   │   └── restricted-adapter.ts
│   │   ├── dom/
│   │   │   ├── browser-dom-adapter.ts
│   │   │   ├── draft-recovery.ts
│   │   │   ├── page-operation.ts
│   │   │   ├── page-protocol.ts
│   │   │   ├── profiles.ts
│   │   │   ├── request-wire.ts
│   │   │   └── session-preparer.ts
│   │   └── registry.ts
│   ├── background/
│   │   ├── browser-port.ts
│   │   ├── index.ts
│   │   ├── recovery.ts
│   │   └── scheduler.ts
│   ├── core/
│   │   ├── brain-router.ts
│   │   ├── claim-manager.ts
│   │   ├── consensus-engine.ts
│   │   ├── context-manager.ts
│   │   ├── discussion-engine.ts
│   │   ├── fact-check-manager.ts
│   │   ├── history-window.ts
│   │   ├── message-manager.ts
│   │   ├── objection-engine.ts
│   │   ├── page-readiness.ts
│   │   ├── prompt-generator.ts
│   │   ├── request-coordinator.ts
│   │   ├── response-processor.ts
│   │   └── task-manager.ts
│   ├── database/
│   │   └── db.ts
│   ├── protocols/
│   │   ├── commands.ts
│   │   └── domain.ts
│   ├── reports/
│   │   └── report-generator.ts
│   ├── services/
│   │   ├── brain-request-runner.ts
│   │   ├── chat-ask-service.ts
│   │   ├── client.ts
│   │   ├── council-service.ts
│   │   ├── participant-service.ts
│   │   └── site-access.ts
│   ├── sidepanel/
│   │   ├── components/
│   │   │   ├── ModelCard.vue
│   │   │   ├── ReportDialog.vue
│   │   │   ├── RoomAvatar.vue
│   │   │   └── TaskControls.vue
│   │   ├── pages/
│   │   │   ├── Chat.vue
│   │   │   ├── CreateDiscussion.vue
│   │   │   ├── Dashboard.vue
│   │   │   ├── Discussion.vue
│   │   │   ├── Objections.vue
│   │   │   ├── Participants.vue
│   │   │   ├── Report.vue
│   │   │   └── Settings.vue
│   │   ├── runtime/
│   │   │   └── resize-observer.ts
│   │   ├── App.vue
│   │   └── styles.css
│   ├── stores/
│   │   └── council.store.ts
│   ├── utils/
│   │   ├── errors.ts
│   │   ├── id.ts
│   │   └── logger.ts
│   └── main.ts
├── tests/
│   ├── e2e/
│   │   ├── automatic-start.spec.ts
│   │   ├── brain-routing.spec.ts
│   │   ├── chatgpt-layout.spec.ts
│   │   ├── deepseek-empty.spec.ts
│   │   ├── dom-discussion.spec.ts
│   │   ├── dom-operation.spec.ts
│   │   ├── draft-dom.spec.ts
│   │   ├── extension.spec.ts
│   │   ├── new-conversation.spec.ts
│   │   ├── stale-draft.spec.ts
│   │   └── ui-runtime.spec.ts
│   ├── fixtures/
│   │   ├── council.ts
│   │   ├── dom-page.ts
│   │   └── legacy-draft.ts
│   ├── integration/
│   │   ├── automatic-start.test.ts
│   │   ├── brain-ask.test.ts
│   │   ├── browser-dom.test.ts
│   │   ├── browser-port.test.ts
│   │   ├── draft-recovery.test.ts
│   │   ├── evidence-objections.test.ts
│   │   ├── lifecycle.test.ts
│   │   ├── platforms.test.ts
│   │   ├── queue.test.ts
│   │   ├── request-isolation.test.ts
│   │   ├── services-events.test.ts
│   │   └── storage-report.test.ts
│   ├── unit/
│   │   ├── brain-router.test.ts
│   │   ├── consensus.test.ts
│   │   ├── prompt-window.test.ts
│   │   ├── resize-observer.test.ts
│   │   └── site-access.test.ts
│   └── setup.ts
├── .gitattributes
├── .gitignore
├── .prettierignore
├── .prettierrc.json
├── package-lock.json
├── package.json
├── playwright.config.ts
├── README.md
├── sidepanel.html
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
└── 文档.txt
```

生成目录：dist/ 为可加载扩展；release/ 保留版本包和 SHA256SUMS.txt；coverage/、playwright-report/、test-results/ 为测试产物；.tmp/ 为隔离测试临时配置；node_modules/ 为依赖，不进入源码包或 Git 历史。GitHub 安装包与源码包放在 Releases，仓库保留完整源码、测试、项目说明和截图。
