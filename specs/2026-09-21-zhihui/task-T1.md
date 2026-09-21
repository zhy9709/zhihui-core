# 任务T1：智汇骨架——注册表+探活+自检+幂等底座
关联：specs/2026-09-21-zhihui/spec.md F1、F2、F4(幂等/状态机基础)、F8(recover) ｜ 形态：Node ≥18 纯 ESM、零第三方依赖

## 背景
zhihui-core 是编码代理统一调度台（详见仓库内 spec.md v2.0，第一原则=不丢/不重/不假报）。
本任务做地基：注册表、探活、自检、任务状态存储。**不做**路由打分与派发执行（T2/T4）。

先读：仓库 specs/2026-09-21-zhihui/spec.md 全文（这是验收宪法）。

## 要求
1. 目录：bin/zh、src/cli.mjs、src/fleet.mjs、src/state.mjs、src/tasks.mjs、fleet.example.json、test/
2. driver schema（JSON 注册表）：name/kind(headless|manual|acp)/caps/cost/quota_probe/host/platform(win|linux|mac)/timeout_min；`zh validate` 报错指出字段与文件；zh add（重名拒）/zh list
3. `zh doctor`：按 platform 适配探测（win→where、linux/mac→command -v）；登录态与 quota_probe 可空；输出 PASS/WARN/FAIL+退出码
4. `zh status`：探活合并 state.json；额度记录为 {value,source,measured_at,confidence}；paid-fixed 档禁止记无限，记限速事实
5. src/tasks.mjs：任务对象=JSON(task-id 唯一主键幂等)+状态机 queued→locked→running→done|failed|unknown；全部写盘 tmp+rename；追加 events.ndjson；`zh recover` 扫锁：running 无心跳→unknown
6. test/：node --test ≥14 用例，含 fake-driver validate/doctor 三态、task-id 重复创建拒绝、recover 判 unknown、原子写崩溃残留（临时文件不污染正式文件）

## 环境铁律
- 零第三方依赖，仅 node: 内置模块；测试禁联网（探测全部 mock）
- 任何写文件走 tmp+rename；路径来自主机别名配置，禁止硬编码 IP/绝对私有路径
- Windows 适配点必须通过注入 platform 参数测试，不真依赖 win 环境

## 验收标准（自己全跑通才算完）
- [ ] node --check 全文件；node --test 全绿并报用例数
- [ ] zh validate 对缺 caps/未知 kind/重名 fake.json 各报对应错
- [ ] 同 task-id 二次创建返回幂等冲突且无副作用；zh recover 对伪造 running 锁判 unknown
- [ ] 单次 commit："T1: registry + state machine + doctor/status/recover skeleton"

## 交付
PR 到 main，标题「T1 骨架」，描述列改动文件与原由。
