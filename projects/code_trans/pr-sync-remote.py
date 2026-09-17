#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pr-sync-remote.py — tokens-worktable「代码同步」远程执行桥。
由 index.html 通过 /api/worktable/exec-stream 调用（同 pr-sync.py），
stdout 实时流回页面。exec-stream 会把本脚本的每段输出包成
{"type":"out","text":…} 回传，故本脚本只需把远端 pr-sync.py 的原样
stdout 透传，页面已有的 @@PRSYNC@@ 事件解析完全不用改。

用法:
  python3 pr-sync-remote.py <spec-file.json>          # 远程执行 pr-sync.py
  python3 pr-sync-remote.py --test <spec-file.json>   # 仅测试连通 + python3/git

spec 在 pr-sync.py 原有字段之上新增:
  "remote": {
     "name": "构建机A",
     "host": "1.2.3.4", "port": 22,
     "user": "root", "password": "...",
     "dir": "/opt/code-sync"      // 远程工作目录（脚本与 spec 会传到这里）
  }
  // 远程执行时 workDir 应为远端绝对路径（页面会设为 <dir>/work）

前置：本机需有 sshpass / ssh / scp；远端需有 python3 与 git。
流程（sync）:
  1) ssh mkdir -p <dir>
  2) scp pr-sync.py pr-fetch.py -> <dir>/
  3) 通过 ssh stdin 写 spec -> <dir>/sync-spec.json
  4) ssh "cd <dir> && python3 pr-sync.py sync-spec.json"，stdout/stderr 实时透传
  5) 以远端退出码退出（exec-stream 据此发 {type:"done",code}）
  远端非 0 退出时补发一条 @@PRSYNC@@ error 事件，确保页面同步状态复位。
