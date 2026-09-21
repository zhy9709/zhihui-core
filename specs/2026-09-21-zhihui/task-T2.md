# 任务T2：派发引擎——worktree 隔离 + headless 执行 + manual 登记
关联：specs/2026-09-21-zhihui/spec.md F4、F6(状态机侧)、F8 ｜ 前置：T1 已合并（12090b0）

## 背景
zhihui-core 是编码代理统一调度台。T1 已交付：JSON 注册表（fleet.mjs）、任务状态机（tasks.mjs：queued→locked→running→done|failed|unknown，幂等 task-id，events.ndjson，原子写）。
本任务实现"出征"：把任务派给 driver 执行。不做路由打分（T4）、不做验收门禁（T3）。

先读：仓库内 spec.md 全文、src/tasks.mjs 与 src/fleet.mjs 现状代码（必须复用其状态机与存储原语，禁止另起一套状态）。

## 要求
1. src/runner.mjs：
   - `prepare(task, driver)`：在配置的 workspaces 根下 `git worktree add -b fleet/<task-id> <path> <base-ref>`；worktree 路径与基线来自任务 JSON（repo_path/base_ref），禁止硬编码任何仓库 URL/IP；驻留数量上限检查（读配置 max_worktrees，超限拒绝 dispatch 并提示，不自动删）
   - `launch(driver, task, ctx)`：
     - kind=headless + host=local：spawn 命令模板（launch 字段含 {brief} {worktree} {log} 占位符替换），detached 记录 pid，心跳文件写入 worktree 目录（简单心跳：runner 每 10s touch hb 文件）
     - kind=headless + host=remote：通过可注入的 sshRunner 接口执行（测试全部 mock，不真连）；命令构造与本地同构
     - kind=manual：不执行进程——任务转 status=dispatched，driver=目标名，输出"任务书已登记待粘贴"提示；提供 `zh attach <task-id> --branch <ref>` 把外部产物登记到任务记录
   - 超时：timeout_min 到 → kill 进程组（本地）/ 远程下发取消命令 → status=failed(timeout)
   - 完成：进程 exit 0 且 worktree 有新 commit（rev-list base..HEAD 计数>0）→ status=succeeded，记录 commit hash；exit 0 但无 commit → status=failed(noop)
2. src/cli.mjs 新增：
   - `zh dispatch <task.json> [--to name] [--dry]`：task.json 幂等创建（复用 T1）→ 状态锁（locked 后不可二次 dispatch，冲突 exit 3）→ 按 driver kind 走 launch 或 manual 登记；--dry 只打印将执行的命令不执行
   - `zh tasks`：列任务+状态+driver+commit
   - `zh dispatch-done <task-id>`：手动结单（headless 失联时人工裁决 unknown→done|failed，写事件）
3. 事件与恢复：launch/kill/exit/attach 均追加 events.ndjson；`zh recover` 扩展：running 且心跳 hb 文件 mtime 超过 3×心跳间隔 → 标 unknown（**绝不自动重派**）；locked 无 running 痕迹 → 回 queued
4. test/ 新增 ≥10 用例（全部用临时 git 仓 + fake driver，headless 用 `/bin/sh` 或 node 一行脚本当假 agent）：worktree 创建与冲突拒绝、占位符替换、noop 判 failed、exit≠0 判 failed、超时 kill、manual 登记+attach、二次 dispatch 幂等 exit 3、心跳过期→recover 判 unknown、max_worktrees 上限拒绝
5. README 增补 dispatch 60 秒上手示例

## 环境铁律
- 零第三方依赖（node:child_process/node:fs 等内置）；测试禁真实网络与真实 SSH（接口注入 mock）
- 所有状态迁移必须经 tasks.mjs 原语，禁止 runner 直接改任务文件
- 进程 kill 用进程组（detached+负 pid），避免孤儿
- Windows 远程执行的命令模板差异按 platform 字段分支，测试 mock 覆盖两平台

## 验收标准（自己全跑通才算完）
- [ ] npm run check && npm test 全绿并报用例数（应 ≥27）
- [ ] 真实演练：在本仓临时 worktree 上用 fake headless driver（一条写文件+commit 的 node -e）跑通 dispatch→succeeded 全链，贴输出
- [ ] zh dispatch 对已存在 task-id 返回 exit 3 无副作用
- [ ] --dry 不产生任何进程/文件副作用
- [ ] 单次 commit："T2: worktree isolation + headless/manual dispatch + timeout + recover"

## 交付
PR 到 main，标题「T2 派发引擎」，描述列改动文件、与原 T1 接口的衔接点、未覆盖风险。
