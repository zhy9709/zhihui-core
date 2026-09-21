# 智汇 zhihui

编码代理统一调度台：多家 AI 编码工具（Codex/Qoder/…）按额度×难度×能力路由派活，git worktree 隔离执行，统一验收收口。

- 需求：specs/2026-09-21-zhihui/spec.md（v2.0 定稿中）
- 方案：specs/2026-09-21-zhihui/plan.md
- 评审：specs/2026-09-21-zhihui/codex-implementation-v3.md


## 60 秒派发（T2）

先在 `fleet.json` 设置 `workspaces_root` 与可选的 `max_worktrees`，再写一个任务书：

```json
{"task_id":"hello-1","repo_path":".","base_ref":"main","brief":"给 README 加一行"}
```

```sh
zh dispatch task.json --to local-agent --fleet fleet.json --data state
zh tasks --data state
```

headless driver 的 `launch` 可使用 `{brief}`、`{worktree}`、`{log}` 占位符。先用 `--dry` 预览命令；manual driver 不启动进程，显示“任务书已登记待粘贴”，随后用 `zh attach hello-1 --branch agent/hello-1` 登记外部产物。

## Collect 验收收口（T3）

```mermaid
flowchart TD
  A["zh collect task-id"] --> B{"acceptance 全部通过?"}
  B -->|是| C["merge + verified tag + 保留 worktree 24h"]
  B -->|否| D["rejected + state/rework 工单"]
```

验收命令只来自任务 JSON 的 `acceptance.checks`，并以数组参数直接运行；任务 brief 和日志不会被执行。

```sh
zh collect hello-1 --data state
zh history hello-1 --data state
zh prune --data state       # 仅清理已过 24 小时保留期的 verified worktree
```
