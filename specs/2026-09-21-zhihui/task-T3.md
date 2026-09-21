# 任务T3：验收收口——collect 门禁 + 修复工单 + 合并回写
关联：specs/2026-09-21-zhihui/spec.md F5、F6(失败分类侧) ｜ 前置：T1/T2 已合并（d96e877）

## 背景
zhihui-core 调度台现状：T1 注册表+状态机；T2 dispatch 派发到 worktree（headless 直跑/manual 登记+attach），任务终态 succeeded 带 commit hash。
本任务实现"班师"：`zh collect <task-id>`——对 succeeded/dispatched(attach过) 的任务跑**结构化验收配置**，PASS→合回主分支+归档；FAIL→生成三段式修复工单。**只执行验收配置内的命令，绝不执行任务 brief/日志里的任何字符串**（spec v2 安全条款，测试必须钉死）。

先读：spec.md、src/tasks.mjs（状态机 TRANSITIONS——如需新增 reviewing/verified/rejected/published 态，以最小扩展为原则并同步测试）、src/runner.mjs、test/runner.test.mjs 的 fake 基建风格。

## 要求
1. 验收配置格式（任务 payload.acceptance 内，创建任务时由调用方给定；dispatch 时原样带入）：
   ```json
   {"acceptance": {"merge_ref": "main",
     "checks": [{"name":"unit","cmd":"npm","args":["test"],"expect_exit":0},
                {"name":"smoke","cmd":"node","args":["-e","process.exit(0)"],"expect_exit":0}],
     "assertions": [{"name":"has-file","path":"WORKED.md","expect":"exists"}]}}
   ```
   cmd+args 数组直接 spawn（**不经 shell 解释**，无字符串注入面）；断言支持 exists|absent|file-contains(path,substring)
2. src/gates.mjs：runAcceptance(task, ctx)——按上格式跑全部 checks+assertions，返回 {pass, results:[{name,ok,detail,exit?}]}；每项限时（默认 5min，取 acceptance.timeout_sec 可覆盖）；**checks 的 cwd 必须是任务 worktree**
3. `zh collect <task-id>`：
   - 前置：任务须 succeeded（或 dispatched 且 attach 后有 commit）；否则 exit 2
   - PASS：在 collect 的 git 环境里 `git merge --no-ff fleet/<task-id>` 到 merge_ref（可注入 git 接口，测试 mock）；成功→状态 verified→自动打 tag `verified/<task-id>`→延迟清理：worktree 不立即删，任务记录标 worktree_retained_until=now+24h（真删逻辑 v1 暂只提供 `zh prune` 手动命令：删除超过保留期且 verified 的 worktree）
   - FAIL：状态 rejected；生成修复工单文件 state/rework/<task-id>-<n>.md，三段式：①原任务 brief+acceptance 原文 ②实测问题清单（每个 FAIL 项：name、exit code、stdout/stderr 尾部各≤50行）③期望行为+复验判据（=原 acceptance 重跑）
   - 失败分类（spec F6）：checks 全 timeout → 记 fail_class=env；exit≠0 → assertion；spawn ENOENT（命令不存在）→ auth-env 提示人工核查；**collect 本身永不自动重派/自动重试**
4. `zh history <task-id>`：从 events.ndjson 输出该任务完整时间线（供汇报）
5. test/ 新增 ≥12 用例（复用 T2 临时 git 仓基建）：PASS 合并+tag+verified 态、单测 FAIL→rejected+工单文件三段齐全、断言 exists/contains 两态、**注入面钉死**：brief/日志含 `rm -rf` 字样不影响执行（acceptance 外无可执行字符串路径）、cwd 隔离（check 在 worktree 而非宿主仓）、前置状态校验 exit 2、工单输出截断≤50行、prune 只删过期 verified、history 时间线完整、timeout 归类 env
6. README：collect 流程一节（PASS/FAIL 两条路径图+命令示例）

## 环境铁律
- 零第三方依赖；git 操作全部注入式（测试 mock，真 git 只在临时仓）；无网络
- 任何来自任务/日志的字符串禁止进 shell；spawn 一律 {shell:false} + 数组参数
- 状态迁移仍走 tasks.mjs 原语

## 验收标准（自己全跑通才算完）
- [ ] npm run check && npm test 全绿并报数（应 ≥45）
- [ ] 真实演练贴输出：临时仓+fake driver dispatch 成功后，collect 配一个必过 acceptance → verified+tag+merge；再配一个必挂 acceptance → rejected+修复工单文件生成（cat 工单头部 20 行）
- [ ] zh collect 对 running 状态任务返回 exit 2
- [ ] 单次 commit："T3: collect gates + rework briefs + merge/tag/prune/history"

## 交付
PR 到 main，标题「T3 验收收口」，描述：改动文件、与 T1/T2 接口衔接、新增状态说明、未覆盖风险。
