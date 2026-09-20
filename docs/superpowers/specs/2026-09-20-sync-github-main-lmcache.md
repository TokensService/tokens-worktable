# GitHub Main LMCache 同步规格

## 目标

将 `TokensService/tokens-worktable` GitHub `main` 中 PR #47 的 LMCache 渲染逻辑同步到 GitCode `TokensService/op_test` 的 `dev4`，随后在新逻辑上保留并验证既有的 8 卡 Decode 节点隔离行为。

## 必须保持的行为

- `ENABLE_LMCACHE` 独立控制 LMCache sidecar，默认 `false`。
- `ENABLE_LMCACHE_TRACING` 默认 `true`，并可用 `LMCACHE_OTLP_ENDPOINT` 配置 OTLP 地址。
- `LMCACHE_L2_ENABLED` 默认 `true`。
- 上述变量写入本机和目标机的 pipeline 环境文件。
- 渲染器只覆盖 LMCache 的启用、日志级别与 L2 开关；其余 sidecar 默认参数由模板维护。
- tracing 参数只在开关打开且 endpoint 非空时注入，重复渲染不能重复注入。
- 当任一 Decode TE 使用 8 张 GPU 时，`TARGET_HOSTS[0]` 标记为 Decode 节点，其余目标节点标记为 Prefill 节点；两类 TE 使用不同的 `xds.optest/te-role` 选择器。
- 单节点 GPU 固定和多节点通用逻辑遵循 PR #47 的精简实现，不恢复已被 PR #47 删除的 LMCache renderer GPU 对齐逻辑。
- 保留 GitCode `dev4` 已有的远程部署、映射 IP、XDS URL 和模板自动发现修复。

## 审计范围

列出 GitHub `main` 的全部已合并 PR，并以最近一次完整 GitCode 同步 PR 为检查点，结合最终文件/特征比对，指出尚未进入 GitCode `dev4` 的 PR。审计结果写入提交说明或最终交付报告；本次只自动同步 PR #47 及其所需调度回补，其他缺失 PR 不擅自合入。

## 审计结果（2026-09-20）

GitHub `main` 共枚举到 31 个 merged PR。PR #36 和 #48 是从 GitCode `dev4` 向 GitHub 的显式批量同步检查点，因此其覆盖的 pipeline/deploy 改动，以及被后续版本取代的同类修复，视为已经覆盖：#3、#4、#6、#13、#16、#18、#24、#25、#31、#32、#33、#34、#36、#48。#34 的第一父差异为空，实际行为由 #33 及后续映射 URL 修复覆盖。

本次同步后，PR #47 的 4 个文件与 GitHub `main` 最终内容等价，同时保留 GitCode 的 `xds.optest/te-role` 调度扩展。

以下 GitHub 主线能力没有完整回流到 GitCode `dev4`：

- #49：`clear-lmcache-cache.sh` 及其测试均不存在。
- #51：`code_trans` 项目、远程 PR 同步脚本和相关测试不存在。
- #52：插件版本历史功能及测试不存在；GitCode 插件版本仍为 `0.2.2`，GitHub 为 `1.1.8`。
- #1、#2、#5、#7、#9、#10、#14、#20、#23、#29、#30、#35、#45：这些是 GitHub 工作台 UI、插件发布、队列/历史、并行任务、代码转换等主线改动。最终树比对显示对应测试、项目或发布文件在 GitCode 中缺失，或同名文件已经分叉，不能认定为完整同步。

本次按用户范围只合入 #47 和调度回补；上列其他 PR 留作独立同步，避免把大批 UI/插件变更夹带进 LMCache 提交。
