# dsh-ding

DeepSeek Harness（DSH）插件：在 **顶层会话** 完成、报错、等待审批或向你提问时，播放**当前系统设置的提示音**。

- macOS：`/usr/bin/osascript -e beep`，即系统设置 → 声音 → 警示音（受「警示音量」与系统静音影响）。
- 也可配置成任意 `.aiff` 音频（macOS `afplay`，可调音量）。
- 子代理 / Agent Teams 成员的会话**默认不响**，避免一个任务连环响铃。

## 触发时机（默认全开）

| 事件 | 条件 | 默认行为 |
| --- | --- | --- |
| `turn/end` | 顶层会话，`reason.kind === 'completed'` | 等 900ms，若同一会话没有紧接着开始新轮次则响一次 |
| `turn/end` | 顶层会话，`reason.kind === 'error'` | 同上（`aborted/blocked/max-tokens/interrupted` 不响） |
| `approval/asked` | 顶层会话的审批请求 | 等 400ms 仍未 `approval/decided` 才响（自动放行的审批不响） |
| `tool/call` | 工具名为 `ask_user_question` 或 `exit_plan_mode` | 立即响 |

所有触发之间共享 600ms 冷却，防止多会话/多事件连响。

## 安装

插件本身是一个 profile 组合包（bundle）。任选一种方式装进 `desktop` profile：

1. **从 GitHub 安装**：
   ```sh
   dsh plugin --profile desktop add github:couchette/dsh-ding
   ```
2. **Web UI**：侧栏「插件」→ 添加插件（箭头）→ 安装第三方插件 → 本地目录，填本仓库克隆后的绝对路径 → 安装并启用。
3. **手动链接**（本地开发时使用）：
   ```sh
   # 1) 依赖与组合包列表（profile 目录：$DSH_HOME/profiles/desktop）
   #    package.json dependencies 增加：
   #      "dsh-ding": "link:/path/to/dsh-ding"
   #    package.json dsh.profile.bundles 末尾增加 "dsh-ding"
   # 2) 链接进 profile 的 node_modules
   ln -sfn /path/to/dsh-ding "$DSH_HOME/profiles/desktop/node_modules/dsh-ding"
   ```
   启用了 HMR 的 profile 会在 manifest 变化后自动重组；否则重启 DSH。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（不要改插件包内的 `cordis.patch.yml`）：

```yaml
- id: dsh-ding
  config:
    # 总开关
    enabled: true
    # 是否也给子代理/团队成员会话响
    includeSubagents: false
    # 四类触发分别开关
    notify:
      turnCompleted: true
      turnError: true
      approval: true
      question: true
    # 视为「向用户提问」的工具名
    questionToolNames: [ask_user_question, exit_plan_mode]
    # 等审批多久仍未决才响（毫秒）
    approvalGraceMs: 400
    # turn/end 后多久没有新轮次才响（毫秒）
    continuationGraceMs: 900
    # 两次响铃的最小间隔（毫秒）
    minIntervalMs: 600
    # 'system' = 当前系统提示音；其他值 = 音频文件绝对路径（如 /System/Library/Sounds/Glass.aiff）
    sound: system
    # 自定义音频音量，0–1，仅 afplay 路径生效
    # volume: 0.6
    # 调试日志（默认关闭；开启后写 $DSH_HOME/dsh-ding.log）
    debug: false
```

配置错误会在插件加载时直接失败并给出字段名（不会带病运行）。

## 验证

```sh
# 单元测试（纯逻辑，不发声）
cd dsh-ding && node --test test

# 单独验证系统警示音通路（会真的响一声）
osascript -e beep

# 插件加载与触发记录（config.debug: true 时）
tail -f "$DSH_HOME/dsh-ding.log"
```

端到端验证：安装后在任意顶层会话里让 agent 完成一轮（或调用一次 `ask_user_question`），应听到提示音。

## 卸载

- Web UI 插件页移除 `dsh-ding` 组合包；或
- 删除 profile `package.json` 里 `dsh.profile.bundles` 的 `"dsh-ding"` 与 `dependencies` 的 `dsh-ding`、删除 `node_modules/dsh-ding` 链接，然后重启 DSH。

## 已知限制

- 无法感知 macOS 的「勿扰 / 专注模式」；系统静音时无提示音。
- 声音在 **Host 所在机器** 播放：本机 desktop profile 没问题；若通过远程 Web 连接其他 Host，会响在远端。
- 多开 DSH 实例/多 profile 会各自响。
- Windows（`SystemSounds::Asterisk`）与 Linux（`canberra-gtk-play`）分支未在真实机器上验证；macOS 为当前验证平台。
- 修改插件源码后，因为 `dsh-base` 默认 `hmr.root: []`，不一定会自动重载模块：重新安装、触碰 profile manifest，或重启 DSH。