"""
import sys, os, json, subprocess, shlex, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = ("pr-sync.py", "pr-fetch.py")


def out(text):
    """同步模式：向 stdout 写一行（exec-stream 包成 type:out 回传页面）。"""
    if not text:
        return
    if not text.endswith("\n"):
        text += "\n"
    sys.stdout.write(text)
    sys.stdout.flush()


def err(text):
    """测试模式：向 stderr 写（exec-stream 包成 type:err；exec 也不混入 stdout）。"""
    if not text:
        return
    if not text.endswith("\n"):
        text += "\n"
    sys.stderr.write(text)
    sys.stderr.flush()


def emit_event(event, reason):
    """发一条 @@PRSYNC@@ 结构化事件，与 pr-sync.py 同格式，供页面解析。"""
    out("@@PRSYNC@@ " + json.dumps({"event": event, "reason": reason}, ensure_ascii=False))


def ssh_argv(r):
    return ["sshpass", "-p", r.get("password", ""),
            "ssh", "-p", str(r.get("port") or 22),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=30",
            "%s@%s" % (r.get("user", ""), r.get("host", ""))]


def scp_argv(r):
    return ["sshpass", "-p", r.get("password", ""),
            "scp", "-P", str(r.get("port") or 22),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=15"]


def run(cmd, input_text=None):
    return subprocess.run(cmd, input=input_text, capture_output=True, text=True)


def stream(cmd):
    """运行 cmd，stdout+stderr 合并后逐行实时透传到本进程 stdout。返回退出码。"""
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, bufsize=1)
    except FileNotFoundError as e:
        out("启动 SSH 失败：" + str(e))
        emit_event("error", "启动 SSH 失败：" + str(e))
        return 10
    for line in iter(p.stdout.readline, ""):
        sys.stdout.write(line)
        sys.stdout.flush()
    p.stdout.close()
    return p.wait()


def need_tools():
    return [t for t in ("sshpass", "ssh", "scp") if not shutil.which(t)]


def do_test(ssh, host, port, user, rdir, name):
    err("--test: %s (%s@%s:%s -> %s)\n" % (name, user, host, port, rdir))
    # 1) mkdir（验证鉴权 + 目录可建）
    r1 = run(ssh + ["mkdir -p " + shlex.quote(rdir)])
    if r1.returncode != 0:
        print(json.dumps({"ok": False,
                          "error": "mkdir 失败：" + (r1.stderr or r1.stdout).strip(),
                          "host": host, "port": port, "user": user, "dir": rdir},
                         ensure_ascii=False))
        return 3
    # 2) 运行时检查：python3 / git
    chk = run(ssh + ["command -v python3 && command -v git && python3 --version && git --version"])
    o = (chk.stdout or "").strip()
    e = (chk.stderr or "").strip()
    ok = chk.returncode == 0 and "python3" in o and "git" in o
    print(json.dumps({"ok": ok, "host": host, "port": port, "user": user, "dir": rdir,
                      "stdout": o, "stderr": e,
                      "error": "" if ok else "远端缺少 python3 或 git：" + (e or o)},
                     ensure_ascii=False))
    return 0 if ok else 4


def main():
    args = sys.argv[1:]
    test_mode = False
    if args and args[0] == "--test":
        test_mode = True
        args = args[1:]
    if len(args) < 1:
        (err if test_mode else out)("用法: pr-sync-remote.py [--test] <spec.json>")
        return 2

    spec_path = args[0]
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as e:
        msg = "读取 spec 失败：" + str(e)
        if test_mode:
            print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
            return 2
        out(msg)
        emit_event("error", msg)
        return 2

    r = spec.get("remote") or {}
    host = (r.get("host") or "").strip()
    user = (r.get("user") or "").strip()
    port = str(r.get("port") or 22)
    rdir = (r.get("dir") or "").strip()
    name = (r.get("name") or "").strip() or (user + "@" + host if host else "remote")

    if not host or not user or not rdir:
        msg = "远程配置不完整：需 host / user / dir。host=%s user=%s dir=%s" % (host, user, rdir)
        if test_mode:
            print(json.dumps({"ok": False, "error": msg, "host": host, "user": user, "dir": rdir},
                             ensure_ascii=False))
            return 4
        out(msg)
        emit_event("error", msg)
        return 2

    miss = need_tools()
    if miss:
        msg = "本机缺少 SSH 工具：%s（请安装 sshpass / openssh-client）" % " ".join(miss)
        if test_mode:
            print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
            return 5
        out(msg)
        emit_event("error", msg)
        return 5

    ssh = ssh_argv(r)
    scp = scp_argv(r)
    target = "%s@%s:%s/" % (user, host, rdir)

    if test_mode:
        return do_test(ssh, host, port, user, rdir, name)

    # ── sync 模式 ──
    out("── 远程执行：%s（%s@%s:%s -> %s）──" % (name, user, host, port, rdir))

    out("• 确保远程目录存在…")
    r1 = run(ssh + ["mkdir -p " + shlex.quote(rdir)])
    if r1.returncode != 0:
        msg = "远程 mkdir 失败：" + (r1.stderr or r1.stdout).strip()
        out(msg); emit_event("error", msg); return 3

    have = [os.path.join(HERE, s) for s in SCRIPTS if os.path.isfile(os.path.join(HERE, s))]
    if not have:
        msg = "本地未找到 pr-sync.py / pr-fetch.py，无法传输。"
        out(msg); emit_event("error", msg); return 2
    out("• 传输脚本到远程：%s" % " ".join(SCRIPTS))
    r2 = run(scp + have + [target])
    if r2.returncode != 0:
        msg = "传输脚本失败：" + (r2.stderr or r2.stdout).strip()
        out(msg); emit_event("error", msg); return 3

    remote_spec = rdir.rstrip("/") + "/sync-spec.json"
    out("• 传输 spec 到远程：%s" % remote_spec)
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec_content = f.read()
    except Exception as e:
        msg = "读取本地 spec 失败：" + str(e)
        out(msg); emit_event("error", msg); return 2
    r3 = run(ssh + ["cat > " + shlex.quote(remote_spec)], input_text=spec_content)
    if r3.returncode != 0:
        msg = "传输 spec 失败：" + (r3.stderr or r3.stdout).strip()
        out(msg); emit_event("error", msg); return 3

    out("• 远端执行 pr-sync.py（输出实时回流）…\n")
    cmd = ssh + ["cd %s && python3 pr-sync.py sync-spec.json" % shlex.quote(rdir)]
    code = stream(cmd)
    out("── 远端执行结束，exit code %d ──" % code)
    if code != 0:
        emit_event("error", "远端 pr-sync.py 退出码 %d（若上方未输出完成事件，请查看日志排查）" % code)
    return code


if __name__ == "__main__":
    sys.exit(main())
