#!/usr/bin/env python3
"""DockerfileのFROM、Composeのimage:、Actionsのcontainer/services/docker://をdigest固定する。

digest の解決には frizbee の単一参照モード (`frizbee image <ref>`) を使い、
ファイルの書き換えはこのスクリプトが行う（元の参照表記を保ったまま
`@sha256:...` を後置する）。

  fix モード:   未固定の参照を解決して書き換える（解決失敗は warn して続行）
  check モード: 未固定の参照を列挙し、あれば exit 1（ネットワーク不要）

スキップ対象:
  - マルチステージビルドのステージ参照 / scratch
  - すでに @sha256: 付きの参照
  - 変数参照を含むもの（$VAR / ${VAR}）
  - compose で同一サービスに build: があるもの（ローカルビルドのタグ名）
  - --image-exclude-regex にマッチする参照（例: 自 org のイメージ）
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

DOCKERFILE_NAME = re.compile(r"^(Dockerfile[^/]*|[^/]+\.dockerfile)$", re.IGNORECASE)
COMPOSE_NAME = re.compile(r"^(docker-)?compose[^/]*\.ya?ml$", re.IGNORECASE)
WORKFLOW_PATH = re.compile(r"^\.github/workflows/.+\.ya?ml$", re.IGNORECASE)
FROM_RE = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+[Aa][Ss]\s+(\S+))?", re.IGNORECASE)
COPY_FROM_RE = re.compile(r"^\s*COPY\s+(?:.*\s)?--from=([^\s]+)", re.IGNORECASE)
IMAGE_RE = re.compile(r"""^(\s*(?:-\s+)?)image:\s*(['"]?)([^\s'"#]+)\2""")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SKIP_DIRS = {".git", "node_modules", "vendor", ".venv"}
DEFAULT_ALLOWED_REGISTRIES = ("docker.io", "ghcr.io", "quay.io")


def discover(root: Path):
    for path in sorted(root.rglob("*")):
        if not path.is_file() or SKIP_DIRS.intersection(path.parts):
            continue
        name = path.name
        relative = path.relative_to(root).as_posix()
        if DOCKERFILE_NAME.match(name) or COMPOSE_NAME.match(name) or WORKFLOW_PATH.match(relative):
            yield path


def classify(path: Path) -> str:
    if DOCKERFILE_NAME.match(path.name):
        return "dockerfile"
    if COMPOSE_NAME.match(path.name):
        return "compose"
    if ".github" in path.parts and "workflows" in path.parts:
        return "workflow"
    return "dockerfile"


def needs_pin(ref: str, stages: set[str]) -> bool:
    if not ref:
        return False
    low = ref.lower()
    if low == "scratch" or low in stages or ref.isdigit():
        return False
    # image名やtagが変数でも、digest suffixがリテラルならcontent identityは固定される。
    if re.search(r"@sha256:[0-9a-f]{64}$", ref, re.IGNORECASE):
        return False
    # digest部を含む変数参照は、見かけ上 @sha256: があっても実体を固定できない。
    return True


def dockerfile_refs(lines: list[str]):
    """(line_index, ref) のリストを返す。ステージ名は事前に収集して除外する。"""
    stages: set[str] = set()
    for line in lines:
        m = FROM_RE.match(line)
        if m and m.group(2):
            stages.add(m.group(2).lower())
    out = []
    for i, line in enumerate(lines):
        m = FROM_RE.match(line)
        if m and needs_pin(m.group(1), stages):
            out.append((i, m.group(1)))
            continue
        m = COPY_FROM_RE.match(line)
        if m:
            ref = m.group(1)
            # 裸の名前は named build context と区別できないため自動書換えしない。
            if needs_pin(ref, stages) and ("/" in ref or ":" in ref):
                out.append((i, ref))
    return out


def compose_refs(lines: list[str]):
    """image: 行のうち、同一サービスに build: がないpull-only参照を返す。"""

    def indent(s: str) -> int:
        return len(s) - len(s.lstrip(" "))

    out = []
    for i, line in enumerate(lines):
        m = IMAGE_RE.match(line)
        if not m or not needs_pin(m.group(3), set()):
            continue
        ind = indent(line)
        sibling_build = False
        for j in range(i - 1, -1, -1):
            s = lines[j]
            if not s.strip() or s.lstrip().startswith("#"):
                continue
            if indent(s) < ind:
                break
            if indent(s) == ind and re.match(r"^\s*build\s*:", s):
                sibling_build = True
                break
        if not sibling_build:
            for j in range(i + 1, len(lines)):
                s = lines[j]
                if not s.strip() or s.lstrip().startswith("#"):
                    continue
                if indent(s) < ind:
                    break
                if indent(s) == ind and re.match(r"^\s*build\s*:", s):
                    sibling_build = True
                    break
        if not sibling_build:
            out.append((i, m.group(3)))
    return out


def workflow_refs(lines: list[str]):
    """Actions schemaの明白なcontainer/services imageとstep-level docker:// usesだけを返す。"""
    def indent(s: str) -> int:
        return len(s) - len(s.lstrip(" "))

    out = []
    jobs_indent = job_indent = job_child_indent = None
    container_indent = container_child_indent = None
    services_indent = service_indent = service_child_indent = None
    steps_indent = step_indent = step_field_indent = step_block_indent = None
    flow_container = re.compile(r"^\s*container\s*:\s*\{\s*image\s*:\s*(['\"]?)([^\s,'\"}]+)\1")
    scalar_container = re.compile(r"^\s*container\s*:\s*(?:(['\"])(.*?)\1|([^\s#]+))")
    image = IMAGE_RE
    inline_docker_uses = re.compile(r"^\s*-\s+uses:\s*['\"]?docker://([^\s'\"#]+)")
    continuation_docker_uses = re.compile(r"^\s*uses:\s*['\"]?docker://([^\s'\"#]+)")

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        ind = indent(line)

        if ind == 0 and re.match(r"^jobs\s*:\s*(?:#.*)?$", line):
            jobs_indent = ind
            job_indent = None
            continue
        if jobs_indent is None or ind <= jobs_indent:
            continue

        # jobs.<job> は jobs: の直下mapだけを受け入れる。
        if (job_indent is None or ind <= job_indent) and re.match(r"^\s*[^#-][^:]*:\s*(?:#.*)?$", line):
            job_indent = ind
            job_child_indent = None
            container_indent = services_indent = steps_indent = None
            continue
        if job_indent is None or ind <= job_indent:
            continue
        if job_child_indent is None:
            job_child_indent = ind
        if ind < job_child_indent:
            continue
        if ind == job_child_indent:
            container_indent = container_child_indent = None
            services_indent = service_indent = service_child_indent = None
            steps_indent = step_indent = step_field_indent = step_block_indent = None
            flow = flow_container.match(line)
            if flow and needs_pin(flow.group(2), set()):
                out.append((i, flow.group(2)))
                continue
            scalar = scalar_container.match(line)
            scalar_ref = scalar.group(2) or scalar.group(3) if scalar else None
            if scalar_ref and needs_pin(scalar_ref, set()):
                out.append((i, scalar_ref))
                continue
            if re.match(r"^\s*container\s*:\s*(?:#.*)?$", line):
                container_indent = ind
                container_child_indent = None
                continue
            if re.match(r"^\s*services\s*:\s*(?:#.*)?$", line):
                services_indent = ind
                service_indent = service_child_indent = None
                continue
            if re.match(r"^\s*steps\s*:\s*(?:#.*)?$", line):
                steps_indent = ind
                step_indent = step_field_indent = step_block_indent = None
                continue

        if container_indent is not None and ind > container_indent:
            if container_child_indent is None:
                container_child_indent = ind
            if ind == container_child_indent:
                m = image.match(line)
                if m and needs_pin(m.group(3), set()):
                    out.append((i, m.group(3)))
                    continue

        if services_indent is not None and ind > services_indent:
            if service_indent is None or ind <= service_indent:
                if re.match(r"^\s*[^#-][^:]*:\s*(?:#.*)?$", line):
                    service_indent = ind
                    service_child_indent = None
                    continue
            if service_indent is not None and ind > service_indent:
                if service_child_indent is None:
                    service_child_indent = ind
                if ind == service_child_indent:
                    m = image.match(line)
                    if m and needs_pin(m.group(3), set()):
                        out.append((i, m.group(3)))
                        continue

        if steps_indent is not None and ind >= steps_indent:
            if step_block_indent is not None and ind > step_block_indent:
                continue
            if re.match(r"^\s*-\s*", line):
                step_indent = ind
                step_field_indent = None
                step_block_indent = ind if re.match(r"^\s*-\s*run\s*:\s*[>|]", line) else None
                inline = inline_docker_uses.match(line)
                if inline and needs_pin(inline.group(1), set()):
                    out.append((i, inline.group(1)))
                    continue
            elif step_indent is not None and ind > step_indent:
                if step_field_indent is None:
                    step_field_indent = ind
                if ind == step_field_indent:
                    if re.match(r"^\s*run\s*:\s*[>|]", line):
                        step_block_indent = ind
                        continue
                    m = continuation_docker_uses.match(line)
                    if m and needs_pin(m.group(1), set()):
                        out.append((i, m.group(1)))
    return out

def registry_for(ref: str) -> str:
    """Return the registry host, applying Docker's implicit Docker Hub default."""
    raw_first = ref.split("/", 1)[0]
    first = raw_first.lower()
    # Docker treats a first component with uppercase letters as a registry host.
    # Decide host-ness before case normalization used for allowlist matching.
    is_registry = (
        "/" in ref
        and ("." in raw_first or ":" in raw_first or raw_first == "localhost" or any(c.isupper() for c in raw_first))
    )
    if not is_registry:
        return "docker.io"
    return "docker.io" if first == "index.docker.io" else first


class Resolver:
    def __init__(self, frizbee: str, timeout: int, max_resolutions: int):
        self.frizbee = frizbee
        self.timeout = timeout
        self.max_resolutions = max_resolutions
        self.resolutions = 0
        self.cache: dict[str, str | None] = {}

    def digest(self, ref: str) -> tuple[str | None, str | None]:
        if ref in self.cache:
            return self.cache[ref], None
        if self.resolutions >= self.max_resolutions:
            return None, "解決数の上限"
        self.resolutions += 1
        digest = None
        try:
            proc = subprocess.run(
                [self.frizbee, "image", ref],
                capture_output=True, text=True, timeout=self.timeout, check=False,
            )
            if proc.returncode == 0:
                candidate = proc.stdout.strip().rsplit("@", 1)
                if len(candidate) == 2 and DIGEST_RE.match(candidate[1]):
                    digest = candidate[1]
        except (OSError, subprocess.TimeoutExpired):
            pass
        self.cache[ref] = digest
        return digest, None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="検査のみ（書き換えない）")
    ap.add_argument("--files", nargs="*", help="対象ファイル（省略時はカレント以下を探索）")
    ap.add_argument("--file-exclude-regex", default="", help="除外するファイルパスの正規表現")
    ap.add_argument("--image-exclude-regex", default="", help="除外するイメージ参照の正規表現")
    ap.add_argument("--frizbee", default="frizbee", help="frizbee バイナリのパス")
    ap.add_argument("--allowed-registries", default=",".join(DEFAULT_ALLOWED_REGISTRIES),
                    help="fix モードで解決を許可するレジストリ（カンマ区切り）")
    ap.add_argument("--max-resolutions", type=int, default=50,
                    help="fix モードで行う異なるイメージ解決の最大数（既定: 50）")
    ap.add_argument("--resolution-timeout", type=int, default=15,
                    help="frizbee の各イメージ解決のタイムアウト秒数（既定: 15）")
    args = ap.parse_args()
    if args.max_resolutions < 1:
        ap.error("--max-resolutions must be at least 1")
    if args.resolution_timeout < 1:
        ap.error("--resolution-timeout must be at least 1")

    file_exclude = re.compile(args.file_exclude_regex) if args.file_exclude_regex else None
    image_exclude = re.compile(args.image_exclude_regex) if args.image_exclude_regex else None

    if args.files:
        targets = [Path(f) for f in args.files if Path(f).is_file()
                   and (DOCKERFILE_NAME.match(Path(f).name) or COMPOSE_NAME.match(Path(f).name)
                        or (".github" in Path(f).parts and "workflows" in Path(f).parts))]
    else:
        targets = list(discover(Path(".")))
    if file_exclude:
        targets = [t for t in targets if not file_exclude.search(str(t))]

    allowed_registries = {registry.strip().lower() for registry in args.allowed_registries.split(",") if registry.strip()}
    resolver = Resolver(args.frizbee, args.resolution_timeout, args.max_resolutions)
    unpinned: list[tuple[Path, str]] = []
    fixed: list[tuple[Path, str, str]] = []
    failed: list[tuple[Path, str]] = []
    blocked: list[tuple[Path, str, str]] = []

    for path in targets:
        lines = path.read_text(errors="replace").splitlines(keepends=True)
        kind = classify(path)
        refs = dockerfile_refs(lines) if kind == "dockerfile" else compose_refs(lines) if kind == "compose" else workflow_refs(lines)
        refs = [(i, r) for i, r in refs if not (image_exclude and image_exclude.search(r))]
        if not refs:
            continue
        changed = False
        for i, ref in refs:
            unpinned.append((path, ref))
            if args.check:
                continue
            if "$" in ref:
                failed.append((path, ref))
                continue
            registry = registry_for(ref)
            if registry not in allowed_registries:
                blocked.append((path, ref, f"許可されていないレジストリ ({registry})"))
                continue
            digest, reason = resolver.digest(ref)
            if reason:
                blocked.append((path, ref, reason))
                continue
            if digest is None:
                failed.append((path, ref))
                continue
            if kind == "workflow" and "docker://" in lines[i]:
                lines[i] = lines[i].replace(f"docker://{ref}", f"docker://{ref}@{digest}", 1)
            else:
                lines[i] = lines[i].replace(ref, f"{ref}@{digest}", 1)
            fixed.append((path, ref, digest))
            changed = True
        if changed:
            path.write_text("".join(lines))

    summary = []
    if args.check:
        if unpinned:
            summary.append(f"### pin-docker: digest 未固定のイメージ参照 {len(unpinned)} 件\n")
            summary.extend(f"- `{p}`: `{r}`" for p, r in unpinned)
        else:
            summary.append("pin-docker: すべてのイメージ参照が digest 固定されています ✅")
    else:
        summary.append(f"pin-docker: {len(fixed)} 件を digest 固定、{len(failed)} 件は解決失敗、{len(blocked)} 件はポリシーにより未解決")
        summary.extend(f"- `{p}`: `{r}` → `@{d[:19]}...`" for p, r, d in fixed)
        summary.extend(f"- ⚠️ 解決失敗: `{p}`: `{r}`" for p, r in failed)
        summary.extend(f"- ⚠️ {reason}: `{p}`: `{r}`" for p, r, reason in blocked)

    print("\n".join(summary))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("\n".join(summary) + "\n")

    if args.check and unpinned:
        return 1
    if not args.check and (failed or blocked):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
