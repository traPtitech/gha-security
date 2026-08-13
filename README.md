# gha-security

traPtitech のリポジトリで、レビューを経ない依存物の実行経路とmutable referenceを減らすための共通 GitHub Actions 集です。

- **pinning**: GitHub Actions の `uses:` を40桁commit SHA、代表的なDocker image参照を`@sha256:` digestに固定する
- **JS再現性**: direct dependencyのexact version、lockfileの存在、明白な非frozen installを検査する
- **cooldown**: npm / GitHub Actionsの公開直後の更新を短期quarantineし、同一versionのnpm artifact identity差替えを防ぐ

## 提供するもの

### 再利用ワークフロー（`.github/workflows/`）

| ワークフロー | 役割 | 呼び出し元の推奨トリガー |
|---|---|---|
| `pin-support.yaml` | PR 内の未固定参照を検出し、**修正を suggestion または直接コミットで返す**（作業の肩代わり） | `pull_request` |
| `pin-check.yaml` | 未固定参照があれば fail する退行防止 lint（`--verify-comment` でコメント偽装も検出） | `pull_request` |
| `cooldown-check.yaml` | npm / GitHub Actionsの公開 N 日未満の版、または同一versionのnpm artifact identity変更があれば fail。公開日時を取得できない場合は warning。違反内容は **sticky な PR コメント**（bot コメント1つを更新）でも通知され、解消すると ✅ に変わる | `pull_request` |
| `dependency-policy.yaml` | `package.json` のrange / dist-tag、lockfile不在、明白なJS non-frozen installをfailする。Goの`go.sum`不在や`GOSUMDB=off`はwarningする | `pull_request` |
| `pin.yaml` | リポジトリ全体を固定して PR を作成。`update: true` で bot なしリポジトリの追従更新も担う | `schedule` / `workflow_dispatch` |

### Composite actions（`actions/`）

| action | 内容 |
|---|---|
| `actions/cooldown-check` | npm系lockfile・`package.json`厳密指定・workflowの`uses:`に対するcooldown本体。npm `package-lock.json`では**同一file・同一installation path・同一version**の`resolved` / `integrity`変更をfailする。公開日時取得不能・上限超過はwarning。Go cooldownは行わず、checksum状態はdependency-policyへ委譲する |
| `actions/dependency-policy` | `package.json` direct dependencyのsemver range / dist-tag、lockfile不在、workflowの明白なJS non-frozen installを拒否する。複雑なYAML/shell意味解釈は行わない。Goの`go.sum`不在・`GOSUMDB=off`はwarningする |
| `actions/pin-docker` | Dockerfile `FROM`、Compose `image:`、Actions `container.image` / `services.*.image` / `uses: docker://` のdigest固定。BuildKit全構文やremote build sourceの解析は対象外 |
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

しきい値の標準: **npm 3日 / GitHub Actions 3日**。組織内依存も既定で検査対象であり、例外は caller の `exclude` / `*-exclude-regex` に明示する。
`cooldown-override` は公開日時cooldownだけをスキップする。**同一versionのnpm artifact identity変更はoverrideや`npm-min-age-days: 0`でもfailする**。
外部registry / GitHub APIの日時取得不能やlookup上限到達はwarningであり、日常的なAPI障害ではPRを止めない。

## 機能のオン/オフ

すべての機能は**リポジトリ単位で独立してオプトイン/オプトアウト**できる。全部入りは強制しない。

| 機能 | オンにする方法 | オフにする方法 / 部分無効化 |
|---|---|---|
| pin-support | caller に job を書く | job を書かない。`pin-docker: false` で Docker 部分のみ無効化 |
| pin-check | caller に job を書く | job を書かない。`pin-docker: false` / `verify-comment: false` |
| cooldown-check | caller に job を書く | job を書かない。`npm-min-age-days: 0` / `actions-min-age-days: 0`で**公開日時cooldownのみ**を無効化（0のecosystemは照会しない）。npm artifact identity検査は独立して継続する。`pr-comment: false`でPRコメント通知のみ無効化。`max-lookups` / `lookup-timeout`で外部通信をさらに制限 |
| pin.yaml（定期固定PR） | caller を配置 | 配置しない。`update: false`（デフォルト）で追従更新のみ無効化 |
| クライアント側 cooldown | `templates/client-cooldown/` の設定をコミット | コミットしない／ファイルを消す（CI 側の cooldown-check とは独立） |
| dependabot.yml | テンプレを参考に配置 | cooldown ブロックを消せばデフォルト（3日）に、`cooldown: {default-days: 0}` で無効に |
| renovate-config | `extends: ["github>traPtitech/renovate-config"]` | extends しない。一部だけ無効化する場合は extends の後に上書き（[renovate-config の README](https://github.com/traPtitech/renovate-config) 参照） |

## セキュリティ上の設計原則

- **PR のコードは実行しない**: pin-support はファイルの静的書き換えのみ。`pull_request_target` は使わない
- **公開日時はregistry/APIの記録を利用するが、取得不能はwarning**: npm registry `time` / GitHub Releases `published_at` を使う。API障害・rate limit・release未作成でPRをfailしない
- **Goのmodule integrityは既存機構を尊重する**: `go.sum`がない外部moduleと、repository内で明白な`GOSUMDB=off`をwarningする。Go moduleの公開日時cooldownやproxy lookupは行わない
- **npm artifact identityはcooldownから独立**: 同一versionの`resolved` / `integrity`差替えは、cooldown override・threshold 0・日時照会失敗とは別にfailする
- **外部lookupはbounded**: cooldownは既定で1 PRあたり50件、各15秒まで。上限到達はwarningし、必要に応じて`max-lookups` / `lookup-timeout`をより小さくできる
- **Docker registry egressは制限する**: `pin-docker` fixモードは既定で`docker.io`、`ghcr.io`、`quay.io`だけを解決する。private registryはcallerで明示許可する。1実行当たりの異なる解決は既定50件、各15秒までであり、checkモードはネットワークを使わない
- **維持更新は bot に任せる**: `pin.yaml` の `update: true` は Dependabot / Renovate 非導入リポジトリ専用（併用すると bump PR が競合する）

## 既知の制限（v1）

- Docker imageの公開日時cooldownは対象外。`FROM`、Compose `image:`、Actionsの`container.image` / `services.*.image` / `uses: docker://`はdigest pinningで扱う。Dockerfile全構文、remote build context、`ADD` URLは解析しない
- bun.lockb（バイナリ lockfile）は未対応。テキストの `bun.lock` を使うこと（`bun install --save-text-lockfile`）
- npm の `min-release-age` はパッケージ単位の除外が未対応（`@traptitech/*` を頻繁に入れるリポジトリでは端末側の値を短くし、CI 側の除外で担保する）

## 開発

```console
$ node --test actions/cooldown-check/test/check.test.mjs   # cooldown-check のユニットテスト
$ node --test actions/dependency-policy/test/check.test.mjs # dependency-policy のユニットテスト
$ python3 tests/pin_docker_test.py                          # pin-docker の回帰テスト（ネットワーク不要）
```

自リポジトリの CI でも同じテストと pin-check の dogfood を実行している。
