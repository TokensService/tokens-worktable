# relay.py — 命令中转工具

一个单文件 Python 脚本，实现 `server`（中转）/ `agent`（client1，命令执行端）/ `ctl`（client2，命令下发端）三种模式。client2 的命令经 server 转发给 client1 执行，执行结果原路返回。

无第三方依赖，Python 3.6+ 即可运行。

> **安全提示**：agent 会以 shell 执行收到的任意命令，仅在受信网络中使用。

## 架构

```
ctl (client2)                server                  agent (client1)
     |   --ctl-port(9002)-->   |   --agent-port(9001)-->  |
     |  {"type":"exec",...}    |   {"type":"exec",...}    |  subprocess 执行
     |                         |                          |
     |  <---result-----------  |  <----result------------ |
```

- server 监听两个端口：`--agent-port`（默认 9001）供 agent 长连接接入，`--ctl-port`（默认 9002）供 ctl 下发命令
- agent 启动时向 server 注册唯一名字，保持长连接，断线自动重连（3 秒间隔）
- ctl 通过 `--target` 指定目标 agent 名字，server 按名字路由
- 每条命令带唯一 `id`，server 用 `pending` 表完成请求-结果配对

## 快速开始

```bash
# 1. 启动 server
python3 relay.py server --agent-port 9001 --ctl-port 9002

# 2. 启动 agent（client1），name 需唯一
python3 relay.py agent --host <server_ip> --port 9001 --name node1

# 3. 下发命令（client2）
python3 relay.py ctl --host <server_ip> --port 9002 --target node1 --cmd "ls -l"

# 交互模式：省略 --cmd，每行一条命令，Ctrl-D 退出
python3 relay.py ctl --host <server_ip> --port 9002 --target node1
```

## 命令参考

### server

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--bind` | `0.0.0.0` | 监听地址 |
| `--agent-port` | `9001` | agent 接入端口 |
| `--ctl-port` | `9002` | ctl 接入端口 |

### agent

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--host` | （必填） | server 地址 |
| `--port` | `9001` | server 的 agent 端口 |
| `--name` | （必填） | agent 唯一名字，重名注册会被拒绝 |

### ctl

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--host` | （必填） | server 地址 |
| `--port` | `9002` | server 的 ctl 端口 |
| `--target` | （必填） | 目标 agent 名字 |
| `--cmd` | 无 | 要执行的命令；省略进入交互模式 |
| `--timeout` | `60` | 命令超时秒数，超时后 agent 侧终止该命令 |

ctl 的退出码即远端命令的真实返回码；连接或路由失败返回 `2`。

## 协议

TCP + JSON Lines（每条消息一行 JSON）：

| 方向 | 消息 |
|---|---|
| agent → server | `{"type":"register","name":N}` |
| | `{"type":"result","id":X,"rc":N,"stdout":S,"stderr":S}` |
| server → agent | `{"type":"registered","name":N}` / `{"type":"error","msg":S}` |
| | `{"type":"exec","id":X,"cmd":S,"timeout":N}` |
| ctl → server | `{"type":"exec","target":N,"cmd":S,"timeout":N}` |
| server → ctl | `{"type":"result",...}` / `{"type":"error","id":X,"msg":S}` |

## 异常处理

- **目标 agent 不在线**：ctl 立即收到 `agent not online` 错误
- **agent 执行中途掉线**：该 agent 所有挂起请求收到 `disconnected` 错误，不会挂死
- **命令超时**：agent 侧终止子进程并回传超时错误；server 侧等待超时后同样报错
- **agent 断线**：自动重连，恢复后可继续接收命令
