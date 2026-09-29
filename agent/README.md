# PC 側（Multitasker PC Agent）

盤の枠に入れたコマンドを、この PC で実行する常駐プログラムです。Windows のみ。
トレイに小さな丸いアイコンが出て、盤に一本つないだまま指示を待ちます。

- **緑** = 接続済み ／ **黄** = 接続中・再接続中 ／ **灰** = 未設定 ／ **赤** = 盤にトークンを拒否された（登録し直しが要る）
- 右クリックで **設定… ／ 再接続 ／ 終了**。ダブルクリックで設定。
- 日本語／英語は Windows の表示言語に従います。

約束事（盤との通信・暗号文の形・5 秒ルール）は [../docs/DECK_AGENT_PROTOCOL.md](../docs/DECK_AGENT_PROTOCOL.md) にあります。このプログラムはそのとおりに動きます。

## 入れ方（3 手）

1. 盤の **設定 → PC → ① ダウンロード** で `DeckAgentSetup.exe` を落として実行（管理者権限は不要。
   `%LOCALAPPDATA%\Programs\Multitasker PC Agent` に入り、ログオン時に起動する登録と `multitasker://` の受け口の登録も一緒に入ります）。
   終わると起動して、案内の窓が開きます。
2. **同じ PC のブラウザ**で、盤の **設定 → PC → ③ この PC をつなぐ** を押す。
3. ブラウザが `multitasker://pair#…` のリンクを開き、このプログラムが盤のアドレス・トークン・鍵を受け取って `agent.json` に書き、接続します。
   トレイに「接続しました」と出て、盤の PC 欄が **接続済み ✓** になれば完了。枠を押すとこの PC で動きます。

**スマホから設定している**場合や、**リンクをブラウザが渡せなかった**場合は、盤に **接続コード**（リンクと同じ文字列）が出ます。
コピーして、この設定画面（トレイの丸いアイコンをダブルクリック）の **接続コード** 欄に貼り、**貼り付けて接続** を押してください。
欄が空のまま押すと、クリップボードから貼ります。

設定画面の **詳細** を開くと、従来の 3 欄（盤のアドレス・トークン・鍵）と OBS の接続先・打ち切り秒数があります。
手で設定する人は、盤の 設定 → PC → 詳細 でトークンだけを作り、鍵は 設定 → Claude からの Webhook から取ります。
**OBS のポートとパスワードは、この PC の OBS 自身から読みます**（下の「OBS」）。詳細の欄は、OBS が言うのとは別の値を使いたいときの上書きです。

インストーラ無しでも `DeckAgent.exe` 1 つで動きます（置き場所は自由。起動のたびに `multitasker://` の受け口を自分の場所で登録し直すので、
インストーラ無しでも③のリンクが届きます。「ログオン時に起動」は設定画面のチェックで入ります）。

**更新:** 起動時と 24 時間ごとに `<盤>/download/agent/version.json` を見に行き、動いている版より新しければ、
トレイのメニューに **更新あり（x.y.z）** が出ます。選ぶと `<盤>/download/DeckAgentSetup.exe` がブラウザで開きます。
勝手にダウンロードも入れ替えもしません。

アンインストールしても設定ファイルは残ります（つなぎ直さずに済むように）。消したければ下のフォルダごと。

## 設定ファイル

`%APPDATA%\Multitasker\agent.json`。設定画面が書きますが、手で書いても同じです:

```json
{
  "boardUrl": "https://board.example.com",
  "token": "（接続コードに入っているもの。手で作るなら 盤の 設定 → PC → 詳細）",
  "key": "（盤の鍵。base64url・32 バイト。notify.json の key と同じ）",
  "obsHost": "127.0.0.1",
  "obsPort": 4455,
  "obsPassword": "",
  "timeoutSeconds": 60
}
```

`obsPort` が 4455 のまま・`obsPassword` が空のままなら、**OBS 自身の設定から読んだ値**を使います。
別の値を書けば、そちらが OBS より優先されます（`obsHost` は OBS の設定に無いので、常にここの値です）。

同じフォルダの `agent.log` に、接続と各指示の成否だけが書かれます（コマンドの中身・出力は書きません）。
枠が赤くなる理由はここを見れば分かります（鍵が違う・盤に拒否された・打ち切り・OBS につながらない、など）。

## できること（`kind`）

