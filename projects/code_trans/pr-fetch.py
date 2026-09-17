#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pr-fetch.py — tokens-worktable「代码同步」窗口的服务端 PR 抓取器。
由 index.html 通过 /api/worktable/exec 调用（.py 自动用 python3 执行）。
在服务端发起请求，规避浏览器 CORS，令牌不落入页面网络面板。

用法:
  python3 pr-fetch.py info  <platform> <repo> [token]
  python3 pr-fetch.py list  <platform> <repo> [token] [state] [per_page]

platform: github | gitlab | gitee | gitcode
  github/gitee/gitcode: <repo> = owner/repo  (如 octocat/Hello-World)
  gitlab:        <repo> = group/project (如 gitlab-org/gitlab)，内部自动 URL 编码)

info  返回: { ok, default_branch, branches:[...], clone_url, private }
list  成功返回归一化 PR 数组并 exit 0；失败打印 {"error":...} 并 exit 1

归一化 PR 字段:
  platform, number, title, state, draft, author, sourceBranch, targetBranch,
  baseSha, headSha, baseRef, headRef, sourceCloneUrl, baseCloneUrl,
  htmlUrl, createdAt, updatedAt, mergedAt, sourceRefKind
"""
import sys, json, re, urllib.request, urllib.parse, urllib.error

UA = "tokens-worktable-pr-sync/1.0"


def die(msg, code=1):
    sys.stdout.write(json.dumps({"error": str(msg)}, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.exit(code)


def normalize_repo(s):
    """把用户输入的仓库标识归一化为 owner/repo（GitLab 可为 group/subgroup/project）。
    接受：owner/repo、https://host/owner/repo(.git)、git@host:owner/repo(.git)、带尾斜杠等。"""
    s = (s or "").strip()
    if not s:
        return ""
    m = re.match(r"^git@[^:]+:(.+)$", s)            # git@github.com:owner/repo.git
    if m:
        s = m.group(1)
    elif "://" in s:                                  # https://github.com/owner/repo(.git)
        try:
            s = urllib.parse.urlparse(s).path.lstrip("/")
        except Exception:
            pass
    s = re.sub(r"\.git$", "", s, flags=re.I)          # 去尾 .git
    s = s.strip("/")
    return s


def req(url, token=None, platform=None, accept=None, method="GET", data=None):
    r = urllib.request.Request(url, method=method)
    r.add_header("User-Agent", UA)
    r.add_header("Accept", accept or "application/json")
    if token:
        if platform in ("gitlab", "gitcode"):
            # GitLab v4 与 GitCode v5 均用 PRIVATE-TOKEN 鉴权
            r.add_header("PRIVATE-TOKEN", token)
        elif platform == "gitee":
            # Gitee 也接受 header
            r.add_header("Authorization", "Bearer " + token)
        else:  # github
            r.add_header("Authorization", "Bearer " + token)
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        r.data = body
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            raw = resp.read().decode("utf-8", "replace")
            ct = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        # 403 常见为限流/缺令牌
        if e.code == 403 or e.code == 429:
            die("HTTP %d（可能缺少令牌或触发限流）: %s" % (e.code, raw[:300]))
        die("HTTP %d: %s" % (e.code, raw[:300]))
    except urllib.error.URLError as e:
        die("网络不可达: %s" % e)
    if not ct.startswith("application/json") and "json" not in ct:
        # Gitee 有时返回 text/html 但实为 JSON
        try:
            return json.loads(raw)
        except Exception:
            die("非 JSON 响应（%s）: %s" % (ct, raw[:200]))
    try:
        return json.loads(raw)
    except Exception:
        die("JSON 解析失败: %s" % raw[:200])


def gh_api(path, token, qs=None, accept=None):
    base = "https://api.github.com"
    url = base + path
    if qs:
        url += "?" + urllib.parse.urlencode(qs)
    return req(url, token, "github", accept=accept)


