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
