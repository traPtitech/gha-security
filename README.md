# gha-security

traPtitech のリポジトリを対象にした、サプライチェーンハードニング用の共通 GitHub Actions 集。

- **pinning**: GitHub Actions の `uses:` を 40 桁 commit SHA に、Docker イメージ参照を `@sha256:` digest に固定する
- **cooldown**: 公開から日が浅い依存バージョンと、同一versionのnpm artifact identity差し替えを防ぐ（bot 経由・手動 bump を問わず）

## 提供するもの

### 再利用ワークフロー（`.github/workflows/`）

| ワークフロー | 役割 | 呼び出し元の推奨トリガー |
|---|---|---|
| `pin-support.yaml` | PR 内の未固定参照を検出し、**修正を suggestion または直接コミットで返す**（作業の肩代わり） | `pull_request` |
| `pin-check.yaml` | 未固定参照があれば fail する退行防止 lint（`--verify-comment` でコメント偽装も検出） | `pull_request` |
| `cooldown-check.yaml` | PR で追加/変更された依存に公開 N 日未満の版、または同一versionのnpm artifact identity変更があれば fail。違反内容は **sticky な PR コメント**（bot コメント1つを更新）でも通知され、解消すると ✅ に変わる | `pull_request` |
| `dependency-policy.yaml` | CI の lockfile 強制と `package.json` の range / dist-tag 指定を fail する | `pull_request` |
| `pin.yaml` | リポジトリ全体を固定して PR を作成。`update: true` で bot なしリポジトリの追従更新も担う | `schedule` / `workflow_dispatch` |

### Composite actions（`actions/`）

| action | 内容 |
|---|---|
| `actions/cooldown-check` | cooldown ゲート本体（Node 製・依存なし）。対象: npm 系lockfile（package-lockでは**同一ファイル・同一installation path・同一version**の `resolved` / `integrity` を監視）・package.json 厳密指定・go.mod / go.sum・workflows の `uses:`。lockfileのrename/moveをまたぐidentity相関、alias・local/Git sourceの正規化は対象外 |
| `actions/dependency-policy` | workflow の可変 install（Node / Cargo / Go）と、`pip install -r` の `--require-hashes` 不足を拒否し、`package.json` の semver range / dist-tag を拒否する |
| `actions/pin-docker` | Dockerfile `FROM` / compose `image:` の digest 固定。解決は frizbee（単一参照モード）、書き換えは同梱スクリプト |
| `actions/setup-tools` | pinact / frizbee を checksum 検証付きでインストール（内部用） |

### テンプレート（`templates/`）

- `workflows/security-checks.yaml` — PR チェック一式の caller（各リポジトリに配置）
- `workflows/pin.yaml` — 週次 pin PR の caller
- `dependabot.yml` — cooldown 設定済みの標準 Dependabot 設定
- `client-cooldown/` — 開発端末側 cooldown（`.npmrc` / `pnpm-workspace.yaml` / `bunfig.toml`）

## 導入手順（各リポジトリ）

