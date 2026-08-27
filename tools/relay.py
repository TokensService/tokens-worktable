#!/usr/bin/env python3
"""relay.py - 命令中转工具

三种模式:
  server  中转服务, 监听两个端口: agent 端口(client1 接入), ctl 端口(client2 接入)
  agent   即 client1, 连接 server 保持长连接, 接收并执行命令, 回传结果
  ctl     即 client2, 连接 server 下发命令给指定 agent, 打印返回结果

协议: TCP + JSON Lines(每条消息一行 JSON)
  agent -> server: {"type": "register", "name": N}
                   {"type": "result", "id": X, "rc": N, "stdout": S, "stderr": S}
  server -> agent: {"type": "registered", "name": N} / {"type": "error", ...}
                   {"type": "exec", "id": X, "cmd": S, "timeout": N}
  ctl   -> server: {"type": "exec", "target": N, "cmd": S, "timeout": N}
  server -> ctl:   {"type": "result", ...} / {"type": "error", "msg": S}

注意: agent 会以 shell 执行任意命令, 仅在受信网络中使用。
"""

import argparse
import json
import socket
import subprocess
import sys
import threading
import time
import uuid

DEFAULT_AGENT_PORT = 9001
DEFAULT_CTL_PORT = 9002
DEFAULT_TIMEOUT = 60
RECONNECT_INTERVAL = 3


def send_msg(sock, obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n"
    sock.sendall(data)


def recv_msg(rfile):
    """从缓冲读流读一行 JSON, 连接关闭返回 None。"""
    line = rfile.readline()
    if not line:
        return None
    return json.loads(line.decode("utf-8"))


# ---------------------------------------------------------------- server

class RelayServer:
    def __init__(self, host, agent_port, ctl_port):
        self.host = host
        self.agent_port = agent_port
        self.ctl_port = ctl_port
        self.lock = threading.Lock()
        self.agents = {}    # name -> (sock, send_lock)
        self.pending = {}   # cmd_id -> {"sock", "lock", "agent", "done"}

    def log(self, msg):
        print(f"[server] {msg}", flush=True)

    def serve(self):
        threading.Thread(target=self._listen,
                         args=(self.agent_port, self._handle_agent, "agent"),
                         daemon=True).start()
        threading.Thread(target=self._listen,
                         args=(self.ctl_port, self._handle_ctl, "ctl"),
                         daemon=True).start()
        self.log(f"agent port: {self.agent_port}, ctl port: {self.ctl_port}")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass

    def _listen(self, port, handler, tag):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self.host, port))
        srv.listen(16)
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=handler, args=(conn, addr), daemon=True).start()

    # ---- agent 侧 (client1) ----

    def _handle_agent(self, sock, addr):
        name = None
        try:
            rfile = sock.makefile("rb")
            msg = recv_msg(rfile)
            if not msg or msg.get("type") != "register" or not msg.get("name"):
                return
            name = str(msg["name"])
            send_lock = threading.Lock()
            with self.lock:
                if name in self.agents:
                    send_msg(sock, {"type": "error",
                                    "msg": f"name {name!r} already registered"})
                    return
                self.agents[name] = (sock, send_lock)
            send_msg(sock, {"type": "registered", "name": name})
            self.log(f"agent {name!r} online from {addr[0]}:{addr[1]}")

            while True:
                msg = recv_msg(rfile)
                if msg is None:
                    break
                if msg.get("type") == "result":
                    self._dispatch_result(msg)
        except (OSError, json.JSONDecodeError):
            pass
        finally:
            self._drop_agent(name, sock)

    def _dispatch_result(self, msg):
        cid = msg.get("id")
        with self.lock:
            entry = self.pending.pop(cid, None)
        if entry is None:
            return
        try:
            with entry["lock"]:
                send_msg(entry["sock"], msg)
        except OSError:
            pass
        entry["done"].set()

    def _drop_agent(self, name, sock):
        if name is None:
            return
        with self.lock:
            if self.agents.get(name, (None,))[0] is sock:
                del self.agents[name]
                gone = name
            else:
                gone = None
            # 该 agent 的挂起请求全部失败(具体清理在锁外进行)
            failed = [cid for cid, e in self.pending.items()
                      if gone and e["agent"] == name]
        if gone:
            self.log(f"agent {gone!r} offline")
            for cid in failed:
                self._fail_pending(cid, f"agent {name!r} disconnected")
        try:
            sock.close()
        except OSError:
            pass

    def _fail_pending(self, cid, errmsg):
        with self.lock:
            entry = self.pending.pop(cid, None)
        if entry is None:
            return
        try:
            with entry["lock"]:
                send_msg(entry["sock"], {"type": "error", "id": cid, "msg": errmsg})
        except OSError:
            pass
        entry["done"].set()

    # ---- ctl 侧 (client2) ----

    def _handle_ctl(self, sock, addr):
        try:
            rfile = sock.makefile("rb")
            msg = recv_msg(rfile)
            if not msg or msg.get("type") != "exec":
                return
            target = str(msg.get("target", ""))
            cmd = str(msg.get("cmd", ""))
            try:
                timeout = max(1, int(msg.get("timeout", DEFAULT_TIMEOUT)))
            except (TypeError, ValueError):
                timeout = DEFAULT_TIMEOUT
            cid = uuid.uuid4().hex[:8]

            done = threading.Event()
            entry = {"sock": sock, "lock": threading.Lock(),
                     "agent": target, "done": done}
            with self.lock:
                agent_entry = self.agents.get(target)
                if agent_entry:
                    self.pending[cid] = entry
            if not agent_entry:
                send_msg(sock, {"type": "error", "id": cid,
                                "msg": f"agent {target!r} not online"})
                return

            asock, alock = agent_entry
            try:
                with alock:
                    send_msg(asock, {"type": "exec", "id": cid,
                                     "cmd": cmd, "timeout": timeout})
            except OSError:
                self._fail_pending(cid, f"send to agent {target!r} failed")
                return
            self.log(f"exec {cid} -> {target!r}: {cmd!r} (from {addr[0]})")

            # 等 agent 线程把结果写回来; 超时则报错
            if not done.wait(timeout + 5):
                self._fail_pending(cid,
                                   f"timeout after {timeout}s waiting for result")
        except (OSError, json.JSONDecodeError):
            pass
        finally:
            try:
                sock.close()
            except OSError:
                pass


