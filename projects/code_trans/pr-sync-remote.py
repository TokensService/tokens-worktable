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
  python3 pr-sync-remote.py --test <spec-file.json>   # 测试连通 + python3/git + 首次登录
  python3 pr-sync-remote.py --forget <spec-file.json> # 清除本机记住的主机指纹（下次重新接受）

spec 在 pr-sync.py 原有字段之上新增 remote:
  "remote": {
     "name": "构建机A",
     "host": "1.2.3.4", "port": 22,
     "user": "root", "dir": "/opt/code-sync",
     "auth": "password" | "key",          // 认证方式，缺省 password
     "password": "...",                   // auth=password 时用
     "keyContent": "-----BEGIN ...",      // auth=key 时粘贴的私钥 PEM（写到本地临时文件 0600）
     "keyPath": "/root/.ssh/id_rsa",      // auth=key 时也可用本地私钥文件路径（与 keyContent 二选一）
     "keyPass": "..."                     // 私钥口令（可空）；有口令则用 sshpass 供给
  }
  // 远程执行时 workDir 应为远端绝对路径（页面会设为 <dir>/work）

认证：密码用 sshpass；密钥用 -i + IdentitiesOnly/PreferredAuthentications=publickey
（有口令才用 sshpass 供口令，无口令则纯 ssh）。
主机指纹：TOFU —— StrictHostKeyChecking=accept-new + 持久 known_hosts
（~/.cache/tokens-worktable-code-trans/known_hosts，可被 CT_KNOWN_HOSTS 覆盖）：
首次连接自动接受并记入，之后指纹变更则拒绝（提示用 --forget 重置）。

前置：本机需有 ssh / scp / ssh-keygen（密码或密钥口令还需 sshpass）；远端需有 python3 与 git。
流程（sync）:
  1) ssh mkdir -p <dir>            # 首次连接在此触发 accept-new
  2) scp pr-sync.py pr-fetch.py -> <dir>/
  3) 通过 ssh stdin 写 spec -> <dir>/sync-spec.json
  4) ssh "cd <dir> && python3 pr-sync.py sync-spec.json"，stdout/stderr 实时透传
  5) 以远端退出码退出（exec-stream 据此发 {type:"done",code}）
  远端非 0 退出时补发一条 @@PRSYNC@@ error 事件，确保页面同步状态复位。