1. `templates/workflows/security-checks.yaml` を `.github/workflows/` にコピー（`uses:` の `gha-security` SHA は固定参照。更新はレビュー済みPRで行う）
2. （bot なしリポジトリ）`templates/workflows/pin.yaml` もコピーし、`update: true` にする
3. `templates/dependabot.yml` を参考に `.github/dependabot.yml` を整備（Renovate リポジトリは [renovate-config](https://github.com/traPtitech/renovate-config) を extends）
4. パッケージマネージャに応じて `templates/client-cooldown/` の設定をコミット

初回の一括固定は `pin.yaml` の `workflow_dispatch` を手動実行するのが早い。

## cooldown の全体像（3層防御）

| 層 | 仕組み | 効く範囲 |
|---|---|---|
| 開発端末 | npm `min-release-age`（日）/ pnpm `minimumReleaseAge`（分・v11 からデフォルト1日）/ Bun `minimumReleaseAge`（秒） | 手元の install / add |
| PR ゲート | `cooldown-check`（このリポジトリ） | すべての PR |
| bot | Dependabot cooldown（2026-07 からデフォルト3日）/ Renovate `minimumReleaseAge` | bot の更新 PR |

しきい値の標準: **npm 7日 / その他 3日**。組織内依存も既定で検査対象であり、例外は caller の `exclude` / `*-exclude-regex` に明示する。
緊急のセキュリティ修正は PR に **`cooldown-override` ラベル**を付けるとスキップできる（Dependabot のセキュリティアップデートはもともと cooldown 対象外）。

## 機能のオン/オフ

すべての機能は**リポジトリ単位で独立してオプトイン/オプトアウト**できる。全部入りは強制しない。

| 機能 | オンにする方法 | オフにする方法 / 部分無効化 |
|---|---|---|
| pin-support | caller に job を書く | job を書かない。`pin-docker: false` で Docker 部分のみ無効化 |
| pin-check | caller に job を書く | job を書かない。`pin-docker: false` / `verify-comment: false` |
| cooldown-check | caller に job を書く | job を書かない。`npm-min-age-days: 0` 等で**エコシステム単位に無効化**（0 のエコシステムはレジストリ照会もしない）。`pr-comment: false` で PR コメント通知のみ無効化 |
| pin.yaml（定期固定PR） | caller を配置 | 配置しない。`update: false`（デフォルト）で追従更新のみ無効化 |
| クライアント側 cooldown | `templates/client-cooldown/` の設定をコミット | コミットしない／ファイルを消す（CI 側の cooldown-check とは独立） |
| dependabot.yml | テンプレを参考に配置 | cooldown ブロックを消せばデフォルト（3日）に、`cooldown: {default-days: 0}` で無効に |
| renovate-config | `extends: ["github>traPtitech/renovate-config"]` | extends しない。一部だけ無効化する場合は extends の後に上書き（[renovate-config の README](https://github.com/traPtitech/renovate-config) 参照） |

## セキュリティ上の設計原則

- **PR のコードは実行しない**: pin-support はファイルの静的書き換えのみ。`pull_request_target` は使わない
- **公開日時はレジストリ側の記録のみを信頼**: npm registry `time` / Go proxy `.info` / GitHub Releases `published_at`。コミット日時・タグ日時は作者が偽装できるため使わない（確認できない場合は fail ではなく warn）
- **ツールは checksum 検証付きで導入**: pinact / frizbee のバージョンと SHA256 は `actions/setup-tools` にコミットされ、更新は PR レビューを通る
- **Docker registry egress は制限する**: `pin-docker` の fix モードは既定で `docker.io`、`ghcr.io`、`quay.io` のみを解決する。private registry を使う場合は caller で `allowed-registries: docker.io,ghcr.io,quay.io,registry.example.com` のように明示する。1 実行当たりの異なる解決は既定で 50 件、各解決は 15 秒までであり、必要に応じて `max-resolutions` / `resolution-timeout` をより小さくできる。check モードは従来どおりネットワークを使わない。
- **維持更新は bot に任せる**: `pin.yaml` の `update: true` は Dependabot / Renovate 非導入リポジトリ専用（併用すると bump PR が競合する）

## 既知の制限（v1）

- cooldown-check の Docker イメージ tag 更新の日時照会は未対応（v2 予定）。`@v6` のような可動メジャータグも日時が取れないため warn になる（pin-check が SHA + 具体バージョンコメントへ誘導するので実運用では問題になりにくい）
- bun.lockb（バイナリ lockfile）は未対応。テキストの `bun.lock` を使うこと（`bun install --save-text-lockfile`）
- npm の `min-release-age` はパッケージ単位の除外が未対応（`@traptitech/*` を頻繁に入れるリポジトリでは端末側の値を短くし、CI 側の除外で担保する）

## 開発

```console
$ node --test actions/cooldown-check/test/check.test.mjs   # cooldown-check のユニットテスト
$ node --test actions/dependency-policy/test/check.test.mjs # dependency-policy のユニットテスト
$ python3 tests/pin_docker_test.py                          # pin-docker の回帰テスト（ネットワーク不要）
```

自リポジトリの CI でも同じテストと pin-check の dogfood を実行している。