| 種類 | やること | 失敗になるとき |
|---|---|---|
| アプリ／ファイルを開く | シェルで開く（関連付けどおり） | 開けない（パスが無い等） |
| URL を開く | 既定のブラウザで開く。`http://` と `https://`。始まりの無い `example.com` は `https://` を補う | `file:`・ドライブ文字・ほかのスキームは開かない |
| ホットキー | `ctrl+shift+f13` の書き方。修飾 `ctrl` `shift` `alt` `win`、キーは `a`〜`z` `0`〜`9` `f1`〜`f24` `enter` `esc` `tab` `space` `up/down/left/right` `home/end/pageup/pagedown` `insert/delete` `numpad0`〜`9`、メディア `play_pause` `next` `prev` `stop` `mute` `volume_up` `volume_down` など | 知らないキー名 |
| OBS | `scene`（シーン名）／`record`・`stream`（`start`・`stop`・`toggle`）／`mute`（音源名をトグル）／`visible`（シーン名＋ソース名を `show`・`hide`・`toggle`） | OBS につながらない・パスワード違い・そのシーン／音源／ソースが無い・**同じシーンに同じ名前のソースが2つある**（どちらか決められないので何もしない） |

**OBS** のポートとパスワードは、**このプログラムが OBS 自身の設定から読みます**。打ち込むものはありません。
読み先は `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json`（obs-websocket 5.x＝OBS 28 以降に同梱。
平文で置かれています）。設定画面には、**どこに繋ぐか**と**どちらから読んだ値か**（OBS／詳細の欄）が出ます。

OBS 側で **ツール → WebSocket サーバー設定**（Tools → WebSocket Server Settings）の
**WebSocketサーバーを有効にする**が外れていると、枠を押しても繋がりません。設定画面がそう言い、
**OBS の待ち受けを有効にする** のボタンを出します。押すとその設定ファイルの `server_enabled` だけを書き換えます
（押さない限り書きません）。**OBS を起動し直すまで効きません** — OBS を閉じてから押し、そのあと OBS を起動してください。

読み先を変えるには `--obs-config <パス>`、または環境変数 `MULTITASKER_OBS_CONFIG`（検査用）。

指示は盤で封じられ、この PC の鍵でしか開きません。開けないもの・番号が合わないもの・押してから 5 分以上たったものは
実行せず失敗として返します。結果として盤に送るのは成功／失敗だけで、出力は送りません。

## 作り方（開発者向け）

.NET 10 SDK が要ります。PowerShell で:

```powershell
.\agent\build.ps1                 # publish\DeckAgent.exe（自己完結・1 ファイル・約 100 MB）
                                   # Inno Setup 6.3+ があれば publish\DeckAgentSetup.exe も作り、public\download\ に置く
.\agent\build.ps1 -SkipInstaller
```

インストーラは `installer\DeckAgent.iss`（Inno Setup 6.3 以降。`ISCC.exe` が見つからなければ exe だけで止まります）。

検査（Git Bash・盤のディレクトリで）:

```bash
node test/deck-seal-agent.js     # 暗号の一致: 既知ベクトルと、ブラウザが封じたものを exe が開くこと
DATABASE_URL=... BASE=http://127.0.0.1:3040 node test/deck-agent.js
                                 # 本物の exe を起動して押す→ok／失敗／打ち切り／偽番号／古い／http(s) 以外／5 秒切れ、
                                 # さらに multitasker://pair#… 引数での起動→agent.json・接続、起動中の実例への受け渡し、
                                 # --check-pair（接続コードの解析）、--check-url（URL の規則）
```

`build.ps1` は publish → ISCC → `..\public\download\DeckAgentSetup.exe` と `..\public\download\agent\version.json` を置くところまで行います
（版は `DeckAgent.csproj` の `<Version>` が正本。`.iss` には `/DMyAppVersion=` で渡されます）。

コマンドライン:

| | |
|---|---|
| `DeckAgent.exe multitasker://pair#…` | 接続リンクを受け取る。既に起動中なら、その実例に名前付きパイプで渡して終了 |
| `--config <path>` | 設定ファイルの場所を変える（検査用。同じパスで 1 実例） |
| `--settings` | 起動直後に設定画面を開く |
| `--lang ja` / `--lang en` | 表示言語を Windows の設定と無関係に決める |
| `--no-register` | `HKCU\Software\Classes\multitasker` を書かない（検査用。普通の起動は毎回書き直す） |
| `--check-seal <vector.json> [sealed]` | 暗号の一致検査（`test/deck-seal-agent.js`） |
| `--check-pair <text>` | 接続コードを解析して 1 行出して終了（`ok …` / `error pair.xxx`） |
| `--check-url <text>` | URL の規則を当てて 1 行出して終了（`open …` / `refused`） |
| `--check-obs <args json> [--holds N] [--showing true\|false]` | その指示が OBS に投げる要求を、繋がずに組み立てて出す（`--holds 2` ＝同名のソースが2つある場合） |

設定ファイルが無い（未設定の）ときは、起動時に案内付きの設定画面が自動で開きます。