def gl_api(path, token, qs=None, method="GET", data=None):
    base = "https://gitlab.com/api/v4"
    url = base + path
    if qs:
        url += "?" + urllib.parse.urlencode(qs)
    return req(url, token, "gitlab", method=method, data=data)


def gitee_api(path, token, qs=None, accept=None):
    base = "https://gitee.com/api/v5"
    url = base + path
    if qs:
        url += "?" + urllib.parse.urlencode(qs)
    return req(url, token, "gitee", accept=accept)


def gc_api(path, token, qs=None, accept=None):
    # GitCode 用 Gitee 兼容 v5 API：host 为 api.gitcode.com；鉴权 PRIVATE-TOKEN（req 已按平台处理）
    base = "https://api.gitcode.com/api/v5"
    url = base + path
    if qs:
        url += "?" + urllib.parse.urlencode(qs)
    return req(url, token, "gitcode", accept=accept)


def encode_gitlab_project(repo):
    return urllib.parse.quote(repo, safe="")


def info(platform, repo, token):
    if platform == "github":
        d = gh_api("/repos/" + repo, token)
        branches_raw = gh_api("/repos/" + repo + "/branches", token, qs={"per_page": 100})
        branches = [b["name"] for b in branches_raw if isinstance(b, dict) and "name" in b]
        return {
            "ok": True,
            "default_branch": d.get("default_branch", "main"),
            "branches": branches,
            "clone_url": d.get("clone_url"),
            "private": d.get("private"),
            "full_name": d.get("full_name"),
        }
    if platform == "gitlab":
        pid = encode_gitlab_project(repo)
        d = gl_api("/projects/" + pid, token)
        branches_raw = gl_api("/projects/" + pid + "/repository/branches", token, qs={"per_page": 100})
        branches = [b["name"] for b in branches_raw if isinstance(b, dict) and "name" in b]
        return {
            "ok": True,
            "default_branch": d.get("default_branch", "main"),
            "branches": branches,
            "clone_url": d.get("http_url_to_repo"),
            "private": (d.get("visibility") in ("private", "internal")),
            "full_name": d.get("path_with_namespace"),
        }
    if platform == "gitee":
        d = gitee_api("/repos/" + repo, token)
        branches_raw = gitee_api("/repos/" + repo + "/branches", token, qs={"per_page": 100})
        branches = [b["name"] for b in branches_raw if isinstance(b, dict) and "name" in b]
        return {
            "ok": True,
            "default_branch": d.get("default_branch", "master"),
            "branches": branches,
            "clone_url": d.get("ssh_url") or d.get("clone_url"),
            "private": d.get("private"),
            "full_name": d.get("full_name"),
        }
    if platform == "gitcode":
        # GitCode v5（Gitee 兼容）：info —— repo 信息与分支列表
        d = gc_api("/repos/" + repo, token)
        branches_raw = gc_api("/repos/" + repo + "/branches", token, qs={"per_page": 100})
        branches = [b["name"] for b in branches_raw if isinstance(b, dict) and "name" in b]
        return {
            "ok": True,
            "default_branch": d.get("default_branch", "main"),
            "branches": branches,
            "clone_url": d.get("http_url_to_repo") or ("https://gitcode.com/%s.git" % repo),
            "private": d.get("private"),
            "full_name": d.get("full_name"),
        }
    die("未知 platform: " + str(platform))