def run_server(args):
    RelayServer(args.bind, args.agent_port, args.ctl_port).serve()


# ---------------------------------------------------------------- agent

def exec_and_reply(sock, send_lock, cid, cmd, timeout):
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True,
                              text=True, timeout=timeout)
        result = {"type": "result", "id": cid, "rc": proc.returncode,
                  "stdout": proc.stdout, "stderr": proc.stderr}
    except subprocess.TimeoutExpired as e:
        result = {"type": "result", "id": cid, "rc": -1,
                  "stdout": e.stdout if isinstance(e.stdout, str) else "",
                  "stderr": f"command timed out after {timeout}s"}
    except Exception as e:  # noqa: BLE001 - 任何执行错误都要回传
        result = {"type": "result", "id": cid, "rc": -1,
                  "stdout": "", "stderr": f"exec error: {e}"}
    try:
        with send_lock:
            send_msg(sock, result)
    except OSError:
        pass


def run_agent(args):
    send_lock = threading.Lock()
    while True:
        sock = None
        try:
            sock = socket.create_connection((args.host, args.port), timeout=10)
            sock.settimeout(None)
            send_msg(sock, {"type": "register", "name": args.name})
            rfile = sock.makefile("rb")
            msg = recv_msg(rfile)
            if msg is None:
                raise ConnectionError("server closed connection")
            if msg.get("type") == "error":
                print(f"[agent] register failed: {msg.get('msg')}", flush=True)
                sys.exit(1)
            print(f"[agent] registered as {args.name!r} "
                  f"on {args.host}:{args.port}", flush=True)

            while True:
                msg = recv_msg(rfile)
                if msg is None:
                    raise ConnectionError("server closed connection")
                if msg.get("type") == "exec":
                    threading.Thread(
                        target=exec_and_reply,
                        args=(sock, send_lock, msg["id"], msg["cmd"],
                              int(msg.get("timeout", DEFAULT_TIMEOUT))),
                        daemon=True).start()
        except KeyboardInterrupt:
            raise
        except (OSError, ConnectionError, json.JSONDecodeError) as e:
            print(f"[agent] connection lost ({e}), "
                  f"reconnecting in {RECONNECT_INTERVAL}s...", flush=True)
            time.sleep(RECONNECT_INTERVAL)
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass


