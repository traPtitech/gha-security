#!/usr/bin/env python3
"""Dockerfile の FROM / compose の image: を digest 固定する。

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
FROM_RE = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+[Aa][Ss]\s+(\S+))?", re.IGNORECASE)
COPY_FROM_RE = re.compile(r"^\s*COPY\s+(?:.*\s)?--from=([^\s]+)", re.IGNORECASE)
IMAGE_RE = re.compile(r"""^(\s*(?:-\s+)?)image:\s*(['"]?)([^\s'"#]+)\2""")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SKIP_DIRS = {".git", "node_modules", "vendor", ".venv"}


def discover(root: Path):
    for path in sorted(root.rglob("*")):
        if not path.is_file() or SKIP_DIRS.intersection(path.parts):
            continue
        name = path.name
        if DOCKERFILE_NAME.match(name) or COMPOSE_NAME.match(name):
            yield path


def classify(path: Path) -> str:
    return "compose" if COMPOSE_NAME.match(path.name) else "dockerfile"


def needs_pin(ref: str, stages: set[str]) -> bool:
    if not ref:
        return False
    low = ref.lower()
    if low == "scratch" or low in stages or ref.isdigit():
        return False
    # 変数を含む参照は、見かけ上 @sha256: があっても実体を固定できない。
    if "$" in ref:
        return True
    return "@sha256:" not in ref


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


class Resolver:
    def __init__(self, frizbee: str):
        self.frizbee = frizbee
        self.cache: dict[str, str | None] = {}

    def digest(self, ref: str) -> str | None:
        if ref in self.cache:
            return self.cache[ref]
        digest = None
        try:
            proc = subprocess.run(
                [self.frizbee, "image", ref],
                capture_output=True, text=True, timeout=60, check=False,
            )
            if proc.returncode == 0:
                candidate = proc.stdout.strip().rsplit("@", 1)
                if len(candidate) == 2 and DIGEST_RE.match(candidate[1]):
                    digest = candidate[1]
        except (OSError, subprocess.TimeoutExpired):
            pass
        self.cache[ref] = digest
        return digest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="検査のみ（書き換えない）")
    ap.add_argument("--files", nargs="*", help="対象ファイル（省略時はカレント以下を探索）")
    ap.add_argument("--file-exclude-regex", default="", help="除外するファイルパスの正規表現")
    ap.add_argument("--image-exclude-regex", default="", help="除外するイメージ参照の正規表現")
    ap.add_argument("--frizbee", default="frizbee", help="frizbee バイナリのパス")
    args = ap.parse_args()

    file_exclude = re.compile(args.file_exclude_regex) if args.file_exclude_regex else None
    image_exclude = re.compile(args.image_exclude_regex) if args.image_exclude_regex else None

    if args.files:
        targets = [Path(f) for f in args.files
                   if Path(f).is_file() and (DOCKERFILE_NAME.match(Path(f).name) or COMPOSE_NAME.match(Path(f).name))]
    else:
        targets = list(discover(Path(".")))
    if file_exclude:
        targets = [t for t in targets if not file_exclude.search(str(t))]

    resolver = Resolver(args.frizbee)
    unpinned: list[tuple[Path, str]] = []
    fixed: list[tuple[Path, str, str]] = []
    failed: list[tuple[Path, str]] = []

    for path in targets:
        lines = path.read_text(errors="replace").splitlines(keepends=True)
        refs = dockerfile_refs(lines) if classify(path) == "dockerfile" else compose_refs(lines)
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
            digest = resolver.digest(ref)
            if digest is None:
                failed.append((path, ref))
                continue
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
        summary.append(f"pin-docker: {len(fixed)} 件を digest 固定、{len(failed)} 件は解決失敗")
        summary.extend(f"- `{p}`: `{r}` → `@{d[:19]}...`" for p, r, d in fixed)
        summary.extend(f"- ⚠️ 解決失敗: `{p}`: `{r}`" for p, r in failed)

    print("\n".join(summary))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("\n".join(summary) + "\n")

    if args.check and unpinned:
        return 1
    if not args.check and failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