"""
import sys, os, json, subprocess, shlex, shutil, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = ("pr-sync.py", "pr-fetch.py")
KNOWN_HOSTS = os.environ.get("CT_KNOWN_HOSTS") or os.path.join(
    os.path.expanduser("~"), ".cache", "tokens-worktable-code-trans", "known_hosts")


def out(text):
    """同步模式：向 stdout 写一行（exec-stream 包成 type:out 回传页面）。"""
    if not text:
        return
    if not text.endswith("\n"):
        text += "\n"
    sys.stdout.write(text)
    sys.stdout.flush()


def err(text):
    """测试模式：向 stderr 写（exec-stream 包成 type:err；exec 不混入 stdout）。"""
    if not text:
        return
    if not text.endswith("\n"):
        text += "\n"
    sys.stderr.write(text)
    sys.stderr.flush()


def emit_event(event, reason):
    """发一条 @@PRSYNC@@ 结构化事件，与 pr-sync.py 同格式，供页面解析。"""
    out("@@PRSYNC@@ " + json.dumps({"event": event, "reason": reason}, ensure_ascii=False))


def kh_dir():
    try:
        os.makedirs(os.path.dirname(KNOWN_HOSTS), exist_ok=True)
    except Exception:
        pass


def host_key_token(host, port):
    """known_hosts 的条目键：22 端口为 host，否则 [host]:port。"""
    try:
        p = int(port or 22)
    except Exception:
        p = 22
    return host if p == 22 else "[%s]:%d" % (host, p)


def kh_has(host, port):
    if not os.path.isfile(KNOWN_HOSTS):
        return False
    r = subprocess.run(["ssh-keygen", "-F", host_key_token(host, port), "-f", KNOWN_HOSTS],
                       capture_output=True, text=True)
    return r.returncode == 0


def kh_remove(host, port):
    kh_dir()
    subprocess.run(["ssh-keygen", "-R", host_key_token(host, port), "-f", KNOWN_HOSTS],
                   capture_output=True, text=True)


def write_key_file(content):
    """把粘贴的私钥内容写到临时文件 0600，返回路径；失败返回 None。"""
    try:
        fd, path = tempfile.mkstemp(prefix="ct_key_", suffix=".pem")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content if content.endswith("\n") else content + "\n")
        os.chmod(path, 0o600)
        return path
    except Exception:
        return None


def base_opts():
    """主机指纹：TOFU 接受并记住（accept-new）+ 持久 known_hosts。"""
    kh_dir()
    return ["-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=" + KNOWN_HOSTS,
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=30",
            "-o", "LogLevel=ERROR"]


def build_ctx(r):
    """根据 auth 构造 {pre, opts, keyfile, auth}。pre=ssh/scp 前的前缀（sshpass 或空）；
    opts=附加 ssh/scp 选项；keyfile=临时私钥路径（需调用方清理）或 None。"""
    auth = (r.get("auth") or "password").lower()
    opts = list(base_opts())
    pre = []
    keyfile = None
    if auth == "key":
        opts += ["-o", "IdentitiesOnly=yes", "-o", "PasswordAuthentication=no",
                 "-o", "PreferredAuthentications=publickey", "-o", "PubkeyAuthentication=yes"]
        kc = r.get("keyContent") or ""
        kp = (r.get("keyPath") or "").strip()
        if kc:
            keyfile = write_key_file(kc)
            if not keyfile:
                raise RuntimeError("写入临时私钥文件失败")
        elif kp:
            keyfile = kp
            if not os.path.isfile(keyfile):
                raise RuntimeError("私钥文件不存在：%s" % kp)
        else:
            raise RuntimeError("密钥认证需提供私钥内容（keyContent）或私钥文件路径（keyPath）")
        opts += ["-i", keyfile]
        kpass = r.get("keyPass") or ""
        if kpass:
            pre = ["sshpass", "-p", kpass]
    else:
        pre = ["sshpass", "-p", r.get("password") or ""]
    return {"pre": pre, "opts": opts, "keyfile": keyfile, "auth": auth}


def ssh_argv(r, ctx):
    return ctx["pre"] + ["ssh", "-p", str(r.get("port") or 22)] + ctx["opts"] + \
           ["%s@%s" % (r.get("user", ""), r.get("host", ""))]


def scp_argv(r, ctx):
    return ctx["pre"] + ["scp", "-P", str(r.get("port") or 22)] + ctx["opts"]


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


def need_tools(ctx):
    miss = [t for t in ("ssh", "scp", "ssh-keygen") if not shutil.which(t)]
    if ctx["pre"] and not shutil.which("sshpass"):
        miss.append("sshpass")
    return miss


def hostkey_fail_text(stderr):
    s = (stderr or "")
    if "REMOTE HOST IDENTIFICATION HAS CHANGED" in s or "Host key verification failed" in s \
       or "host key mismatch" in s.lower():
        return "主机指纹已变更或不符（本机已记住旧指纹）。请在「远程服务器」点「重置主机指纹」后重试。"
    return ""


def do_test(r, ctx, ssh):
    host, port, user, rdir = r.get("host", ""), str(r.get("port") or 22), r.get("user", ""), r.get("dir", "")
    before = kh_has(host, port)
    # 1) mkdir（首次连接在此触发 accept-new；指纹变更则在此失败）
    r1 = run(ssh + ["mkdir -p " + shlex.quote(rdir)])
    if r1.returncode != 0:
        hb = hostkey_fail_text(r1.stderr)
        print(json.dumps({"ok": False,
                          "error": hb or ("mkdir 失败：" + (r1.stderr or r1.stdout).strip()),
                          "hostKey": "changed" if hb else "unknown",
                          "auth": ctx["auth"], "host": host, "port": port, "user": user, "dir": rdir},
                         ensure_ascii=False))
        return 3
    after = kh_has(host, port)
    hostkey = "首次接受" if (not before and after) else ("已信任" if before else "未知")
    # 2) 运行时检查：python3 / git
    chk = run(ssh + ["command -v python3 && command -v git && python3 --version && git --version"])
    o = (chk.stdout or "").strip()
    e = (chk.stderr or "").strip()
    ok = chk.returncode == 0 and "python3" in o and "git" in o
    print(json.dumps({"ok": ok, "hostKey": hostkey, "auth": ctx["auth"],
                      "host": host, "port": port, "user": user, "dir": rdir,
                      "stdout": o, "stderr": e,
                      "error": "" if ok else "远端缺少 python3 或 git：" + (e or o)},
                     ensure_ascii=False))
    return 0 if ok else 4


def do_sync(r, ctx, ssh, scp, spec_path):
    host, port, user, rdir = r.get("host", ""), str(r.get("port") or 22), r.get("user", ""), r.get("dir", "")
    name = (r.get("name") or "").strip() or (user + "@" + host if host else "remote")
    before = kh_has(host, port)
    out("── 远程执行：%s（%s@%s:%s -> %s · %s）──" % (name, user, host, port, rdir, ctx["auth"]))

    out("• 确保远程目录存在…")
    r1 = run(ssh + ["mkdir -p " + shlex.quote(rdir)])
    if r1.returncode != 0:
        hb = hostkey_fail_text(r1.stderr)
        msg = hb or ("远程 mkdir 失败：" + (r1.stderr or r1.stdout).strip())
        out(msg); emit_event("error", msg); return 3
    after = kh_has(host, port)
    out("• 主机指纹：%s" % ("首次接受（已记入 known_hosts）" if (not before and after) else "已信任"))

    have = [os.path.join(HERE, s) for s in SCRIPTS if os.path.isfile(os.path.join(HERE, s))]
    if not have:
        msg = "本地未找到 pr-sync.py / pr-fetch.py，无法传输。"
        out(msg); emit_event("error", msg); return 2
    out("• 传输脚本到远程：%s" % " ".join(SCRIPTS))
    r2 = run(scp + have + ["%s@%s:%s/" % (user, host, rdir)])
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


def main():
    args = sys.argv[1:]
    mode = "sync"
    if args and args[0] in ("--test", "--forget"):
        mode = args[0][2:]
        args = args[1:]
    if len(args) < 1:
        (err if mode != "sync" else out)("用法: pr-sync-remote.py [--test|--forget] <spec.json>")
        return 2

    spec_path = args[0]
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as e:
        msg = "读取 spec 失败：" + str(e)
        if mode != "sync":
            print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
            return 2
        out(msg); emit_event("error", msg); return 2

    r = spec.get("remote") or {}
    host = (r.get("host") or "").strip()
    port = str(r.get("port") or 22)
    user = (r.get("user") or "").strip()
    rdir = (r.get("dir") or "").strip()
    name = (r.get("name") or "").strip() or (user + "@" + host if host else "remote")

    # --forget 只需 host/port，不需要认证 / 目录
    if mode == "forget":
        if not host:
            print(json.dumps({"ok": False, "error": "缺少 host"}, ensure_ascii=False)); return 4
        kh_remove(host, port)
        print(json.dumps({"ok": True, "removed": host_key_token(host, port),
                          "knownHosts": KNOWN_HOSTS, "host": host, "port": port},
                         ensure_ascii=False))
        return 0

    if not host or not user or not rdir:
        msg = "远程配置不完整：需 host / user / dir。host=%s user=%s dir=%s" % (host, user, rdir)
        if mode != "sync":
            print(json.dumps({"ok": False, "error": msg, "host": host, "user": user, "dir": rdir},
                             ensure_ascii=False))
            return 4
        out(msg); emit_event("error", msg); return 2

    try:
        ctx = build_ctx(r)
    except Exception as e:
        msg = "认证配置错误：" + str(e)
        if mode != "sync":
            print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False)); return 5
        out(msg); emit_event("error", msg); return 5

    miss = need_tools(ctx)
    if miss:
        msg = "本机缺少 SSH 工具：%s（请安装 openssh-client；密码或密钥口令还需 sshpass）" % " ".join(miss)
        if mode != "sync":
            print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False)); return 5
        out(msg); emit_event("error", msg); return 5

    ssh = ssh_argv(r, ctx)
    scp = scp_argv(r, ctx)
    keyfile = ctx.get("keyfile")
    try:
        if mode == "test":
            return do_test(r, ctx, ssh)
        return do_sync(r, ctx, ssh, scp, spec_path)
    finally:
        if keyfile and (r.get("keyContent") or ""):  # 仅清理粘贴内容写的临时文件，不动用户指定路径
            try:
                os.remove(keyfile)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
