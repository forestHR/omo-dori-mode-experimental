[English](README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md)

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# omo-dori-mode-experimental

Dori モードは、コーディングエージェントのセッションひとつを常駐型のメッセンジャーエージェントに変えます。あなたが話す相手は Telegram か Discord のボットひとつだけ。Dori は仕事ごとに herdr のタブか aoe/tmux セッションでエージェントを立ち上げて任せ、自分が立ち上げたセッションをすべて覚えておき、仕事が本当に終わったときだけ閉じます。PR がマージされ、issue が閉じ、バージョンが公開されたあとです。

中身はスキル(`skills/dori-mode/SKILL.md` と references)と、bun + TypeScript の小さな CLI `dori` です。実験段階なので、粗いところがあります。

## インストール

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | bash
```

リポジトリを `~/.dori/src` に取得し、スキルを `~/.agents/skills/dori-mode` にリンクし、`bun link` で `dori` を PATH に通し、設定の例を `~/.dori/config.json` にコピーします。エージェントが別の場所からスキルを読む場合は `SKILLS_DIR` を指定してください。

既定のバックエンドは herdr です。aoe/tmux を使うなら:

```sh
curl -fsSL https://raw.githubusercontent.com/orientpine/omo-dori-mode-experimental/main/install.sh | DORI_BACKEND=aoe bash
```

`DORI_BACKEND=aoe` は設定ファイルがない場合に `backend: "aoe"` の設定をコピーします。既存の設定はバックエンドも含めて保持します。`leadPane` はリードの aoe/tmux セッション名に設定してください。`DORI_REPO` でクローン URL を変えられます。PATH に herdr も aoe + tmux もなければ警告し、`gh` と `agent-messenger` がない場合は任意ツールの警告です。既存インストールの origin がこのフォーク(または指定した `DORI_REPO`)でなければ、警告と変更用コマンドを表示し、リモートを黙って変更したり古い origin から pull したりしません。

あとは herdr の中、aoe バックエンドなら aoe セッションの中でエージェントを開いて「Dori mode」と言うだけです。Discord + aoe/tmux のサービス設定一式は [`setups/discord-aoe`](skills/dori-mode/setups/discord-aoe/README.md) にあります。日々の運用で得た教訓(完了の申告でレーンが閉じること、所有者の回答を待つレーンの一時停止、スクリプト更新の反映、シャドー実行によるリスナーの切り替え)は [`references/operating-lessons.md`](skills/dori-mode/references/operating-lessons.md) にあります。

## 必要なもの

- [bun](https://bun.sh) 1.3 以上と git
- レーンのタブ用の [herdr](https://herdr.dev)、またはセッション用の [agent-of-empires (aoe)](https://github.com/njbrake/agent-of-empires) と `tmux`
- スキルを読み込むコーディングエージェント([OmO](https://github.com/code-yeongyu/oh-my-openagent) 向けに作っていますが、起動コマンドは設定で変えられます)
- PR のマージと issue のクローズを確認する `gh`(GitHub CLI)、公開バージョンを確認する `npm`
- ボット本体のための [agent-messenger](https://github.com/agent-messenger/agent-messenger)

ホスト監視は macOS ですべて動きます。Linux では負荷とディスクだけを見て、メモリとスワップは不明として扱います。

## Dori の名前

Dori は最初に、自分を何と呼べばいいかを聞いてきます。「Dori」のままでもいいし、ShipDori や WorkDori のように Dori で終わる名前でも構いません。複数動かすときに見分けやすくなります。決めた名前はボット名、メッセージの署名、モード名にそのまま使われ、次からは「ShipDori mode」の一言で戻せます。

## Slack で使うとき

Slack を選ぶと、Dori はもうひとつ質問して答えを待ちます。

- **ユーザートークン**:ワークスペースの本物のメンバーとして動きます。有料の席がひとつ必要で、その費用はあなたが払います。そのメンバーが見られるものはすべて読め、緑のオンライン表示も保てます。
- **ボットトークン**:Slack アプリとして動きます。席の費用はかかりませんが、招待されたチャンネルと、アプリに与えた権限の範囲しか見えません。

## Dori の話し方

Dori はあなたの話し方に合わせます。短く、くだけた調子で、小文字で書けば、同じように返します。メッセージには絵文字ではなく言葉を使いますが、`discord.statusStyle` が `"emoji"` なら Discord の状態マークに絵文字を使えます。リスナーは目のリアクションを既読表示に使います。伝えることがいくつかあるときは、長い文章ひとつではなく短いメッセージに分けて送り、それぞれ用意できた時点ですぐに送ります。わざと間をあけることはしません。刻々と変わる進捗だけは例外で、ひとつのメッセージをその場で書き換えていきます。

## 設定

設定はすべて `~/.dori/config.json` にあり、どの項目も省略できます。たいてい決めておくのは次の項目です。

| 項目 | 意味 |
|---|---|
| `backend` | `"herdr"`(既定)または `"aoe"` |
| `leadPane` | Dori 自身の herdr pane(`herdr pane current`)、または aoe の tmux セッション名(`tmux display-message -p '#S'`)。レーンの報告はここに届きます。 |
| `laneWorkspace` | 新しいレーンのタブを開く herdr workspace。aoe では使いません |
| `ignorePanes`, `workspaces` | 監視から除外する pane と workspace のフィルター。aoe では tmux セッション名とプロファイル名を使い、`workspaces` は空でも構いません |
| `defaultCwd` | レーンが始まるディレクトリで、レーンが worktree を作るリポジトリ |
| `agentCommand` | エージェントの起動コマンド。`{model}` と `{prompt}` を含む argv のリスト |
| `hooks.threadReply`, `hooks.threadDone` | メッセンジャー CLI を `{thread}` と `{text}` を含む argv のリストで。レーンの進捗投稿と完了表示に使います。 |
| `discord.statusStyle` | Discord の状態マークを `"words"`(既定)または `"emoji"` に設定 |
| `discord.autoUnEye` | `true`(既定)ならボットがそのチャンネルやスレッドに書き込んだとき、`dori inbound discord` が所有者のそれ以前のメッセージから目のリアクションを外す。`false` なら残す |
| `discord.quietText`、`discord.postRawReports` | `freshness` が所有者のスレッドに投稿する文(`{min}` = 最後の報告からの分数)を所有者の言語で。レーンの報告はスレッドではなくリードへ。`postRawReports: true`(既定 `false`)ならそのまま投稿。クローズはレーンの所有者向けまとめ(`claim-done --summary`、なければモデルが書く)を先に投稿してからスレッドを完了にし、まとめがなければ閉じない |

残り(時間、しきい値、heavy スロット数)は既定値で十分です。全項目の表は [`references/scripts.md`](skills/dori-mode/references/scripts.md) にあります。環境変数 `DORI_CONFIG`、`DORI_STATE_DIR`、`DORI_LEAD_PANE` はファイルより優先されます。

### aoe/tmux レーンを開く

リードも aoe の中で動かし、たとえば次のように設定します。

```json
{
  "backend": "aoe",
  "leadPane": "aoe_Dori_0a1b2c3d",
  "agentCommand": ["omo", "--model", "{model}", "{prompt}"],
  "workspaces": [],
  "discord": { "statusStyle": "emoji" }
}
```

エージェントは aoe のツールとして利用可能である必要があります(`aoe agents` が組み込み一覧、カスタムツールは aoe の設定に登録)。herdr では `agentCommand` が argv テンプレート全体です。aoe では `agentCommand[0]` だけがツールを選び、モデルは `--extra-args` で渡し、残りの引数は使いません。

brief を用意し、どちらのバックエンドでも同じコマンドでレーンを開きます。

```sh
dori launch fix-login --title "Fix login" --brief ~/.dori/briefs/fix-login.md \
  --done "merged acme/app#412" --thread discord:100000000000000001
