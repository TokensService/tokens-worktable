#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pr-sync.py — tokens-worktable「代码同步」窗口的服务端 PR 同步器。
由 index.html 通过 /api/worktable/exec-stream 调用，stdout 实时流回页面。

用法:
  python3 pr-sync.py <spec-file.json>

spec 结构:
{
  "source": {"platform":"github|gitlab|gitee|gitcode","repo":"owner/repo","token":"..."},
  "target": {"platform":"...","repo":"...","token":"...","baseBranch":"main"},
  "workDir": "/abs/path",            // 克隆存放目录（可复用）
  "branchPrefix": "sync",            // 目标分支前缀
  "dryRun": false,                   // true=只做 cherry-pick 自检，不 push / 不开 PR
  "keepClone": true,                 // 保留克隆以便复用
  "prs": [ <归一化 PR 对象, 来自 pr-fetch.py list> , ... ]
}

流程（每个源 PR 独立 try/except）:
  1) 复用/初始化目标仓克隆 -> fetch 刷新
  2) 从 origin/<baseBranch> 建分支 <prefix>/<platform>-<number>
  3) git fetch 源仓 headRef / baseRef 拿到提交对象
  4) cherry-pick merge-base(base,head)..head
  5) push 分支到目标仓
  6) 调用目标平台 API 创建 PR/MR

结构化事件以 `@@PRSYNC@@ ` 前缀的 JSON 行输出，便于页面解析；
git 自身输出直接透传，作为日志显示。
"""
import sys, os, json, subprocess, urllib.request, urllib.parse, urllib.error, re

UA = "tokens-worktable-pr-sync/1.0"
GIT_BIN = os.environ.get("GIT_BIN") or "git"


def normalize_repo(s):
    """把用户输入归一化为 owner/repo（GitLab 可为 group/subgroup/project）。
    接受 owner/repo、https://host/owner/repo(.git)、git@host:owner/repo(.git) 等。"""
    s = (s or "").strip()
    if not s:
        return ""
    m = re.match(r"^git@[^:]+:(.+)$", s)
    if m:
        s = m.group(1)
    elif "://" in s:
        try:
            s = urllib.parse.urlparse(s).path.lstrip("/")
        except Exception:
            pass
    s = re.sub(r"\.git$", "", s, flags=re.I)
    s = s.strip("/")
    return s


