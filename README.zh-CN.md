# pi-timeout-policy

[English](README.md) | 简体中文

为 Pi 的前台工具提供统一的超时策略。在 Pi 1.3 和 1.4 中，`bash` 的超时参数是可选的且没有默认值，`grep` 和 `find` 则完全没有超时参数，任何一条卡住的命令都会让 agent 无限期等待。安装本插件后：

> **未指定超时：60 秒。需要运行更久的命令：显式指定超时，上限 7200 秒（2 小时）。**
> **当前回合不需要输出的命令：放进后台任务执行。需要比 Pi 存活更久的任务：交给 systemd 或 tmux。**

```text
bash(command="rg foo .")                     -> 60s
bash(command="cargo test", timeout=1800)    -> 1800s
bash(command="sleep 1", timeout=7201)       -> 拒绝
grep(pattern="foo", path=".")               -> 60s
grep(pattern="foo", path=".", timeout=600) -> 600s
```

## 为什么这样设计

- **只加超时策略，不替换 bash。** 插件不替换内置的 `bash`，只在现有负责前台执行的工具之上叠加超时规则，因此 shell 设置、自定义渲染器、spawn 钩子和其他 bash 扩展都能照常工作。
- **每次前台等待都有上限。** 前台调用不再允许无限超时。耗时较长的工作，要么显式申请不超过 2 小时的时间预算，要么通过 [pi-background-job](https://github.com/GhabiX/pi-background-job) 放到后台执行。
- **模型直接看到规则。** 工具 schema 中明确写出默认值和上限，超出范围的参数在执行前就会被 schema 校验直接拒绝。

## 特性

- `bash` 和 `powershell`：未传超时参数时默认设为 60 秒；显式传入的值必须在 `(0, 7200]` 区间内。
- `grep` 和 `find`：新增遵循同一规则的 `timeout` 参数。
- 安装本包不会开启 `grep` 或 `find`，当前启用的工具集合保持不变。
- 会话结束时自动还原对 schema 的修改，且仅还原仍保持本插件写入值的字段。

## 安装

```sh
pi install npm:@spinetree/pi-timeout-policy
```

Pi 已经在运行的话，重启它或执行 `/reload`。

不安装，仅在当前会话中试用：

```sh
pi -e npm:@spinetree/pi-timeout-policy
```

## 原理

Pi 没有提供原地包装某个工具当前实现的接口，因此覆盖层（overlay）针对两类工具采用不同的适配方式：

- **原生超时对齐**（`bash`、`powershell`）：Pi 原生已提供 `timeout` 参数。`session_start` 时，插件将实时 schema 对齐到本策略：单位为秒，范围 `0 < timeout <= 7200`，并在参数描述中注明运行时默认 60 秒。`session_shutdown` 时，仅恢复仍保持本插件写入值的字段，既不会让后续会话继承这次修改，也不会覆盖第三方扩展对 schema 的改动。调用时若未传超时，由 `tool_call` 钩子自动补上 `60`；超出 `(0, 7200]` 的值在钩子执行前即被 schema 校验拒绝。实际执行仍由原来的工具实现负责，shell 设置、渲染器、spawn 钩子和其他 bash 扩展均不受影响。
- **信号包装**（`grep`、`find`）：原生 schema 没有超时字段。`session_start` 时，覆盖层为其加上 `timeout?: number`，底层委托给 Pi 公开的工具工厂函数，让原实现的完成与截止时间赛跑。到达截止时间后立即让调用方返回，同时通过截止时触发的 `AbortSignal` 通知原实现终止子进程并完成清理。由于底层清理是协作式的而非强制杀进程，原实现可能在后台稍晚才彻底结束。注册发生在默认启用工具集确定之后，并立即恢复原有的启用集合，因此安装本包**不会**自动开启 grep/find。

合法范围内的显式正数超时会原样保留。上层传入的取消信号仍按取消处理，不会被当成超时。

前台超时的上限为 7200 秒（2 小时）；Node 定时器的上限（约 24.8 天）不能作为合理的等待预算。`timeout <= 0` 一律视为无效参数。

## 限制

- Pi 中同名的扩展工具遵循先注册者生效原则。若没有更早的扩展注册同名工具，本覆盖层可正常包装内置工具；若已有更早的同名覆盖，则无法继续叠加。
- 对于 `grep` 和 `find`，到达截止时间后 agent 会立即恢复执行，但停止底层搜索进程仍依赖协作式清理。

## 兼容性

已在 Pi 1.3.0 和 1.4.0、Node 22.23 下测试通过。要求 Node >= 22.19。Pi 相关包均声明为 `"*"` peer dependencies。

## 开发

```sh
npm test          # 超时规则和覆盖层辅助函数
npm run test:e2e  # 通过 PATH 上的 pi 加载插件
```

## @spinetree 的其他插件

- [pi-background-job](https://github.com/GhabiX/pi-background-job)：后台任务与输出监视，事件发生时自动通知 agent。
- [pi-btw-cached](https://github.com/GhabiX/pi-btw-cached)：在主会话自己的请求上发起 `/btw` 侧问。
- [pi-compact-tree](https://github.com/GhabiX/pi-compact-tree)：Pi 终端界面的紧凑过程树视图。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
