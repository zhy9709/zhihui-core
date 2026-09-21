# 智汇（zhihui）— 需求文档 v2.0
> 状态：待拍板 ｜ PM：小派 ｜ 2026-09-21 20:30 吸收 Codex v3 评审稿修订（v1.2 作废）

## 名字与定义
- **中文名**：智汇 —— 各家编码代理的智慧汇聚一处：平台不写码，只管调度、看粮、收口
- **仓库名**：`zhy9709/zhihui-core`，CLI 命令 `zh`
- **一句话定义**：本地运行的**编码代理统一调度台**——集成多家 AI 编码工具（CLI 或云端），
  按剩余额度、任务难度、能力匹配选工具派活，产出统一收 git 分支，验收统一过门禁。
- **第一原则（Codex v3 采纳）**：让工作**不丢、不重复执行、不假报完成**优先于一切；省钱排第二。
- 平台/工具层：不定义开发流程（codex-dev-team skill 的事），不含业务项目逻辑。

## 形态裁决（v2 新增，防范围膨胀）
- **v1 = CLI 短进程 + 文件状态 + git**，零第三方依赖，无常驻服务、无数据库、无 Web。
- 常驻核心/Windows Worker 服务/事件数据库 = **P4 升级路径**，仅当 v1 实测被短进程模型卡住才立项。
- 状态持久化用 JSON 文件（tmp+rename 原子写）+ 追加式事件日志 `events.ndjson`（即轻量事件溯源）。

## 背景与目标
多家编码代理各有免费额度（Qoder/CodeBuddy/Trae/Copilot Free…）+ 已付费主力（Codex）。
目标：**额度看得见、派活不用想、交付一个口、断电不丢单**。

## 使用者与场景
- 直接使用者：小派（主会话调用 `zh`）；杨哥（微信收状态/结果/账本，可一句话改派）
- 环境：树莓派（调度大脑+git 中枢）+ 台式机 Win11 x86（重执行器宿主，SSH 已通）

## 功能点
- **F1 工具注册表** `fleet.json`（不再自写 YAML 解析）：driver 要素：
  name / kind(headless·manual·acp) / 命令模板或任务书交接协议 / caps / cost 档 /
  quota_probe / **host 别名+platform(win·linux·mac)**（探测命令按平台适配：`where` vs `command -v`，禁止假定 Windows 有 Unix 命令）
- **F2 粮仓探活** `zh status`：在线/登录/额度+**可信度三元组 {value, source, measured_at, confidence}**；
  **月费档不得记作无限**（记 fixed_plan + 已知限速事实，如 5h 窗口/周上限）；结果写 state.json
- **F3 点将路由** `zh route <task>`：能力硬门槛→额度水位→难度档→近5次成功率，输出建议+三行理由；
  `--to` 只覆盖**偏好排序**，不覆盖安全/授权/能力硬门槛（v2 修正）
- **F4 出征隔离** `zh dispatch <task.json> [--to X] [--task-id T]`：
  ①task-id 为主键**幂等**（重复 dispatch 拒绝二次执行）②执行锁：状态机 queued→locked→running→done/failed，
  失联(心跳超时)进 `unknown`，**unknown 禁止自动重派**，只报警人工裁决（v2 新增）
  ③git worktree+分支 fleet/<T>；headless 直跑或 manual 登记待收；日志落盘
- **F5 班师验收** `zh collect <T>`：跑**结构化验收配置**（JSON：命令数组+期望退出码+产物断言），
  只执行版本化配置内命令，**绝不执行任务书自然语言里的任意命令**（v2 安全修正）；
  PASS→merge+归档补丁后延迟 prune；FAIL→生成三段式修复工单（附实测证据），**失败现场 worktree 保留待查**
- **F6 失败分类换路**（v2 细化）：assert-fail（验收不过）→ 修复工单或换将；
  auth/permission 失败 → **不换路绕过**，出队报警等人工登录；
  timeout/失联 → 不自动重派（防双开）；额度尽 → 排队换将
- **F7 账本** `zh usage`：各家消耗/占比/校准记录（记账模式：dispatch 估算扣减+probes 校准，标注估算值）
- **F8 重启恢复**：`zh recover`——启动扫 events.ndjson+锁文件，running 而无心跳 → 标 unknown，
  queued 可续派，任何状态不静默吞单（v2 新增，"不丢单"落地点）

## 非目标（不变）
不是 API 网关 / 不是 CI/CD / 不含 SOP 流程 / 不写代码 / 不批量注册绕风控（登录全人工，只读探测）/ v1 无 Web UI

## 验收标准（平台自身，全部可测）
- [ ] fake-driver×2（headless+manual）：doctor 三态 PASS/WARN/FAIL+退出码正确
- [ ] 全链路仿真：dispatch→分支 commit→collect PASS→merge 补丁归档；注入失败→FAIL+修复工单生成
- [ ] **幂等**：同 task-id 二次 dispatch 拒绝且无副作用；二次 collect 结果一致
- [ ] **不丢单**：dispatch 中途 kill 进程→`zh recover` 后状态正确可判（unknown/queued 各有其主）
- [ ] 额度水位<20% 时 route 不选该家且理由可见；`--to` 无法绕过 caps 硬门槛
- [ ] 验收配置外的命令无法被执行（测试钉死）
- [ ] 真实接入 1 家：Qoder CLI 台式机跑最小 README 任务收编成功
- [ ] Node ≥18 零第三方依赖，`node --test` 全绿；Windows 平台探测路径有单测（mock platform）

## 约束与风险
- 免费额度政策漂移 → driver 配置化，坏一家 doctor 报警隔离
- ARM 树莓派 CLI 兼容未知 → v1 执行器承诺 x86 台式机+本地 node 任务
- 多数家无官方额度命令 → 记账模式+估算值标注（可信度字段兜底）
- worktree 磁盘 → 终态延迟清理+驻留≤20，容量不足阻止新 dispatch
- 短进程模型的并发上限是刻意取舍：同时>2 单或需要多人共享时，才启动 P4 常驻化评估

## 变更记录
- v2.0 2026-09-21 20:30 吸收 Codex v3 评审稿 15 条中的 11 条（JSON 注册表/幂等/状态机+unknown 不重派/失败分类/验收配置白名单/--to 不越权/月费非无限/worktree 延迟清理/Windows 适配/不丢单恢复/估算标注）；**拒绝常驻核心+DB+Worker 进入 v1**（列 P4）；自写 YAML 方案作废
- v1.x 定名智汇、仓库 zhihui-core（17:55-18:03）；agent-fleet 旧案归档
