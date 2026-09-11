# 流水线性能加固实施计划

> 对应设计：`docs/superpowers/specs/2026-09-11-pipeline-performance-hardening-design.md`

1. 在页面日志缩放测试中加入分片尾窗、最终结果有界、增量变量解析和 Prometheus DOM 有界的失败用例；实现并复测。
2. 在页面队列测试中加入 4 个全局槽位与完成后排空的失败用例；实现并复测。
3. 在服务端流水线 API/计划测试中加入共享执行池、流式脚本尾窗及完整磁盘日志的失败用例；实现并复测。
4. 新增代理响应限额测试，覆盖 `Content-Length` 和 chunked 响应；实现读取中止。
5. 扩展历史缓存测试，验证最新记录裁剪和单次序列化；抽取共享线性序列化 helper 并替换两处循环。
6. 扩展归档测试，验证 rejected Promise 清理和失败消费；实现有界错误登记。
7. 更新 `CHANGES.md`，运行目标测试、全量 `npm test`、构建与产物语法检查。
8. 请求现有审查 agent 复核变更；修正后提交 feature 分支，更新本地 `dev`、再次验证并推送 `origin/dev`。