def list_prs(platform, repo, token, state="open", per_page=30):
    out = []
    if platform == "github":
        state_q = "open" if state in ("open", "all") else state  # github: open/closed/all
        pulls = gh_api("/repos/" + repo + "/pulls", token,
                       qs={"state": state_q, "per_page": min(int(per_page), 100), "direction": "desc"})
        for p in pulls:
            head = p.get("head") or {}
            base = p.get("base") or {}
            out.append({
                "platform": "github",
                "number": p.get("number"),
                "title": p.get("title") or "",
                "state": p.get("state"),
                "draft": bool(p.get("draft")),
                "author": (p.get("user") or {}).get("login"),
                "sourceBranch": head.get("ref"),
                "targetBranch": base.get("ref"),
                "baseSha": base.get("sha"),
                "headSha": head.get("sha"),
                # GitHub 对所有 PR（含 fork）都暴露 pull/{n}/head 引用，从源仓抓取即可
                "baseRef": base.get("ref"),
                "headRef": "pull/%s/head" % p.get("number"),
                "sourceCloneUrl": "https://github.com/%s.git" % repo,
                "baseCloneUrl": "https://github.com/%s.git" % repo,
                "htmlUrl": p.get("html_url"),
                "createdAt": p.get("created_at"),
                "updatedAt": p.get("updated_at"),
                "mergedAt": p.get("merged_at"),
                "sourceRefKind": "pullhead",
            })
    elif platform == "gitlab":
        pid = encode_gitlab_project(repo)
        state_q = "opened" if state in ("open", "opened") else ("closed" if state == "closed" else "all")
        mrs = gl_api("/projects/" + pid + "/merge_requests", token,
                     qs={"state": state_q, "per_page": min(int(per_page), 100), "order_by": "updated_at", "sort": "desc"})
        # 预取本仓 clone url；fork MR 的 source clone url 按需取
        proj = gl_api("/projects/" + pid, token)
        self_clone = proj.get("http_url_to_repo") or ("https://gitlab.com/%s.git" % repo)
        src_proj_cache = {}
        for m in mrs:
            src_pid = m.get("source_project_id")
            tgt_pid = m.get("target_project_id")
            # head（source_branch）在 source project；base（target_branch）在 target project
            src_clone = self_clone
            base_clone = self_clone
            if src_pid and src_pid != proj.get("id"):
                if src_pid not in src_proj_cache:
                    try:
                        sp = gl_api("/projects/" + str(src_pid), token)
                        src_proj_cache[src_pid] = sp.get("http_url_to_repo")
                    except Exception:
                        src_proj_cache[src_pid] = None
                src_clone = src_proj_cache.get(src_pid) or self_clone
            if tgt_pid and tgt_pid != proj.get("id"):
                if tgt_pid not in src_proj_cache:
                    try:
                        tp = gl_api("/projects/" + str(tgt_pid), token)
                        src_proj_cache[tgt_pid] = tp.get("http_url_to_repo")
                    except Exception:
                        src_proj_cache[tgt_pid] = None
                base_clone = src_proj_cache.get(tgt_pid) or self_clone
            out.append({
                "platform": "gitlab",
                "number": m.get("iid"),
                "title": m.get("title") or "",
                "state": "open" if m.get("state") == "opened" else m.get("state"),
                "draft": bool(m.get("draft") or m.get("work_in_progress")),
                "author": (m.get("author") or {}).get("username"),
                "sourceBranch": m.get("source_branch"),
                "targetBranch": m.get("target_branch"),
                "baseSha": None,  # GitLab MR 不直接给 base sha，sync 时按 ref 抓
                "headSha": m.get("sha"),
                "baseRef": m.get("target_branch"),
                "headRef": m.get("source_branch"),
                "sourceCloneUrl": src_clone,
                "baseCloneUrl": base_clone,
                "htmlUrl": m.get("web_url"),
                "createdAt": m.get("created_at"),
                "updatedAt": m.get("updated_at"),
                "mergedAt": m.get("merged_at"),
                "sourceRefKind": "branch",
            })
    elif platform == "gitee":
        state_q = "open" if state == "open" else ("closed" if state == "closed" else "all")
        pulls = gitee_api("/repos/" + repo + "/pulls", token,
                          qs={"state": state_q, "per_page": min(int(per_page), 100), "direction": "desc"})
        for p in pulls:
            head = p.get("head") or {}
            base = p.get("base") or {}
            head_user = (head.get("user") or {}).get("login")
            src_clone = "https://gitee.com/%s.git" % repo
            # fork PR：head.repo 可能为 fork 仓
            if isinstance(head.get("repo"), dict) and head["repo"].get("full_name"):
                src_clone = head["repo"].get("clone_url") or ("https://gitee.com/%s.git" % head["repo"].get("full_name"))
            out.append({
                "platform": "gitee",
                "number": p.get("number"),
                "title": p.get("title") or "",
                "state": p.get("state"),
                "draft": bool(p.get("draft")),
                "author": head_user or (p.get("user") or {}).get("login"),
                "sourceBranch": head.get("ref"),
                "targetBranch": base.get("ref"),
                "baseSha": base.get("sha"),
                "headSha": head.get("sha"),
                "baseRef": base.get("ref"),
                "headRef": head.get("ref"),
                "sourceCloneUrl": src_clone,
                "baseCloneUrl": "https://gitee.com/%s.git" % repo,
                "htmlUrl": p.get("html_url"),
                "createdAt": p.get("created_at"),
                "updatedAt": p.get("updated_at"),
                "mergedAt": p.get("merged_at"),
                "sourceRefKind": "branch",
            })
    elif platform == "gitcode":
        # GitCode v5（Gitee 兼容）：list PRs —— state 取 all/open/closed，按 updated 倒序
        state_q = "open" if state == "open" else ("closed" if state == "closed" else "all")
        pulls = gc_api("/repos/" + repo + "/pulls", token,
                       qs={"state": state_q, "per_page": min(int(per_page), 100), "direction": "desc", "sort": "updated"})
        for p in pulls:
            head = p.get("head") or {}
            base = p.get("base") or {}
            head_repo = head.get("repo") or {}
            src_clone = "https://gitcode.com/%s.git" % repo
            # fork PR：head.repo.full_name 指向源仓
            if head_repo.get("full_name") and head_repo.get("full_name") != repo:
                src_clone = "https://gitcode.com/%s.git" % head_repo.get("full_name")
            out.append({
                "platform": "gitcode",
                "number": p.get("number"),
                "title": p.get("title") or "",
                "state": p.get("state"),
                "draft": bool(p.get("draft")),
                "author": (p.get("user") or {}).get("login"),
                "sourceBranch": p.get("source_branch") or head.get("ref"),
                "targetBranch": p.get("target_branch") or base.get("ref"),
                "baseSha": base.get("sha"),
                "headSha": head.get("sha"),
                "baseRef": base.get("ref"),
                "headRef": head.get("ref"),
                "sourceCloneUrl": src_clone,
                "baseCloneUrl": "https://gitcode.com/%s.git" % repo,
                "htmlUrl": p.get("html_url") or p.get("web_url"),
                "createdAt": p.get("created_at"),
                "updatedAt": p.get("updated_at"),
                "mergedAt": p.get("merged_at"),
                "sourceRefKind": "branch",
            })
    else:
        die("未知 platform: " + str(platform))
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.exit(0)


def main():
    argv = sys.argv
    if len(argv) < 4:
        die("用法: pr-fetch.py <info|list> <platform> <repo> [token] [state] [per_page]")
    action = argv[1]
    platform = argv[2]
    repo = normalize_repo(argv[3])
    if not repo:
        die("仓库标识为空或无法解析（请填 owner/repo，或完整 https / git@ 克隆地址）")
    token = argv[4] if len(argv) > 4 and argv[4] else None
    if action == "info":
        sys.stdout.write(json.dumps(info(platform, repo, token), ensure_ascii=False))
        sys.stdout.write("\n")
        sys.exit(0)
    if action == "list":
        state = argv[5] if len(argv) > 5 and argv[5] else "open"
        per_page = argv[6] if len(argv) > 6 and argv[6] else "30"
        list_prs(platform, repo, token, state, per_page)
    die("未知 action: " + action)


if __name__ == "__main__":
    main()
