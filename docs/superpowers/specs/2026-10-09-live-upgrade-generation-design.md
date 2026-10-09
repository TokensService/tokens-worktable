# tokens-worktable 无重启升级与流水线代际切换设计

## 目标

运行中的 dsh web 进程升级 `tokens-worktable` 后，不重启 dsh 即加载新服务端与客户端实现。升级期间已经进入流水线运行池的任务继续由旧实现完成；新请求和新任务在安全边界上切换到新实现。

## 约束与成功标准

- dsh 进程 PID、HTTP 监听端口、会话树和认证状态不改变。
- 新版本安装必须原子可见；包不完整、版本不匹配或加载失败时继续使用旧版本。
- 每个流水线计划在入池时绑定 generation。旧 generation 进入 draining 后不接收新计划，但其 queued/running 计划继续完成。
- 运行中的 shell、日志流、取消信号、节点租约和历史归档归属原 generation；升级不得 kill 或重建这些对象。
- 新 generation 接管普通 HTTP 路由和客户端资源；旧 generation 的活动响应直到结束仍可写完。
- 客户端资源使用带版本/revision 的 URL，旧页面可继续访问旧资源，刷新后获得新资源。
- 升级切换失败回滚到旧 generation，并提供健康路由可观测的当前版本、generation、draining 状态。

## 架构

### 稳定 supervisor 与可替换 runtime

构建产物拆为稳定入口 `lib/index.js` 和可替换实现 `lib/runtime.js`。入口只持有 supervisor：定位包目录、读取版本元数据、周期检查包文件变化、加载并校验 runtime、创建 generation，以及注册一次性的 HTTP/WS dispatcher。runtime 导出带明确签名的 `createRuntime(ctx, host)`，不直接占用宿主路由表。

supervisor 通过 `globalThis[Symbol.for('tokens-worktable.supervisor')]` 保存跨 Node module reload 的 manager，避免 HMR 或 npm 替换时重复注册路由。新 runtime 加载成功后先完成自检，再注册为 active；旧 runtime 标为 draining，保留其任务上下文并在活动数归零后释放。

### generation host

host 为 runtime 提供受限的 `webServer` 适配器：`register`、`registerUpgrade` 和 `tapIndex` 先登记 generation handler，由 supervisor 的 dispatcher 统一对外注册。普通请求路由到 active generation；已建立的 HTTP/WS 连接由原 handler 持有，不在切换时迁移。路由冲突、handler 抛错和 dispose 都由 host 记录并隔离，不得破坏 supervisor。

### pipeline 代际队列

将 `createPipelineExecutionQueue` 的生命周期显式化：generation 记录 `accepting`、`queued`、`running`、`idle` 状态，计划在 `run` 时写入 generation id。升级执行 `stopAccepting()`，旧池继续 drain queued/running 项；新池只接收新计划。队列查询合并各 generation 的快照并标注 generation，取消按 run id 精确转发到所属池。旧池的 retry timer、计划 tick、节点租约和子进程只在该池完成后清理。

### 客户端版本切换

服务端健康/manifest 响应包含当前版本与 revision。客户端加载插件时把 revision 加入静态资源与模块握手 URL；HMR 或升级事件只触发资源重取和插件级卸载/重装，不刷新整个页面。旧客户端请求仍由 dispatcher 兼容，直到连接结束。

## 升级流程

1. 监听器发现 `package.json` 或 runtime 产物发生变化，读取 staging 文件并校验版本、入口导出和 manifest。
2. 使用带版本查询串的动态 import 加载新 runtime；调用 `createRuntime` 做路由表与依赖自检。
3. supervisor 原子切换 active 指针；旧 generation 进入 draining，停止接收新计划。
4. 广播内部 generation-change 事件，客户端使用新 revision；健康路由返回新版本及旧代 drain 计数。
5. 旧代 queued/running 项完成后调用 generation disposer；超过 drain 观测窗口只记录告警，不杀任务。
6. 任一步失败都不改变 active 指针，并记录失败原因。

## 错误处理

- 安装中间态、半写文件和 JSON 损坏：忽略本次变更，保留旧代。
- 新 runtime 导入或自检失败：回滚，不影响现有连接和流水线。
- 新 runtime 注册单一路由失败：整个新 generation 不可用，释放其已注册的临时 handler。
- 旧代 drain 超时：标记 `drainTimeout`，继续允许任务完成；健康路由暴露计数与最后错误。
- runtime disposer 必须幂等；supervisor 退出时先停止监听器，再等待/释放所有 generation。

## 测试策略

- supervisor：版本变化检测、原子切换、导入失败回滚、重复升级幂等、dispose 清理。
- dispatcher：active 路由、新旧 generation 并存、升级期间长响应和 WS 不被中断、路由冲突隔离。
- pipeline：任务绑定 generation；旧池停止接收新计划但 queued/running 完成；取消、日志、租约和合并快照跨代正确。
- 客户端：revision 变化触发新资源，旧资源仍可加载，失败升级不改变当前版本。
- 全量运行插件现有 `npm test`、`npm run build`、`npm run check`。
