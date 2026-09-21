# 智汇（zhihui）实施方案 plan v1.0
> 上游：spec.md v1.2 ｜ 仓库：zhy9709/zhihui-core ｜ CLI：zh ｜ 2026-09-21

## 1. 形态与技术选型
- 纯 Node.js ≥18、**零第三方依赖** CLI（v2.0：注册表 JSON 化，幂等 task-id、状态机+unknown 不重派、结构化验收配置——详见 spec.md 变更记录）（ESM，`node --test`），命令入口 `zh`
- 无数据库、无前端：状态=fleet.json + state/fleet-state.json + git 分支；微信是唯一人机界面（由 PM 小派操作）
- 运行位置：树莓派（调度大脑+git 中枢）；重执行器宿主=台式机 Win x86（SSH 已通）

## 2. 目录布局
```
zhihui-core/
  bin/zh                # 入口 shim
  src/cli.mjs           # 子命令路由
  src/fleet.mjs         # 注册表读写+schema校验
  src/router.mjs        # 点将打分（T4）
  src/runner.mjs        # worktree+进程执行（T2）
  src/gates.mjs         # 验收门禁（T3）
  src/state.mjs         # fleet-state.json 读写
  fleet.example.yaml    # driver 模板
  test/                 # node --test（含 fake-driver 全链路仿真）
  README.md
```

## 3. Driver 模型（借鉴 vibe-kanban Executor trait，砍到 7 要素）
```yaml
- name: codex-cloud
  kind: manual            # 任务书交接+PR认领（当前主力，月费=额度无限）
  caps: [frontend, backend, refactor, game]
  cost: paid-fixed
  quota_probe: none
- name: qoder-cli
  kind: headless          # 可自动直跑
  host: desktop           # 或 local
  launch: "qoder --print -p {brief} --output-format json > {log}"
  cwd: "{worktree}"
  timeout_min: 40
  caps: [backend, refactor]
  cost: free-tier
  quota_probe: "qoder usage --json"   # 无官方命令则 accounting 记账模式
- name: gemini-cli
  kind: acp               # P2 预留
  ...
```
kind 三种：`headless` 直跑 / `manual` 云端手粘系收编（同样进路由账本）/ `acp`（P2 走 OpenClaw acpx）。

## 4. 命令表
| 命令 | 作用 | 里程碑 |
|---|---|---|
| `zh add/list/validate` | 注册表管理+schema 自检 | T1 |
| `zh doctor` | 二进制存在性/登录态/配置检查，逐家 PASS/FAIL | T1 |
| `zh status` | 探活一轮→state.json（在线/额度/近期成功率） | T1 |
| `zh route <brief.md>` | 只算不派：建议派谁+三行理由 | T4 |
| `zh dispatch <brief.md> [--to X] [--task-id T]` | worktree+分支 fleet/<id>→跑/登记→commit→state | T2 |
| `zh collect <task-id> [pr-ref]` | 拉分支跑可测判据→PASS/FAIL 报告；FAIL 生成修复工单 | T3 |
| `zh usage [--week]` | 各家消耗账本 | T4 |

## 5. 路由打分（v1 可解释优先，不做黑箱）
score = caps 硬门槛 × 成本权重(免费有余量 1.0 / 月费 0.9 / 额度尽 0) × 近5次成功率(0.5~1.0) × 难度适配(difficulty≥8 偏好 model_tier=high)。
水位<20% 出队并在理由中说明；`--to` 强制指定优先级最高；连败2轮自动 F6 换路。

## 6. 验收门禁分工
gates.mjs 只跑任务书「验收标准」中**机器可判项**（测试命令/curl 判据）；真机部署+手机端点验由小派人工执行——工具管一半，PM 管另一半。FAIL 自动生成三段式修复工单（原文+实测证据+期望行为）。

## 7. 里程碑与任务书
- **P0**：T1 骨架(F1/F2：cli+schema+doctor/status+fake-driver 测试) → T2 派发引擎(F4：worktree+headless 本地/SSH+超时+commit) → T3 收口(F5：collect+gates+修复工单)
  - P0 判据：fake-driver 全链路绿；Qoder CLI 台式机真跑 1 个最小 README 任务收编成功
- **P1**：T4 路由器+账本(F3/F6/F7) → T5 manual 收编完善(Codex 云端 PR 认领：git fetch refs/pull/*)
- **P2**：ACP driver(acpx 批量接入)、探活 cron 低峰化、扩 8~10 家、Web 看板(F8 远期)
- 纪律：单任务书单 PR；T1 过验收才发 T2（串行，文件集暂无不相交把握）

## 8. 风险登记
1. 各家 CLI 参数/登录态随版本漂移 → driver 全配置化，doctor 报警隔离
2. ARM 树莓派 CLI 兼容性未知 → v1 执行器承诺 x86 台式机；zh 本体仅 Node 跨平台
3. 额度探测常无官方命令 → accounting 记账模式兜底（dispatch 即扣+人工校准）
4. worktree 磁盘占用 → 终态即 prune，驻留≤20
5. 风控红线 → 绝不自动化注册/刷登录，仅只读探测