```

herdr はタブを開きます。aoe は `aoe add <cwd> -t <key> --tool <tool> -l --extra-args "--model <model>"` を実行し、エージェントの `❯` プロンプトを最大 3 分待ってからレーンのプロンプトを入力します。起動失敗は `STARTUP_ERROR` になります。aoe でレーンのプロンプトから 20 秒後に実行中のターンも `❯` プロンプトも見えなければ、最後の行とともに `STARTUP_UNCONFIRMED`(exit 3)になります。レジストリの pane は `aoe_fix-login_1a2b3c4d` のような tmux セッション名です。aoe は同じタイトル/パスの組み合わせがゴミ箱にある場合も拒否します。

footer はレーンに `[REPORT] <key> | <milestone|blocker|question|done> | <text>` をリードへ送るよう指示します。aoe ではシェル文字列ではなく、2 つの argv 配列で送ります。

```json
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "-l", "--", "[REPORT] fix-login | milestone | tests passed"]
["tmux", "send-keys", "-t", "=aoe_Dori_0a1b2c3d:", "Enter"]
```

`dori freshness` はまずリードの画面から報告を読み、次にレーンの画面を見ます。新しい報告は沈黙のタイマーをリセットします。既定では 15 分後に声をかけ、20 分後に `hooks.threadReply` で所有者の言葉の短い状況一行(`discord.quietText`)を投稿し、それぞれ沈黙の期間につき 1 回実行します。レーンの報告そのものはリードの画面に送り、リードが人の言葉でまとめます。`discord.postRawReports: true` なら以前のように報告をそのまま投稿します。 レーンの上限と止まったように見える呼び出しも確認します(`supervision`。上限は既定でオフ)。上限に達するか呼び出しが止まったように見えると、リードに一度だけ知らせ、レーンを止めたりレーンに入力したりはしません。`close` はレーンの `COST` を表示します。

aoe では `dori watch` が、working または not-done のレーンが人を待って止まると `LANE_BLOCKED <key> <waiting|error|question|idle> <pane>` を出力します。`aoe ps --json` と画面を合わせて判断し、ターンの実行中は出力しません。idle は 45 秒続く必要があり、モニター、wake source、実行中や予約済みの goal を待つ状態は idle ではありません。セッション自身が始めた切り離し済みの eval セル、バックグラウンド bash セッション、バックグラウンド task を待つ状態も idle ではなく、監視ログに静かな `BG_WAITING` 行だけを残し、`blockedWaitMin`(既定 60 分)を過ぎると `LANE_BLOCKED` になります。閉じると aoe セッションを停止してゴミ箱に移し、完全削除はしません。

## オンボーディング

最初のセットアップで、Dori は何かを読む前にまず許可を求めます。使っているツール、何をなぜやっているのか、あなたと会社がどんなところかを知ってもいいか、と。許可があったときだけ、ツールをひとつずつ見ていきます。ツールごとに、どの連携を使い、それが何を読むのかを説明してから個別に聞きます。たとえば「Gmail とカレンダーを読む CLI で、予定とメールを見守ってもいいですか?」という具合です。断られたツールは飛ばし、断られたことも覚えておきます。

全体を通して読むだけです。わかったことはその都度メモリに書き、最後に、わかったことと足りないところを短くまとめて伝えます。手順の詳細は [`references/onboarding.md`](skills/dori-mode/references/onboarding.md) にあります。

## 依頼の振り分け

メッセージごとの扱いは Dori が自分で決めます。

- 質問、状況確認、調べものは、新しいセッションを開かずにその場で答えます。一行の修正や設定値ひとつでも、何かを変える仕事はすべてレーンに任せ、スレッドと Done チェック付きで見えるようにします。
- PR で終わるコード作業、何段階もある仕事、長くかかる仕事や並列にできる仕事はレーンを開きます。そのリポジトリを担当していて手が空いているレーンがあれば、新しく開かずにそちらへ渡します。
- メモリ、ディスク、pane 数に余裕がないとき(`dori can-launch` が HOLD)は何も開きません。仕事を待ち行列に入れ、理由を伝えます。
- 新しい仕事は新しいスレッドで始めます。続きの話は元のスレッドに戻し、レーンが閉じていれば記録してあるセッションを開き直します。ちょっとした質問は、聞かれたその場で答えます。

## セッションレジストリ

レーンごとに `~/.dori/state/lanes/` の下に JSON ファイルがひとつできます。メッセンジャーのスレッドと herdr の pane または aoe の tmux セッション名、pane とエージェントのセッション id を結びつけ、状態(`working`、`done-claimed`、`verified-done`、`not-done`、`paused`、`closed`)とその変化の履歴を残します。

`dori sync` はこの記録を実際に動いている pane と突き合わせて、ずれを教えてくれます。消えた pane、変わったセッション id、完了を証明する手段がないレーンなどです。何も削除しません。`--write` を付けると、見つけたセッション id を保存します。

## 5 分の完了フロー

レーンが完了を申告します。

```sh
dori claim-done fix-login --evidence "merged acme/app#412 (a1b2c3d)"
```

Dori には `LANE_DONE_CLAIMED` が届き、レーンには 5 分後に閉じると伝わります。その間に異議を出せます。

```sh
dori object-done fix-login --reason "changelog の項目が抜けている"
```

理由はそのままレーンに届き、レーンは直してからもう一度申告します。誰も異議を出さなければ、時間が来たところで `dori watch` がレーンを閉じます。閉じる前に `Done =` のシグナルをすべて実際に読み直し、worktree にリモートへ届いていないコミットや未コミットの変更があれば閉じません。その場合、申告は理由付きで not-done に戻ります。watcher を再起動しても、5 分の時計は最初からにはなりません。その間に新しい仕事を渡すと申告は取り消されます。`dori type` でレーンに指示を入れるか、静かになったレーンがまたターンを回すと、監視ログに `LANE_CLAIM_REOPENED` が残り、レーンは仕事を続けてからもう一度申告します。すでに閉じたレーンに `dori type` すると、いつ誰が閉じたかと一緒に `LANE_IS_CLOSED` と返します。

### 何をもって完了とするか

レーンの `Done =` 行には、watcher が自分で確かめられるシグナルを書きます。
- PR のマージ
- issue のクローズ
- パッケージのバージョン公開
- PR で終わらない仕事(ローカルのセットアップ、QA、立ち上げたサービス)なら、終了コード 0 で終わるコマンド、ハッシュや JSON の値が合うファイル、期待どおりのステータスと本文で応答する URL

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

watcher はレーンを閉じるときに、シェルを通さずこの確認を自分で実行し直し、レーンの言い分をそのまま信じることはありません。解釈できないシグナルは、レーンの起動時に拒否します。文法の全体は [`references/sessions.md`](skills/dori-mode/references/sessions.md) にあります。

## コマンド

| コマンド | やること |
|---|---|
| `dori launch <key> ...` | brief にレーンの footer を書き、herdr タブか aoe セッションを開き、エージェントを起動し、起動エラーを確認。`Done =` のシグナルがすべてファイルや文字列の確認だけなら `LAUNCH_DONE_WEAK` を警告(レーンはそのまま開く)、`--done-weak-ok` で止める。`--ui` はオーナーの UI 7 ステップ([ui-work.md](skills/dori-mode/references/ui-work.md))を brief の先頭に入れ、UI の仕事に見える brief に `--ui` がなければ `LAUNCH_UI_HINT` を警告(レーンはそのまま開く)。オーナーの 8 ステップ([sessions.md](skills/dori-mode/references/sessions.md))が一つもない brief には四つの欄の後にそのまま入れ(`LAUNCH_STEPS_ADDED`)、一部だけなら何も足さず `LAUNCH_STEPS_PARTIAL` を警告; オーナーの指針台帳([directives.json](skills/dori-mode/references/directives.json)とホストのローカルファイル)のうち対象範囲なのに brief にない指針はそのまま追加し(`LAUNCH_DIRECTIVE_ADDED`)、必須の指針がなければ停止(`LAUNCH_DIRECTIVE_MISSING`、終了コード 4、`--waive <id> "<理由>"` でのみ通過);`dori directive-audit` が毎朝前日のレーンを台帳と照合 |
| `dori adopt <key> --pane ID ...` | すでに動いているレーンを登録 |
| `dori sync [--write]` | レジストリと実際の pane を比べ、ずれを表示 |
| `dori claim-done` / `object-done` / `close` | 完了フロー。`DORI_DISCORD_TOKEN` があれば、close は `discord:` の作業スレッドを完了にしてアーカイブする |
| `dori pause <key> <理由>` / `dori resume <key>` | 人を待っているレーンを止めておく。freshness の催促・投稿、`LANE_BLOCKED`、`DEAD_PANE` を出さず、完了申告が来ても自動では閉じない。aoe ではレーンのセッションの omo goal も止めて読み戻す(`/goal pause`、確認できなければ `PAUSE_UNVERIFIED`、exit 3)。`resume` で止める前の状態と止めた goal を戻す |
| `dori watch` | 自動クローズの watcher と aoe の `LANE_BLOCKED` イベント。常駐モニターとして動かします |
| `dori freshness [--loop MIN]` | 静かになったレーンに声をかけ、スレッドに短い状況一行を投稿し、最後の報告はリードに渡す |
| `dori dead-panes [--loop MIN]` | 止まったエージェントの pane を報告 |
| `dori guard [--loop MIN]` | 負荷、メモリ、ディスク、pane 数の警告 |
| `dori fix-attempt <key> --metric M --hypothesis H` | レーンに頼んだ修正を 1 回数える。レーンはそうした報告に `(fix: M / H)` を付け、同じ指標・同じ仮説で 3 回目になると `SAME_FIX_3` が根本原因の調査に切り替えるよう知らせる。記録の前に、その指標で既に試した仮説(`PRIOR_FIX`)を表示する |
| `dori checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...` / `dori checkpoints <key>` | レーンが終えた手順を一度ずつ、行ったリモート操作(push、merge)の受領記録とともに書き、再開前に読み戻す。再起動したレーンが push や merge を繰り返さない。同じ手順を別の内容で書くか、別の手順が既に持つ受領記録を書くと拒否 |
| `dori caps <key> [--wall-minutes N\|none] [--token-limit N\|none] [--cost-limit N\|none]` | レーンの経過時間(分)・トークン・費用の上限(既定はオフ。`launch` も同じフラグを受け取る)。上限に達すると `freshness` がリードに一度知らせ(`LANE_CAP`)、レーンは止めない。フラグを付けるとそのレーンの上限を設定 |
| `dori signals [--lane K \| --cwd DIR \| --tag T]` | ある作業領域で過去のレーンが何を試し、どうなったか: 番号付きの修正試行と根本原因調査への切り替え(`[REPORT]` 行とリードの再指示からも読む)、指標ごとのタグ付き修正、理由付きの完了申告の却下、再送・催促の数、結果、領域の却下率・手戻り、警告。レーンに再指示する前に読む |
| `dori scorecard [--date D] [--post]` | 記録だけから出す 1 日のトークン成績表(モデル呼び出しなし): 検証済み完了あたりのコストと完了申告の却下率を並べて、手戻りの多いレーン上位、最初の返信の中央値/p90、リードのコンテキスト税。リードが読むため `<stateDir>/scorecard/<日付>.json` と `latest.md` に保存、`--post` で Discord にも送る(既定はオフ。毎日保存する systemd timer は Discord + aoe セットアップにある) |
| `dori heavy <label> [--mem 70G] -- <cmd>` | 負荷が低いときにビルド・テスト・GPU ジョブをメモリ上限付きの専用 scope で実行（超えたらそのジョブだけ止まり、レーンは残る）。実行中のジョブがあれば GPU・メモリ・CPU がそれぞれ 10% 以上残るときだけ同時に実行 |
| `dori heavy <label> --kind browser\|cpu --sync DIR -- <cmd>` | 同じジョブを空いている PC で実行。ヘルパーホストが `--sync` フォルダを受け取り、ネットワークなしの箱で動かし、変わったファイルを戻す |

pane に送る文字列は必ず引数ひとつとして渡し、シェル文字列を通しません。Enter が本当に入ったかも確認します。

## ユーティリティ

CLI には、Dori に必要なメッセンジャーまわりの機能も入っています。`scripts/src/messenger/` の型付きモジュールとして取り込むこともできます。

| コマンド | やること |
|---|---|
| `dori send slack\|telegram\|discord --to T --text X [--thread ID] [--edit ID]` | メッセージの送信と編集。レート制限は待ってから送り直し、`$(` を含む文字列は拒否します |
| `dori send slack --to C --file PATH [--file PATH ...] [--text X] [--thread TS]` | ファイルを最大 10 個（1 個 1GB まで）アップロードし、文字列と一緒に Slack の 1 メッセージとして共有します。存在しない・空・大きすぎるファイルは送信前に拒否します |
| `dori presence slack\|discord` | アカウントをオンライン表示のまま保つ。Discord ボットはゲートウェイで、Slack のユーザーアカウントは 1 分ごとに合図を送る Web クライアント型ソケットで保ちます |
| `dori transcribe <file>` | `hooks.transcribe` のコマンドで音声メッセージを文字にする |
| `dori can-launch` | もうひとつレーンを開く余裕があるかを確かめる |
| `dori inbound slack [--loop MIN]` | Slack で Dori 宛てのものを取りこぼさない。Threads 画面の未読の返信、Dori が書き込んだスレッドの新しい返信(タグなしでも)、未読メンションのある DM とチャンネル |
| `dori inbound discord` | 所有者のメッセージ、音声の文字起こし、質問カードの回答を受けるゲートウェイリスナー |
| `dori ask` / `questions [--open]` / `reopen <Qn>` / `resolve <Qn>` | Discord 質問カードの投稿、一覧、再開、解決 |
| `dori thread reply\|wait\|done discord:<id> <text>` | 作業スレッドに投稿し、作業中/待機/完了を表示。完了でアーカイブ |

コマンドはなくても、モジュールで使える機能もあります。
- Telegram:「Thinking…」から始まる `sendMessageDraft` のストリーミング、フォーラムのトピック、HTML の表
- Discord:スレッドの作成、名前の変更、アーカイブ
- Slack:ファイルのアップロード
- `typingWhile`:作業が動いているあいだ入力中の表示を出しておきます

Slack で Dori が送るメッセージは、どの関数から送ってもそのスレッドを記録します。生の API 呼び出しで投稿した親メッセージの下に、タグなしで付いた返信も届きます。メッセージイベントを聞くだけのやり方では、こうした返信を取りこぼします。

トークンは `DORI_SLACK_TOKEN`(ユーザートークンなら `DORI_SLACK_COOKIE` も)、`DORI_TELEGRAM_TOKEN`、`DORI_DISCORD_TOKEN` から読みます。

### Discord の質問カードとスレッド状態

環境変数か `~/.dori/dori.env` に `DORI_DISCORD_TOKEN`、`DORI_DISCORD_GUILD`、`DORI_DISCORD_CHANNEL`、`DORI_DISCORD_OWNER` を設定します(設定済みの環境変数が優先)。ボットの Message Content intent を有効にし、ボタンや入力欄の回答を受けるため `dori inbound discord` を常駐させます。 任意: `DORI_DISCORD_PAIR_CHANNEL` は他の Dori と共有するチャンネルで、`DORI_DISCORD_PAIR_BOT` にはそのボット ID を一つ以上、カンマまたは空白で区切って指定します(例: 三つの Dori が一つの pair チャンネルを共有し、それぞれが他の二つのボットを登録)。そこでの所有者の投稿は `scope:"pair"`、登録したボットの投稿は `scope:"pair-bot"` の行(情報であり依頼ではない)になります。`DORI_DISCORD_STATE_DIR` は質問カードの保存先を変えます(既定 `<stateDir>/discord`)。`DORI_DISCORD_SHADOW_INBOX=<ファイル>` を指定すると、そのファイルにinbox の行だけを書き Discord には何も書かない二つ目のリスナーが動き、切り替え前に稼働中のリスナーと突き合わせられます。

```sh
dori ask --text "ログイン修正を公開しますか?" --option "今すぐ公開" --option "QA を待つ" \
  --thread discord:100000000000000001 --tmux aoe_fix-login_1a2b3c4d
dori questions --open
dori reopen Q1
dori resolve Q1
```

1–9 個の選択肢は、短い `Pick N` ボタンの横に全文を表示します。おすすめを先頭に置くとボタンが強調されます。自分で書くボタンは入力欄を開きます。回答できるのもメンションされるのも所有者だけです。回答するとカードは記録に折りたたまれ、`~/.dori/state/discord/` の `answers.jsonl` とリスナーの inbox に保存されます。`--session` と `--tmux` の情報で回答を渡すセッションを識別します。

`--thread` を付けると、その作業スレッド内にカードを投稿し、待機状態にします。回答はその場で記録になり、別の記録行は投稿しません。同じスレッドに未回答の質問がなくなれば作業中に戻ります。`dori reopen` はボタンを戻し、スレッドを再び待機状態にします。`--thread` がなければ新しいカードは設定済みのチャンネルに投稿します。スレッドに関連付けられた以前のチャンネルカードは、そのスレッドへ通知なしの回答記録を残します。後続作業が終わったら `dori resolve` で追跡から外します。折りたたまれたカードはチャットに残ります。未回答のカードを resolve で外した場合も、同じスレッドに未回答の質問がなくなれば作業中に戻るので、取り下げた質問のせいでスレッドが待機のまま残ることはありません。

`discord.statusStyle: "emoji"` はスレッド名の先頭に 🔄 作業中、⏸️ 待機、✅ 完了を付け、意図して開いたままにするスレッド(`dori thread set <ref> standing`、解除は `unstanding`)には状態に関係なく 📌 を付けます。既定の `"words"` は `[working]`、`[waiting]`、`[done]` です。マークはスレッドにだけ付きます。テキストチャンネル・フォーラム・カテゴリをスレッドとして渡しても(例: `dori ask --thread` にチャンネル id)名前は変わらず、その状態は `THREAD_STATUS_DROPPED <id> ... is not a thread` として捨てられます。`dori thread reply` / `wait` / `done` が状態を設定し、done はアーカイブ、reply/wait はアーカイブ解除します。完了スレッドに所有者が書き込むと、リスナーが作業中として開き直します。サービスやカード文言の翻訳設定は [Discord + aoe セットアップ](skills/dori-mode/setups/discord-aoe/README.md) を参照してください。

### iPhone のショートカットで音声指示

Discord の iOS アプリはショートカットから操作できないため、ボタン一つで音声指示を送るには回り道をします。iOS のショートカットで録音し、その音声を Dori のチャンネルの Discord Webhook に投稿します。`DORI_DISCORD_OWNER_WEBHOOK` にその Webhook の ID を設定すると、`dori inbound discord` はその投稿を所有者本人のボイスメッセージとして扱います。目の絵文字のリアクションを付けて文字起こしし、`"via":"owner-webhook"` 付きの行として inbox に書き込みます。ID を設定するまでは、Webhook の投稿はログ(`DISCORD_WEBHOOK_UNKNOWN id=...`)に記録されるだけです。Webhook の作成、ショートカットのアクション設定、アクションボタン・背面タップ・Siri からの起動、セキュリティの注意点は [iOS ショートカット音声指示ガイド](skills/dori-mode/setups/discord-aoe/ios-shortcut-voice.md) を参照してください。

## テスト

CI はありません。テストはローカルで回します。

```sh
cd skills/dori-mode/scripts
bun install
bun test           # 偽の herdr、aoe、tmux、git、gh、Discord HTTP/ゲートウェイで動作を確認
bunx tsc --noEmit  # 型チェック
```

両バックエンド、起動と報告の送信、freshness、停止したレーン、完了フロー、Discord カードと状態をテストします。外部ツールと Discord HTTP/ゲートウェイは偽物に置き換え、本物の pane、リポジトリ、GitHub、Discord アカウントには触れません。

## ライセンス

MIT

## Dori からの移行

以前の gist で Dori モードを使っていたなら、ボットはそのまま動きます。次の 4 つを変えれば Dori になります。

1. **Dori の名前を決める。**「Dori」だけでも、ShipDori や WorkDori のように Dori で終わる名前でも構いません。エージェントに「これからきみの名前は ShipDori で、これは ShipDori mode だよ」と伝えてください。それ以降は「Dori mode」ではなく「ShipDori mode」がモードを呼び出す言葉になります。
2. **ボットの名前とプロフィール画像を変える。**
   - Telegram:@BotFather で `/setname` を送り、ボットを選んで新しい名前を送ります。続けて `/setuserpic` を送り、ボットを選んで新しい画像を送ります。既定の Dori の絵は [`skills/dori-mode/assets/dori-avatar.png`](skills/dori-mode/assets/dori-avatar.png) です。好きな画像に替えても構いません。ボットの名前と画像は BotFather からしか変えられません。
   - Discord:Developer Portal でアプリケーションを開きます。**Bot** ページでユーザー名とアイコンを、**General Information** でアプリ名とアイコンを変えて(同じ既定の絵が使えます)保存します。
3. **このリポジトリを入れる。** 上の 1 行インストールを実行し、エージェントに「ShipDori mode」と言えば、以前貼り付けていたプロンプトの代わりにスキルと `dori` CLI を使います。
4. **オンボーディングをする。** Dori のときにやっていなければ「オンボーディングして」と言うだけです。

これまでのスレッド、トピック、メモリはそのまま残ります。
