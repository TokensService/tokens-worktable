from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass(frozen=True)
class JenkinsConfig:
    url: str = "http://10.112.32.240:28080"
    user: str = "admin"
    password: str = "XDS@2025"
    job_name: str = "xds-local-deploy"
    timeout: float = 30.0

    @classmethod
    def from_env(cls) -> "JenkinsConfig":
        return cls(
            url=os.getenv("OP_TEST_JENKINS_URL", cls.url),
            user=os.getenv("OP_TEST_JENKINS_USER", cls.user),
            password=os.getenv("OP_TEST_JENKINS_PASSWORD", cls.password),
            job_name=os.getenv("OP_TEST_JENKINS_JOB_NAME", cls.job_name),
            timeout=float(os.getenv("OP_TEST_JENKINS_TIMEOUT", str(cls.timeout))),
        )


class JenkinsClient:
    def __init__(
        self,
        config: JenkinsConfig | None = None,
        *,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._config = config or JenkinsConfig.from_env()
        self._crumb: tuple[str, str] | None = None
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client(
            base_url=self._config.url,
            auth=(self._config.user, self._config.password),
            timeout=self._config.timeout,
            follow_redirects=True,
        )

    def _fetch_crumb(self) -> tuple[str, str]:
        resp = self._http.get("/crumbIssuer/api/json")
        resp.raise_for_status()
        data = resp.json()
        return data["crumbRequestField"], data["crumb"]

    def _ensure_crumb(self) -> tuple[str, str]:
        if self._crumb is None:
            self._crumb = self._fetch_crumb()
        return self._crumb

    def _invalidate_crumb(self) -> None:
        self._crumb = None

    def _post(self, path: str, **kwargs: Any) -> httpx.Response:
        for attempt in range(2):
            field, value = self._ensure_crumb()
            headers = dict(kwargs.pop("headers", {}))
            headers[field] = value
            resp = self._http.post(path, headers=headers, **kwargs)
            if resp.status_code != 403 or attempt > 0:
                return resp
            self._invalidate_crumb()
        return resp

    def submit_build(self, params: dict[str, str]) -> int:
        resp = self._post(f"/job/{self._config.job_name}/buildWithParameters", data=params)
        resp.raise_for_status()
        location = resp.headers.get("Location", "")
        if not location:
            raise RuntimeError("Jenkins did not return a Location header")
        return int(location.rstrip("/").split("/")[-1])

    def get_queue_item(self, queue_id: int) -> dict[str, Any]:
        resp = self._http.get(f"/queue/item/{queue_id}/api/json")
        resp.raise_for_status()
        return resp.json()

    def get_build_info(self, build_number: int) -> dict[str, Any]:
        tree = (
            "building,result,displayName,description,duration,"
            "timestamp,url,actions[parameters[name,value]]"
        )
        resp = self._http.get(
            f"/job/{self._config.job_name}/{build_number}/api/json",
            params={"tree": tree},
        )
        resp.raise_for_status()
        return resp.json()

    def get_stage_view(self, build_number: int) -> dict[str, Any]:
        resp = self._http.get(f"/job/{self._config.job_name}/{build_number}/wfapi/describe")
        resp.raise_for_status()
        return resp.json()

    def get_console_text(self, build_number: int) -> str:
        resp = self._http.get(f"/job/{self._config.job_name}/{build_number}/consoleText")
        resp.raise_for_status()
        return resp.text

    def get_progressive_log(self, build_number: int, offset: int = 0) -> tuple[str, int, bool]:
        resp = self._http.get(
            f"/job/{self._config.job_name}/{build_number}/logText/progressiveText",
            params={"start": offset},
        )
        resp.raise_for_status()
        next_offset = int(resp.headers.get("X-Text-Size", str(offset)))
        has_more = resp.headers.get("X-More-Data", "false").lower() == "true"
        return resp.text, next_offset, has_more

    def stop_build(self, build_number: int) -> None:
        resp = self._post(f"/job/{self._config.job_name}/{build_number}/stop")
        resp.raise_for_status()

    def get_node_gpu_status(self) -> dict[str, Any]:
        resp = self._http.get("/userContent/xds-node-gpu-status/status.json")
        resp.raise_for_status()
        return resp.json()

    def get_live_log_url(self, build_number: int) -> str:
        build_tag = f"jenkins-{self._config.job_name}-{build_number}"
        return f"{self._config.url}/userContent/xds-live-logs/{build_tag}/index.html"

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> "JenkinsClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