# ---------------------------------------------------------------- ctl

def ctl_exec(args, cmd):
    try:
        sock = socket.create_connection((args.host, args.port), timeout=10)
    except OSError as e:
        print(f"connect server failed: {e}", file=sys.stderr)
        return 2
    try:
        send_msg(sock, {"type": "exec", "target": args.target,
                        "cmd": cmd, "timeout": args.timeout})
        sock.settimeout(args.timeout + 15)
        msg = recv_msg(sock.makefile("rb"))
        if msg is None:
            print("server closed connection without reply", file=sys.stderr)
            return 2
        if msg.get("type") == "error":
            print(f"error: {msg.get('msg')}", file=sys.stderr)
            return 2
        if msg.get("stdout"):
            print(msg["stdout"], end="")
        if msg.get("stderr"):
            print(msg["stderr"], end="", file=sys.stderr)
        return msg.get("rc", 1) if isinstance(msg.get("rc"), int) else 1
    except (OSError, json.JSONDecodeError) as e:
        print(f"request failed: {e}", file=sys.stderr)
        return 2
    finally:
        try:
            sock.close()
        except OSError:
            pass


def run_ctl(args):
    if args.cmd is not None:
        sys.exit(ctl_exec(args, args.cmd))
    # 交互模式: 每行一条命令, 每次新建短连接
    print(f"[ctl] target={args.target!r} via {args.host}:{args.port}, "
          f"输入命令执行, Ctrl-D/Ctrl-C 退出", flush=True)
    while True:
        try:
            cmd = input(f"{args.target}> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if cmd:
            ctl_exec(args, cmd)


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description="命令中转工具: server / agent / ctl")
    sub = p.add_subparsers(dest="mode", required=True)

    sp = sub.add_parser("server", help="中转服务 (监听 agent 与 ctl 两个端口)")
    sp.add_argument("--bind", default="0.0.0.0", help="监听地址")
    sp.add_argument("--agent-port", type=int, default=DEFAULT_AGENT_PORT)
    sp.add_argument("--ctl-port", type=int, default=DEFAULT_CTL_PORT)
    sp.set_defaults(func=run_server)

    sp = sub.add_parser("agent", help="client1: 接入 server, 执行命令")
    sp.add_argument("--host", required=True, help="server 地址")
    sp.add_argument("--port", type=int, default=DEFAULT_AGENT_PORT,
                    help="server 的 agent 端口")
    sp.add_argument("--name", required=True, help="agent 唯一名字")
    sp.set_defaults(func=run_agent)

    sp = sub.add_parser("ctl", help="client2: 通过 server 向 agent 下发命令")
    sp.add_argument("--host", required=True, help="server 地址")
    sp.add_argument("--port", type=int, default=DEFAULT_CTL_PORT,
                    help="server 的 ctl 端口")
    sp.add_argument("--target", required=True, help="目标 agent 名字")
    sp.add_argument("--cmd", help="要执行的命令; 省略则进入交互模式")
    sp.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                    help="命令超时秒数")
    sp.set_defaults(func=run_ctl)

    args = p.parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
