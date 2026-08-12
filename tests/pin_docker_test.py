#!/usr/bin/env python3
"""pin_docker.py の回帰テスト。frizbee はスタブに差し替えるためネットワーク不要。"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "actions" / "pin-docker" / "pin_docker.py"
STUB_DIGEST = "sha256:" + "a" * 64

DOCKERFILE = """\
FROM golang:1.22-alpine AS build
RUN go build ./...
FROM build AS test
FROM scratch AS empty
COPY --from=build /app /app
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer
FROM alpine:3.19
FROM ${BASE_IMAGE}
FROM alpine@sha256:${DIGEST}
FROM ${REGISTRY}/alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
"""

COMPOSE = """\
services:
  web:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
  app:
    build: .
    image: myapp:latest
  own:
    image: ghcr.io/traptitech/traq:latest
  pinned:
    image: redis:7@sha256:{}
  var:
    image: ${{IMG}}
""".format("b" * 64)

COMPOSE_DEV = """\
services:
  db:
    image: mariadb:10.6
"""


def make_fixtures(root: Path):
    (root / "Dockerfile").write_text(DOCKERFILE)
    (root / "compose.yaml").write_text(COMPOSE)
    (root / "compose.dev.yaml").write_text(COMPOSE_DEV)


def run(root: Path, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=root, capture_output=True, text=True,
    )


def main():
    failures = []

    def check(cond, label):
        (print(f"ok: {label}") if cond else failures.append(label))
        if not cond:
            print(f"FAIL: {label}")

    common = [
        "--file-exclude-regex", r"(^|/)(docker-)?compose[^/]*\.(dev|local|override)[^/]*\.ya?ml$",
    ]

    # --- check モード ---
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        make_fixtures(root)
        r = run(root, "--check", *common)
        check(r.returncode == 1, "check: unpinned で exit 1")
        for ref in ["golang:1.22-alpine", "alpine:3.19", "composer:latest", "nginx:1.25-alpine", "ghcr.io/traptitech/traq:latest"]:
            check(ref in r.stdout, f"check: {ref} を検出")
        for ref in ["scratch", "mariadb:10.6", "redis:7@sha256", "${REGISTRY}/alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "myapp:latest"]:
            check(ref not in r.stdout, f"check: {ref} は検出しない")
        for ref in ["${IMG}", "${BASE_IMAGE}", "alpine@sha256:${DIGEST}"]:
            check(ref in r.stdout, f"check: {ref} を未検証として検出")

    # --- fix モード（frizbee スタブ）---
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        make_fixtures(root)
        stub = root / "frizbee-stub"
        stub.write_text(f'#!/bin/sh\necho "$2@{STUB_DIGEST}"\n')
        stub.chmod(0o755)
        r = run(root, "--frizbee", str(stub), *common)
        check(r.returncode == 1, "fix: 未解決参照があれば exit 1")
        dockerfile = (root / "Dockerfile").read_text()
        compose = (root / "compose.yaml").read_text()
        check(f"golang:1.22-alpine@{STUB_DIGEST} AS build" in dockerfile, "fix: golang を固定")
        check(f"alpine:3.19@{STUB_DIGEST}" in dockerfile, "fix: alpine を固定")
        check(f"--from=composer:latest@{STUB_DIGEST}" in dockerfile, "fix: COPY --from を固定")
        check("FROM ${BASE_IMAGE}" in dockerfile, "fix: Dockerfile 変数参照は未解決のまま")
        check(f"nginx:1.25-alpine@{STUB_DIGEST}" in compose, "fix: compose の image を固定")
        check("image: myapp:latest\n" in compose, "fix: build 併記サービスは無変更")
        check(f"image: ghcr.io/traptitech/traq:latest@{STUB_DIGEST}\n" in compose, "fix: org image も固定")
        check((root / "compose.dev.yaml").read_text() == COMPOSE_DEV, "fix: 除外ファイルは無変更")

    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
