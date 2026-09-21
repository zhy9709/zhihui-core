# 任务T4：点将路由 + 消耗账本
关联：specs/2026-09-21-zhihui/spec.md F3、F6、F7 ｜ 前置：T1-T3 已合并（01aa794）

## 背景
zhihui-core 流水线已通：注册表(T1)→dispatch(T2)→collect 门禁(T3)。本任务装"脑子"：
`zh route <task.json>` 给出建议派谁+可解释理由；`zh usage` 输出账本。**路由只产建议，dispatch 仍由人/PM 确认**（v1 不做自动派发的强制路径）。

先读：spec.md、src/fleet.mjs、src/state.mjs（额度记录结构 {value,source,measured_at,confidence}）、src/tasks.mjs、src/runner.mjs、test/ 全目录（复用 fake 基建）。

## 要求
1. src/router.mjs：
   - 输入：任务对象（payload 需含 caps_required:[...]、difficulty:1-10，可选 prefer_cost）+ fleet 驱动列表 + state（水位/成功率）
   - 硬门槛：driver.caps 覆盖 caps_required（缺→直接排除，理由写明缺哪个）；status 为 offline/FAIL 的排除；免费档 quota.value 水位 < 0.2 排除（理由含数值）
   - 打分（全部可解释）：cost 权重（free-tier有余量=1.0，paid-fixed=0.9，manual=0.95，free耗尽→已被硬门槛排除）× 近5次成功率因子(0.5~1.0，样本<3 记 1.0) × 难度适配（difficulty≥8 且 driver.model_tier=high +0.2；difficulty≤3 且 model_tier=low +0.1）
   - 输出排序结果：[{driver,score,reasons:[三条以内人话]}]，reasons 必须引用具体数据（如"近5败2→0.6"、"水位0.15<0.2 出队"）
   - `--to` 指定时仍跑硬门槛，**只跳过排序不跳过安全**：caps 不满足/离线/耗尽 → 拒绝并说明（spec v2：--to 不越硬门槛）
2. src/cli.mjs 接线：
   - `zh route <task.json> [--fleet f] [--data d] [--explain]`：打印建议表；无可用将 → exit 4（队空提示）
   - `zh dispatch <task.json> [--to name]`：当未指定 --to 且 fleet 有 ≥2 候选时，自动取 route 第一名并在输出里附一行"路由依据"；单候选直接派
   - `zh usage [--week N]`：聚合 events.ndjson：各 driver 任务数/成败/时长总和/最近记录；paid-fixed 档展示"限速事实"字段（fleet 里记的 rate_limit_note），**不得显示无限**
3. F6 换路记录：dispatch 失败(failed/timeout)后 events 追加 route.blacklist_suggestion:{driver,task_id,reason}，**只建议不自动执行**（自动重试仍在禁止名单）
4. test/ 新增 ≥12 用例：硬门槛三排除各一（caps/离线/水位）、--to 越权被拒、打分排序确定性（同输入同输出）、reasons 引用数据断言、无候选 exit 4、dispatch 自动路由附依据、单候选直派、usage 聚合正确性、paid 档不显示无限、blacklist_suggestion 事件、difficulty 适配加分、样本不足=1.0
5. README：route/usage 用法一节 + 打分公式表

## 环境铁律
- 零第三方依赖；纯确定性代码（无 Math.random、无时钟依赖的排序须稳定）；测试不联网
- 路由读 state.json 不存在时降级为"全未知"并理由中标注，不 crash
- 不改 T1-T3 公共接口签名

## 验收标准（自己全跑通才算完）
- [ ] npm run check && npm test 全绿并报数（应 ≥59）
- [ ] 真实演练贴输出：临时 fleet（1 manual 有余量 + 1 headless 水位 0.1 + 1 caps 不匹配）对同一 task route → 第一名正确且 reasons 引用具体数字；--to 指定水位家被拒
- [ ] zh usage 输出含各 driver 计数表
- [ ] 单次 commit："T4: explainable router + usage ledger + blacklist suggestions"

## 交付
PR 到 main，标题「T4 路由与账本」，描述列改动、打分参数默认值理由、未覆盖风险。
