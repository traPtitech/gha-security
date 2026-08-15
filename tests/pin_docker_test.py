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

WORKFLOW = """\
name: image-check
on: pull_request
jobs:
  scalar:
    container: python:3.13-alpine
    steps:
      - name: run docker
        uses: docker://docker
      - uses: actions/example@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        with:
          uses: docker://top-level-env-should-not-be-scanned:latest
          container: container-top-level-env-should-not-be-scanned:latest
      - run: |
          container: script-top-level-env-should-not-be-scanned:latest
  test:
    container:
      image: node:22-alpine
      env:
        image: container-env-top-level-env-should-not-be-scanned:latest
    services:
      db:
        image: postgres:16
        env:
          image: service-env-top-level-env-should-not-be-scanned:latest
      cache:
        image: redis:7
    steps:
      - uses: docker://alpine:3.20
      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    env:
      image: root-only-should-not-be-scanned:latest
"""

WORKFLOW_FOUR_SPACE = """\
jobs:
    test:
        container:
            image: ruby:3.4-alpine
        services:
            db:
                image: mysql:8
        steps:
            - name: docker action
              uses: docker://busybox:1.36
"""

PRIVATE_DOCKERFILE = """\
FROM registry.internal.example/team/app:latest
"""


def make_fixtures(root: Path):
    (root / "Dockerfile").write_text(DOCKERFILE)
    (root / "compose.yaml").write_text(COMPOSE)
    (root / "compose.dev.yaml").write_text(COMPOSE_DEV)
    (root / ".github" / "workflows").mkdir(parents=True)
    (root / ".github" / "workflows" / "ci.yaml").write_text(WORKFLOW)
    (root / ".github" / "workflows" / "four-space.yaml").write_text(WORKFLOW_FOUR_SPACE)


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
        for ref in [
            "golang:1.22-alpine", "alpine:3.19", "composer:latest", "nginx:1.25-alpine", "ghcr.io/traptitech/traq:latest",
            "node:22-alpine", "python:3.13-alpine", "postgres:16", "redis:7", "alpine:3.20", "docker", "ruby:3.4-alpine", "mysql:8", "busybox:1.36",
        ]:
            check(ref in r.stdout, f"check: {ref} を検出")
        for ref in ["scratch", "mariadb:10.6", "redis:7@sha256", "${REGISTRY}/alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "myapp:latest", "root-only-should-not-be-scanned:latest", "container-env-top-level-env-should-not-be-scanned:latest", "service-env-top-level-env-should-not-be-scanned:latest", "container-top-level-env-should-not-be-scanned:latest", "script-top-level-env-should-not-be-scanned:latest"]:
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
        workflow = (root / ".github" / "workflows" / "ci.yaml").read_text()
        check(f"container: python:3.13-alpine@{STUB_DIGEST}" in workflow, "fix: scalar Actions container image を固定")
        check(f"uses: docker://docker@{STUB_DIGEST}" in workflow, "fix: untagged docker action のschemeを維持して固定")
        check(f"image: node:22-alpine@{STUB_DIGEST}" in workflow, "fix: Actions container image を固定")
        check(f"image: postgres:16@{STUB_DIGEST}" in workflow, "fix: Actions service image を固定")
        check(f"image: redis:7@{STUB_DIGEST}" in workflow, "fix: Actions service image を固定")
        check(f"uses: docker://alpine:3.20@{STUB_DIGEST}" in workflow, "fix: docker action を固定")
        check("image: root-only-should-not-be-scanned:latest" in workflow, "fix: workflowの無関係なimageは無変更")
        check("image: container-env-top-level-env-should-not-be-scanned:latest" in workflow, "fix: container内env.imageは無変更")
        check("image: service-env-top-level-env-should-not-be-scanned:latest" in workflow, "fix: service内env.imageは無変更")
        check("uses: docker://top-level-env-should-not-be-scanned:latest" in workflow, "fix: action inputのusesは無変更")
        four_space = (root / ".github" / "workflows" / "four-space.yaml").read_text()
        check(f"image: ruby:3.4-alpine@{STUB_DIGEST}" in four_space, "fix: 4-space container image を固定")
        check(f"image: mysql:8@{STUB_DIGEST}" in four_space, "fix: 4-space service image を固定")
        check(f"uses: docker://busybox:1.36@{STUB_DIGEST}" in four_space, "fix: 4-space docker action を固定")
        check((root / "compose.dev.yaml").read_text() == COMPOSE_DEV, "fix: 除外ファイルは無変更")

    # --- fix モード: registry egress policy ---
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        private = root / "Dockerfile.private"
        private.write_text(PRIVATE_DOCKERFILE)
        calls = root / "calls"
        stub = root / "frizbee-stub"
        stub.write_text(
            f'#!/bin/sh\necho "$2" >> "{calls}"\necho "$2@{STUB_DIGEST}"\n'
        )
        stub.chmod(0o755)
        r = run(root, "--frizbee", str(stub), "--files", str(private))
        check(r.returncode == 1, "registry policy: denied image fails fix mode")
        check(private.read_text() == PRIVATE_DOCKERFILE, "registry policy: private registry is not resolved by default")
        check(not calls.exists(), "registry policy: denied registry causes no resolver egress")
        check("許可されていないレジストリ" in r.stdout, "registry policy: denial is reported")

        private.write_text("FROM INTERNAL/team/app:latest\n")
        r = run(root, "--frizbee", str(stub), "--files", str(private))
        check(r.returncode == 1, "registry policy: uppercase private host fails fix mode")
        check(not calls.exists(), "registry policy: uppercase private host causes no resolver egress")

        private.write_text(PRIVATE_DOCKERFILE)
        r = run(
            root, "--frizbee", str(stub), "--allowed-registries", "registry.internal.example",
            "--files", str(private),
        )
        check(r.returncode == 0, "registry policy: explicit registry allow succeeds")
        check(f"registry.internal.example/team/app:latest@{STUB_DIGEST}" in private.read_text(),
              "registry policy: explicitly allowed registry is pinned")
        check(calls.read_text().strip() == "registry.internal.example/team/app:latest",
              "registry policy: only explicitly allowed image is resolved")

    # --- fix モード: resolver work is bounded ---
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        dockerfile = root / "Dockerfile"
        dockerfile.write_text("FROM alpine:3.19\nFROM busybox:1.36\n")
        calls = root / "calls"
        stub = root / "frizbee-stub"
        stub.write_text(
            f'#!/bin/sh\necho "$2" >> "{calls}"\necho "$2@{STUB_DIGEST}"\n'
        )
        stub.chmod(0o755)
        r = run(root, "--frizbee", str(stub), "--max-resolutions", "1")
        check(r.returncode == 1, "resolution limit: unresolved image fails fix mode")
        check(len(calls.read_text().splitlines()) == 1, "resolution limit: invokes resolver at most once")
        check("上限" in r.stdout, "resolution limit: skipped images are reported")
        check("--max-resolutions must be at least 1" in run(root, "--max-resolutions", "0").stderr,
              "resolution limit: zero is rejected")
        check("--resolution-timeout must be at least 1" in run(root, "--resolution-timeout", "0").stderr,
              "resolution timeout: zero is rejected")

    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
