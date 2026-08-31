🌐 **日本語** | [English](README.md)

---

# cctag

<img src="assets/icon.png" alt="cctag icon" width="120" />

Slackのスレッドを、**自分のPCでローカルに動いているコーディングエージェントのTUIセッション**
（Claude CodeまたはCodex CLI）に橋渡しするツール。
[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)がSlackをクラウド上のセッションに
橋渡しするのと同じ発想だが、cctagは*自分自身のターミナル*を動かす点が異なる。

```
Slackスレッド (@cctag)
   ⇅ Socket Mode (@slack/bolt) — 公開サーバー不要
cctagデーモン (Node/TS, 自分のマシン上で動作)
   ├─ 入力:  herdr agent prompt   <pane_id> <text>   (テキスト＋Enterを1回で)
   ├─ 検知:  herdr agent get      <pane_id>  (idle / working / blocked / done)
   │         ＋ トランスクリプト自身のターン境界。ターンの終わりを実際に
   │           決めているのはこちら — 理由は src/settle.ts 参照
   ├─ 読取:  ペアリング中のエージェント自身のセッショントランスクリプト
   │           Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
   │           Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl
   └─ ペアリング: スレッド (channel, thread_ts) ⇔ herdrのpane_id
```

cctagは[herdr](https://herdr.dev)（ターミナルワークスペースマネージャー）経由でペアリング中の
エージェントを操作しており、tmuxの画面をスクレイピングしているわけではない。エージェントの発見、
キー入力の注入、状態検知はすべて`herdr` CLI経由で行う。ターン出力もエージェント自身の構造化された
JSONLトランスクリプトから読み取っており、画面表示をパースしているわけではない。herdrは各paneで
どちらのCLI（`claude`か`codex`）が動いているかを報告してくれるので、cctagは対応するドライバを
自動的に選択する — 1つの`@cctag` botでどちらの種類のセッションともペアリングできる。両者の違いは
[対応エージェント](#対応エージェント)を参照。

## 実際の使われ方

### 1つのセッションを複数人で操作する

スレッドとエージェントのセッションをペアリングしても、そのスレッドで話しかけられる人は制限されない
— そのスレッドにいる誰でも話しかけられる。実際には、専門分野の異なる2人が*同じ*セッションに
直接指示できるということになる。片方がもう片方とAIの間の伝言役になる必要はない。ドメインの専門家が
ドメインの問題について作業させ、エンジニアが同じスレッドで別の実装の質問をする。セッションは
どちらの文脈も拾い上げるので、どちらか一方が相手のために「翻訳」する必要がない。

同じ構図は研究以外の場面でも現れる。クライアントにAIコーディングエージェントを導入する際によくある
失敗パターンは、顧客ディスカバリーとエンジニアリングの両方に長けた1人が必要になってしまうこと
— いわゆる「Forward Deployed Engineer」に近い高いハードルだ。顧客対応の担当者とエンジニアの両方に
1つの共有セッションを操作させることで、このハードルは下がる。顧客対応の担当者がディスカバリーの会話を
進め、エンジニアはより深い技術的判断が必要な部分を担当する。そして顧客対応の担当者はその技術的な
やり取りに間接的にではなく直接立ち会い、徐々に吸収していくので、この役割分担は固定的ではない。
繰り返し使ううちに、顧客対応の担当者は日常的な作業を自分で動かせるだけの習熟度を身につけていき、
エンジニアの役割は本当に必要な決定的な瞬間だけに絞られていく。

### すでに始めてあるセッションに繋ぐ

cctagはスレッドを、**すでに動いている**エージェントのセッションに対応づける — 自分でターミナルに
起動して、そこで作業を続けてきたセッションに。読み込んであるものはそのまま残る: 開いたファイル、
途中の作業ツリー、数時間かけて積み上げた文脈。同種のツールはメンションごとに新しいセッションを
立てる作りで、それは別の — そしてしばしば行儀の良い — やり方だ。

その違いが自分にとって意味を持つのか、そして
[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)・Slack Code・
[Buzz](https://github.com/block/buzz) との比較（**それらの方が適している場合**も含む）は
[docs/comparison.md](docs/comparison.md)（英語）にまとめてある。

## ステータス

**v0.3.0** — 各リリースの変更点は[CHANGELOG.md](CHANGELOG.md)を参照。1.0未満であることは
場つなぎの表示ではなく意図的な宣言で、インターフェースはまだ動く。それが問題になるなら
バージョンを固定して使うこと。

テキスト入出力のターンは**Claude Code**・**Codex CLI**の両方でend-to-endで動作する。
複数選択肢のプロンプトにも対応しており、ペアリング中のエージェントがツール権限確認（またはCodexの
コマンド承認）メニューを表示すると、cctagはそれをSlackのボタンとして表示し、回答はターミナルに
送り返される。誰かがキーボードから直接答えた場合は、Slackメッセージがその旨を示すように更新される。

仕組みについての補足: どちらのエージェントも、保留中の権限確認・質問プロンプトを、回答され*た後*にしか
セッショントランスクリプトに書き込まない（Claude Codeの`AskUserQuestion`ツール呼び出しは結果と
アトミックに書き込まれる）。そのため保留中のプロンプトはトランスクリプトからではなく、
`herdr pane read`でターミナル画面から直接読み取っている。`src/agents/claude/prompts.ts`と
`src/agents/codex/prompts.ts`参照。

### 対応エージェント

| 機能 | Claude Code | Codex CLI |
|---|:---:|:---:|
| ターン（テキスト入出力） | ✅ | ✅ |
| ツール権限確認・コマンド承認プロンプトのSlackボタン化 | ✅ | ✅ |
| `AskUserQuestion`ボタン＋自由記述回答 | ✅ | — *(対応するツールが存在しない)* |
| `@cctag model` | ✅ `/model <name>` | ✅ モデル＋推論レベルピッカー |
| `@cctag mode` / `@cctag plan` | ✅ | — *(Shift+Tabモードリング・プランモードが存在しない)* |
| ExitPlanModeでのプランファイル添付 | ✅ | — |
| バックグラウンドウォッチャー（ターミナル起点の作業） | ✅ | ✅ |
| Slack→エージェントへの画像・ファイル添付 | ✅ 本物の画像添付になる | ✅ *(`exec`経由で読み込む)* |
| エージェント→Slackへのファイル送信（`.cctag/outbox`） | ✅ | ✅ |
| transcriptからの送信ファイル自動検出 | ✅ `SendUserFile` | — *(対応するツールが存在しない)* |

対応していない機能については、黙って失敗するのではなく、cctagがその旨を返信する
（例: Codexとペアリングされたスレッドでの`@cctag mode plan`）。

仕組みについてのより詳しい解説 — Hub/Spokeの役割分担、herdrのエージェント登録が生のペイン
アクセスとどう違うか、ターンの終わりをなぜトランスクリプトで判定するのか、AskUserQuestion検知の癖、
添付ファイルの認可の流れなど — は [docs/how-it-works.md](docs/how-it-works.md) 参照（英語）。

## cctagの2つの動かし方

- **スタンドアロン** — 自分でSlack appを作成し、1台のマシンで完結させる。cctagを使うのが自分だけなら
  これが一番シンプル。
- **Hub–Spoke** — 1つの共有Slack app、常時稼働の**Hub**を1つ、そして人数分の軽量な**Spoke**。
  同じ`@cctag` botを2人以上で使いたくなった時点で必要になる: SlackのSocket Modeは、
  1つのappの複数の接続のうち*どれか1つ*にしかイベントを配送しない。そのため同じSlack appトークンに
  対して各自がフルのデーモンを動かすと、お互いのイベントを奪い合うだけで共有はできない。Hubは
  唯一のSocket Mode接続を保持し、イベントのルーティングだけを行う — 誰のコーディングエージェント
  セッションも実行しないし、見ることもない。各Spokeは認証済みのWebSocketでHubに接続しに行き、
  スタンドアロンモードと全く同じように、その人自身のローカルなherdr管理下のインスタンス
  （Claude Code、Codex CLI、あるいはその両方）を操作する。

**すでに誰かが運用しているHubに参加できる場合**は、下記の
[Spoke利用者向け](#spoke利用者向け)だけで十分 — そこまで読み飛ばして構わない。Slack app関連の
セットアップは一切不要。

## 必要なもの

- **Node.js 20以上** — Hub・Spoke・スタンドアロンいずれの場合もマシン全てで必要。
- **[herdr](https://herdr.dev)** をインストールして起動し、自分のClaude Code・Codex CLIインスタンスを
  herdrのAgentとして登録しておくこと — 実際にこれらのCLIが動くマシン（スタンドアロン、および各Spoke）
  でのみ必要。Hub専用マシンはどちらも一切実行しないため、herdrは不要。
- **Slack appを作成できるワークスペース**（Socket Mode使用、公開サーバーやポート開放は不要）
  — 自分でSlack appを作る場合（スタンドアロン、またはHub運用者）にのみ必要。Spoke利用者はSlack app
  の認証情報には一切触れない。

各エントリポイント（`cctag`、`cctag-hub`、`cctag-spoke`）は `--version`/`-v` でバージョンを表示して
終了する。タグ付きリリース（`v*`）では `.github/workflows/release.yml` により macOS/Linux
（arm64/x64）向けのスタンドアロンバイナリが `bun build --compile` でビルド・公開される —
そのバイナリを実行するだけならNode.jsのインストールは不要（ソースからビルドする場合は下記参照）。

### herdrのインストール（macOS向け注意点）

herdrのインストールは**どちらか一方の方法だけ**にすること — Homebrewか[公式インストーラ](https://herdr.dev)
のいずれか。両方入れると`herdr`バイナリが2つPATH上に存在することになり、`CCTAG_HERDR_BIN`の指定先が
曖昧になる。

```bash
brew install herdr
brew services start herdr   # herdrはlaunchd経由のバックグラウンドデーモンとして動く
```

自分のターミナルをherdrのAgentとして登録する — Agent名を`--cwd`より*先に*指定する。使いたいCLIごとに
（Claude Code・Codex CLI、あるいはその両方）1回ずつ行う:

```bash
# Claude Code
herdr agent start <name> --cwd <project-dir> -- claude
herdr integration install claude

# Codex CLI
herdr agent start <name> --cwd <project-dir> -- codex
herdr integration install codex
```

Node.jsを`nvm`で管理している場合、launchd経由で起動したherdrデーモンは`.zshrc`/`.zshenv`を読み込まず、
最小限の`PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`）しか持たないため、`claude`/`codex`や`node`を
見つけられない。nvmのbinディレクトリを明示的に渡すこと:

```bash
herdr agent start <name> --cwd <project-dir> \
  --env PATH="$HOME/.nvm/versions/node/<version>/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  -- claude
```

`herdr agent list`で自分のAgentが`idle`と表示され、`agent`フィールドが期待通り`claude`か`codex`に
なっていることを確認してから先に進むこと。

Codex CLIのセッションIDをherdrに完全に報告させるには、`herdr-agent-state.sh`のSessionStartフックを
一度だけ対話的に信頼する必要がある（統合をインストールした後、Codexを初めて実行した時に出る
承認プロンプト — ディレクトリの信頼ダイアログと同様）。これを行わなくてもcctagは動作する
（ペアリング中ターミナルの作業ディレクトリを手がかりにセッションを探すフォールバックに切り替わる）。

## セットアップ

どちらの側にいるかで読むものが決まる。

| 立場 | 読むもの |
|---|---|
| 誰かが運用しているHubに参加する | [docs/spoke-setup.md](docs/spoke-setup.md)（英語） |
| Hubを自分で立てる（またはスタンドアロン） | [docs/running-a-hub.md](docs/running-a-hub.md)（英語） |
| すでにペアリング済みで、何ができるか知りたい | [docs/usage.md](docs/usage.md)（英語） |

大まかには、Spoke利用者に必要なのはherdrと、Hub運用者から受け取るトークンと、設定ファイル4項目。
Hubを立てる人はそれに加えてSlack appの作成とトークンの発行を行う。スタンドアロンはHubとSpokeを
1台のマシンの1プロセスにまとめた形。


## セキュリティに関する注意

ペアリング済みのスレッドに投稿できる人は誰でも、フル権限のローカルコーディングエージェントに任意の
テキストを送り込める。ペアリングはスレッドごとにownerのopt-inで行われ、ownerはいつでも切断でき、
ツールの権限確認プロンプトもSlackのボタンによる人間の承認を必要とする — 何も無人では実行されない。
信頼できる人がいるチャンネルのスレッドでのみペアリングすること。

## 開発に参加する

[CONTRIBUTING.md](CONTRIBUTING.md)（英語）を参照 — 検査の走らせ方、レビューで見られる点、
実機のペインでしか検証できない部分、リリース手順。

## License

MIT — `LICENSE`参照。