def emit(obj):
    """结构化事件行。"""
    sys.stdout.write("@@PRSYNC@@ " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(text):
    if text:
        if not text.endswith("\n"):
            text += "\n"
        sys.stdout.write(text)
        sys.stdout.flush()


def git(args, cwd, capture=False, check=False, allow_fail=False):
    """运行 git。capture=True 时不透传输出并返回文本；否则透传到页面。"""
    full = [GIT_BIN] + args
    if capture:
        r = subprocess.run(full, cwd=cwd, capture_output=True, text=True)
        if check and r.returncode != 0:
            raise RuntimeError("git %s 失败: %s" % (" ".join(args), (r.stderr or r.stdout).strip()[:400]))
        return r
    r = subprocess.run(full, cwd=cwd)
    if check and r.returncode != 0 and not allow_fail:
        raise RuntimeError("git %s 失败 (exit %d)" % (" ".join(args), r.returncode))
    return r


def inject_token(url, token, platform):
    """把令牌注入 https git URL；ssh URL 原样返回。"""
    if not token:
        return url
    if url.startswith("git@") or url.startswith("ssh://") or url.startswith("ssh+git://"):
        return url
    if not url.startswith("https://") and not url.startswith("http://"):
        return url
    m = re.match(r"(https?://)([^/]*@)?(.+)", url)
    if not m:
        return url
    proto, _auth, rest = m.group(1), m.group(2), m.group(3)
    # 用户名按平台约定
    user = {"github": "x-access-token", "gitlab": "oauth2", "gitee": "oauth2", "gitcode": "oauth2"}.get(platform, "oauth2")
    token_q = urllib.parse.quote(token, safe="")
    return "%s%s:%s@%s" % (proto, user, token_q, rest)


def api_call(url, token, platform, method="POST", data=None, accept="application/json"):
    r = urllib.request.Request(url, method=method)
    r.add_header("User-Agent", UA)
    r.add_header("Accept", accept)
    if token:
        if platform in ("gitlab", "gitcode"):
            # GitLab v4 与 GitCode v5 均用 PRIVATE-TOKEN 鉴权
            r.add_header("PRIVATE-TOKEN", token)
        elif platform == "gitee":
            r.add_header("Authorization", "Bearer " + token)
        else:
            r.add_header("Authorization", "Bearer " + token)
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        r.data = body
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
            ct = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        raise RuntimeError("HTTP %d: %s" % (e.code, raw[:500]))
    except urllib.error.URLError as e:
        raise RuntimeError("网络错误: %s" % e)
    if "json" in ct:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return raw


def open_pr(platform, target_repo, token, branch, base_branch, title, body):
    """在目标仓创建 PR/MR，返回 (url, number)。"""
    title = title or ("sync: " + branch)
    body_txt = body or ""
    if platform == "github":
        url = "https://api.github.com/repos/" + target_repo + "/pulls"
        d = api_call(url, token, "github", method="POST",
                     data={"title": title, "head": branch, "base": base_branch, "body": body_txt})
        return d.get("html_url"), d.get("number")
    if platform == "gitlab":
        pid = urllib.parse.quote(target_repo, safe="")
        url = "https://gitlab.com/api/v4/projects/" + pid + "/merge_requests"
        d = api_call(url, token, "gitlab", method="POST",
                     data={"source_branch": branch, "target_branch": base_branch,
                           "title": title, "description": body_txt})
        return d.get("web_url"), d.get("iid")
    if platform == "gitee":
        url = "https://gitee.com/api/v5/repos/" + target_repo + "/pulls"
        # Gitee 创建 PR 需要 access_token；同时放 header 和 query 更稳
        url = url + "?" + urllib.parse.urlencode({"access_token": token})
        d = api_call(url, token, "gitee", method="POST",
                     data={"title": title, "head": branch, "base": base_branch, "body": body_txt})
        return d.get("html_url"), d.get("number")
    if platform == "gitcode":
        # GitCode v5（Gitee 兼容）：创建 PR，官方要求 access_token 入 query
        url = "https://api.gitcode.com/api/v5/repos/" + target_repo + "/pulls"
        url = url + "?" + urllib.parse.urlencode({"access_token": token})
        d = api_call(url, token, platform, method="POST",
                     data={"title": title, "head": branch, "base": base_branch, "body": body_txt})
        return d.get("html_url") or d.get("web_url"), d.get("number") or d.get("iid")
    raise RuntimeError("不支持的目标平台: " + str(platform))


def ensure_clone(target, work_dir):
    """复用或新建目标仓克隆；返回克隆目录路径。"""
    platform = target["platform"]
    repo = target["repo"]
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", "%s-%s" % (platform, repo)).strip("-") or "target"
    clone_dir = os.path.join(work_dir, safe)
    clone_url = "https://%s.com/%s.git" % (
        "github" if platform == "github" else ("gitlab" if platform == "gitlab" else ("gitcode" if platform == "gitcode" else "gitee")), repo)
    auth_url = inject_token(clone_url, target.get("token"), platform)
    if os.path.isdir(os.path.join(clone_dir, ".git")):
        emit({"event": "clone", "status": "refresh", "dir": clone_dir})
        git(["remote", "set-url", "origin", auth_url], clone_dir, capture=True, check=True)
        git(["fetch", "--quiet", "origin", "--prune"], clone_dir)
        return clone_dir
    os.makedirs(work_dir, exist_ok=True)
    emit({"event": "clone", "status": "cloning", "dir": clone_dir, "url": clone_url})
    r = git(["clone", "--quiet", auth_url, clone_dir], cwd=work_dir)
    if r.returncode != 0:
        raise RuntimeError("克隆目标仓失败 (exit %d)，请检查令牌与网络" % r.returncode)
    return clone_dir


def sync_one(pr, ctx):
    """同步单个源 PR 到目标仓。返回 dict 结果。"""
    clone_dir = ctx["clone_dir"]
    target = ctx["target"]
    platform = pr["platform"]
    number = pr["number"]
    base_branch = target.get("baseBranch") or "main"
    prefix = ctx.get("branchPrefix", "sync")
    branch = "%s/%s-%s" % (prefix, platform, number)

    emit({"event": "pr_begin", "number": number, "title": pr.get("title", ""),
          "branch": branch, "source": "%s/%s" % (platform, pr.get("sourceBranch"))})

    # 回到 base 分支并清理同名旧分支
    git(["checkout", "--quiet", "origin/" + base_branch], clone_dir, capture=True, check=True)
    try:
        git(["branch", "-D", branch], clone_dir, capture=True, allow_fail=True)
    except Exception:
        pass
    git(["checkout", "--quiet", "-b", branch, "origin/" + base_branch], clone_dir, capture=True, check=True)

    # 抓取源仓提交对象（head + base）
    src_token = ctx.get("sourceToken")
    src_url = inject_token(pr.get("sourceCloneUrl"), src_token, platform)
    base_url = inject_token(pr.get("baseCloneUrl"), src_token, platform)
    head_ref = pr.get("headRef")
    base_ref = pr.get("baseRef")
    # 抓 head
    r = git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", src_url, head_ref], clone_dir, capture=True)
    if r.returncode != 0:
        raise RuntimeError("抓取源 PR head 失败: %s" % r.stderr.strip()[:300])
    head_sha = (pr.get("headSha") or git(["rev-parse", "FETCH_HEAD"], clone_dir, capture=True, check=True).stdout.strip())
    # 抓 base
    r = git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", base_url, base_ref], clone_dir, capture=True)
    if r.returncode != 0:
        raise RuntimeError("抓取源 base 失败: %s" % r.stderr.strip()[:300])
    base_sha = (pr.get("baseSha") or git(["rev-parse", "FETCH_HEAD"], clone_dir, capture=True, check=True).stdout.strip())

    # 计算需要 cherry-pick 的提交范围
    mb = git(["merge-base", base_sha, head_sha], clone_dir, capture=True).stdout.strip()
    if not mb:
        mb = base_sha
    if mb == head_sha:
        emit({"event": "pr_fetch", "ok": True, "head": head_sha[:8], "base": base_sha[:8], "commits": 0})
        emit({"event": "pr_done", "number": number, "ok": True, "reason": "空范围（无新提交），跳过", "url": None})
        return {"number": number, "ok": True, "skipped": True}
    # 统计提交数
    cnt = git(["rev-list", "--count", mb + ".." + head_sha], clone_dir, capture=True).stdout.strip()
    emit({"event": "pr_fetch", "ok": True, "head": head_sha[:8], "base": base_sha[:8], "mb": mb[:8], "commits": int(cnt or 0)})

    # cherry-pick 范围（空提交也允许，便于重跑）
    r = git(["cherry-pick", "--allow-empty", "--no-edit", "%s..%s" % (mb, head_sha)], clone_dir)
    if r.returncode != 0:
        detail = ""
        try:
            st = git(["status", "--short"], clone_dir, capture=True).stdout.strip()
            detail = st[:400]
        except Exception:
            pass
        git(["cherry-pick", "--abort"], clone_dir, allow_fail=True)
        raise RuntimeError("cherry-pick 冲突，已中止: %s" % detail)
    emit({"event": "pr_cherry", "ok": True})

    if ctx.get("dryRun"):
        emit({"event": "pr_done", "number": number, "ok": True, "reason": "dry-run：已 cherry-pick，未 push/开 PR", "url": None, "branch": branch})
        return {"number": number, "ok": True, "dryRun": True, "branch": branch}

    # push 分支到目标仓
    target_platform = target["platform"]
    push_url = inject_token(
        "https://%s.com/%s.git" % (
            "github" if target_platform == "github" else ("gitlab" if target_platform == "gitlab" else ("gitcode" if target_platform == "gitcode" else "gitee")),
            target["repo"]),
        target.get("token"), target_platform)
    r = git(["push", "--quiet", push_url, "HEAD:refs/heads/" + branch], clone_dir, capture=True)
    if r.returncode != 0:
        raise RuntimeError("push 失败: %s" % r.stderr.strip()[:300])
    emit({"event": "pr_push", "ok": True, "branch": branch})

    # 创建目标 PR/MR
    url, new_num = open_pr(target_platform, target["repo"], target.get("token"),
                           branch, base_branch, "sync[%s #%s]: %s" % (platform, number, pr.get("title", "")),
                           (pr.get("body") or "") + "\n\n---\n_synced from %s #%s_" % (platform, number))
    emit({"event": "pr_open", "ok": True, "url": url, "number": new_num})
    emit({"event": "pr_done", "number": number, "ok": True, "url": url, "targetNumber": new_num, "branch": branch})
    return {"number": number, "ok": True, "url": url, "targetNumber": new_num, "branch": branch}


def main():
    if len(sys.argv) < 2:
        emit({"event": "error", "reason": "缺少 spec 文件路径"})
        sys.exit(2)
    spec_path = sys.argv[1]
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as e:
        emit({"event": "error", "reason": "spec 读取失败: %s" % e})
        sys.exit(2)

    target = spec.get("target") or {}
    if target.get("repo"):
        target["repo"] = normalize_repo(target["repo"])
    src = spec.get("source") or {}
    if src.get("repo"):
        src["repo"] = normalize_repo(src["repo"])
    prs = spec.get("prs") or []
    work_dir = spec.get("workDir") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
    work_dir = os.path.abspath(work_dir)
    ctx_base = {
        "target": target,
        "sourceToken": (spec.get("source") or {}).get("token"),
        "branchPrefix": spec.get("branchPrefix", "sync"),
        "dryRun": bool(spec.get("dryRun", False)),
        "keepClone": bool(spec.get("keepClone", True)),
    }
    emit({"event": "start", "target": "%s/%s" % (target.get("platform"), target.get("repo")),
           "base": target.get("baseBranch"), "count": len(prs), "dryRun": ctx_base["dryRun"]})

    try:
        clone_dir = ensure_clone(target, work_dir)
    except Exception as e:
        emit({"event": "error", "reason": str(e)})
        sys.exit(1)
    ctx_base["clone_dir"] = clone_dir
    # 首次拉取目标 base 分支（克隆后默认已在 default；显式 fetch 一次保险）
    try:
        git(["fetch", "--quiet", "origin"], clone_dir)
    except Exception:
        pass

    ok_count = 0
    fail_count = 0
    results = []
    for pr in prs:
        try:
            res = sync_one(pr, ctx_base)
            results.append(res)
            if res.get("ok"):
                ok_count += 1
            else:
                fail_count += 1
        except Exception as e:
            fail_count += 1
            emit({"event": "pr_done", "number": pr.get("number"), "ok": False, "reason": str(e)})
            results.append({"number": pr.get("number"), "ok": False, "reason": str(e)})
            # 复位工作区，避免上一个失败污染下一个
            try:
                git(["cherry-pick", "--abort"], clone_dir, allow_fail=True)
            except Exception:
                pass
            try:
                git(["checkout", "--quiet", "origin/" + (target.get("baseBranch") or "main")], clone_dir, allow_fail=True)
            except Exception:
                pass

    emit({"event": "finish", "ok": ok_count, "failed": fail_count, "results": results})
    if not ctx_base["keepClone"]:
        try:
            import shutil
            shutil.rmtree(clone_dir, ignore_errors=True)
        except Exception:
            pass
    sys.exit(0 if fail_count == 0 else 1)


if __name__ == "__main__":
    main()
