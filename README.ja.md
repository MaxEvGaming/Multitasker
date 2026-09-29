# Multitasker

> **正本は英語版の [README.md](README.md) です。** この日本語版はその写しで、食い違ったときは英語版が正しいものとします。

並行して走っている Claude のセッションを、9つの正方形で一目で見るための小さなサイトです。
Claude からの知らせを Slack と同じ形のWebhookで受け取り、必要なときだけスマホに通知します。

設置手順は [deploy/PRODUCTION.md](deploy/PRODUCTION.md) にあります。

## 何をするもの

- **9つの枠**。1枠が1つの案件です
- 各枠に **タイトル・状態・（時間を計る状態なら）残り時間の輪**
- **ボタンの左半分と右半分で行き先が違います。** どちらが何になるかは枠の下に薄く出ます
- **状態も、状態から出る矢印も、利用者が作ります。** 「待機中・実行中・処理中・停止中」は最初に入っている例で、
  増やすことも、巡回の順を変えることもできます
- **Claude が「セッションが止まった」と知らせてきたら**、その名前を持つ枠が自分で動きます
- **Claude に指示を出したときも**、その名前を持つ枠が自分で動きます
- **予想所要時間を過ぎたときも**、自分で動きます
- **自分で動いたときだけスマホに通知します。** 自分で押したときは鳴りません（押した本人は知っているので）

## 状態が持つもの

| | 意味 |
|---|---|
| ◀ 左タップの行き先 | ボタンの左半分を押したときに移る先。空にすると左半分は無反応になります |
| 右タップの行き先 ▶ | 同じく右半分 |
| 止まったら移る先 | Claude が止まったという知らせと、時間切れの両方で使われる先 |
| 指示を受けたら移る先 | Claude に指示を出したという知らせで使われる先 |
| タイマーを回す | この状態にいる間、輪が減っていきます |

## PC に指示を出す

枠に**コマンド**を入れると、その枠は PC を動かすボタンになります。
押すと（左右どちらでも）矢印に沿って動く代わりに、指示を PC に送ります。

- **できること**: アプリ・ファイルを開く／URL を開く／
  ホットキー（`ctrl+shift+f13` の書き方）／文字を打ち込む（チャットを開くキーを押す → 文字列を打つ → Enter。ゲームのコマンド用）／
  OBS（シーン切替・録画・配信・音源のミュート切替・ソースの表示と非表示）。
  コマンド実行（`cmd /c` に 1 行渡す）は **2026-09-14 に止めた。理由: 任意の1行を歯止め無しで実行するため**
- **枠の動き**: 押す → **PC が実行している間**の状態（既定: 処理中）→ 成功なら**成功したら**の状態（既定: 待機中）、
  失敗なら**失敗したら**の状態（既定: 停止中）。3つの移り先は枠ごとに、自分の状態から選べます
- **5 秒ルール**: 押してから **5 秒以内に PC が取りに来なければ、その指示は捨てられ、枠は失敗の状態**に移ります。
  変えられません。PC が「受け取った」と言ってから **60 秒以内に結果が来なければ失敗**扱いです
- **見えるのは色だけ**: 成功か失敗か。コマンドの出力は届きません
- **鳴るのは、PC から返事が来た時（成功・失敗・誰も取りに来なかった）だけ**。押した時は鳴りません。
  ほかの枠と同じ「自分で動いた時だけ通知」のルールです
- **暗号化が必須**: コマンドは枠の名前と同じ鍵でブラウザが封じ、サーバーは読めません。
  サーバーが読める指示は、サーバーを乗っ取った人が書ける指示でもあるからです。
  暗号化されていないボードでは、設定画面に「先に暗号化を有効にしてください」と出て、コマンドは入れられません

**PC をつなぐ:** 設定 → **PC** の 3 手（下の「PC 側（インストール）」）。アカウント1つに PC は何台でも登録でき、
設定画面の一覧で**1台ずつ ON / OFF**（OFF は接続を切らず、盤が指示を送らないだけ）と登録解除ができます。
枠は**どの PC で走らせるか**を選べ、既定は「ON になっている全台」です。
PC 側が実装する約束事は [docs/DECK_AGENT_PROTOCOL.md](docs/DECK_AGENT_PROTOCOL.md) にあります。

## PC 側（インストール）

指示を受けて実行するのは、PC に常駐する小さなトレイアプリ **Multitasker PC Agent**（`agent/`・Windows のみ）です。
詳しくは [agent/README.md](agent/README.md)。**設定は盤の案内に従って押すだけで済みます。**

1. 盤の **設定 → PC** の **① ダウンロード** で `DeckAgentSetup.exe` を落とす
2. 実行して「次へ」で最後まで（管理者権限は不要。ログオン時に起動する登録と、`multitasker://` リンクの受け口の登録も一緒に入ります）。
   終わるとプログラムが起動し、時計の横に丸いアイコンが出ます
3. **同じ PC のブラウザ**で盤の **設定 → PC → ③ この PC をつなぐ** を押す。ブラウザが `multitasker://pair#…` のリンクを開き、
   アプリが盤のアドレス・トークン・鍵を受け取って接続します。盤の PC 欄が **接続済み ✓** になれば、枠を押すとその PC で動きます

**スマホから設定している／アプリがリンクを受け取れなかった場合**は、盤に**接続コード**（同じ文字列）が出ます。
コピーして、PC のアプリの設定画面（トレイのアイコンをダブルクリック）の **接続コード** 欄に貼り、**貼り付けて接続** を押してください。
従来の 3 欄（盤のアドレス・トークン・鍵）は設定画面の **詳細** の中にあり、手で入れることもできます。

OBS を使うなら、OBS 側で **ツール → WebSocket サーバー設定** を開いて WebSocket サーバーを有効にします。
ポートとパスワードは、アプリがその PC の OBS の設定から自分で読みます。打ち込むものはありません
（別の値を使いたいときだけ、アプリの設定 → 詳細 の OBS 欄に入れます）。

**更新:** アプリは起動時と 24 時間ごとに `<盤>/download/agent/version.json` を見て、新しい版があればトレイのメニューに
**更新あり（x.y.z）** を出します。選ぶとダウンロード先が開きます。勝手に落として入れ替えることはしません。

設定は `%APPDATA%\Multitasker\agent.json`、記録は同じ場所の `agent.log`（成否だけ。コマンドの出力は書きません）。
アンインストールしても `agent.json` は残ります。

**盤側に置くもの:** `public/download/DeckAgentSetup.exe`（`.gitignore` 済み・33 MB）と `public/download/agent/version.json`。
どちらも `agent/build.ps1` が置きます（.NET 10 SDK と Inno Setup 6.3+ が要る）。本番へ出す手順は
[deploy/PRODUCTION.md](deploy/PRODUCTION.md) の「7.6」。

検査: `node test/deck-seal-agent.js`（暗号の一致・exe が要る）と
`DATABASE_URL=... node test/deck-agent.js`（本物の exe を起動して押す→成功／失敗／5 秒切れ、`multitasker://pair#…` 引数での起動→
`agent.json` が書かれ接続すること、起動中の実例への受け渡し、接続コードの解析、URL の規則）。

## 動かし方（手元で）

```bash
docker run -d --name tb-dev -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=taskboard -p 55432:5432 postgres:17-alpine
npm install
npm run vapid            # 出た2行を下の環境変数に入れる
DATABASE_URL=postgres://postgres:dev@127.0.0.1:55432/taskboard \
VAPID_SUBJECT=mailto:you@example.com \
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
npm start
```

`http://127.0.0.1:3040` を開き、**「登録する」**でアカウントを作ります。
`REGISTRATION_OPEN=true` なら誰でも登録できます。書かなければ、利用者がいない間だけ登録が開いていて、1人目ができた時点で閉じます。

## 試験

サーバーを起動したまま、別の窓で:

```bash
DATABASE_URL=... node test/e2e.js        # ボードの一通り
DATABASE_URL=... node test/security.js   # 試行制限・パスワード変更/再設定・削除・Webhookの上限
DATABASE_URL=... node test/push-rule.js  # 通知が鳴る条件
DATABASE_URL=... node test/password-never-sent.js  # パスワードが外に出ていないこと
DATABASE_URL=... node test/deck.js       # PC への指示（押す→取りに来る→返事→枠が動く、5 秒で捨てる、上限）＋接続コードの組み立て・URL の補完
node test/deck-seal.js                   # 指示の暗号文の既知ベクトル（C# 側と突き合わせる）
```

`deck.js` は PC 側の役を自分で演じます（本物と同じ SSE の流れと3つの URL）。
**5 秒待つ検査が2つと 620 回叩く検査が1つ**あるので、30 秒ほどかかります。
`push-rule.js` にも「押した時は鳴らず、返事が来た時だけ鳴る」の検査が入っています。

`push-rule.js` は偽の通知先に自己署名の証明書を使うので、
**サーバー側を `NODE_TLS_REJECT_UNAUTHORIZED=0` で起動**し、
`test/` で証明書を作っておく必要があります（試験専用。本番の通知の受け口は本物の証明書です）:

```bash
cd test && openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem   -days 2 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
```

`e2e.js` は本物の Postgres を相手に、登録から巡回・Webhook・時間切れまでを歩きます。
`security.js` は、間違ったパスワードを繰り返して締め出されること、消したアカウントの行が
本当に消えること、Webhookが撃たれ続けたら断ることを、実際に叩いて確かめます。
`push-rule.js` は**偽の通知先を立てて実際に届いた数を数え**、
「自分で押したときは鳴らない・自動で動いたときだけ鳴る」を確かめます
（`test/*.pem` の自己署名証明書が要ります。作り方は同ファイルの先頭に）。

## 環境変数

| | |
|---|---|
| `DATABASE_URL` | Postgres への接続先。**専用のデータベースを使ってください** |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 通知の鍵。`npm run vapid` で作ります |
| `VAPID_SUBJECT` | `mailto:` か `https://` で始まる連絡先。Apple はこの形式でないと受け取りません |
| `PORT` | 既定 3040 |
| `REGISTRATION_OPEN` | `true` にすると誰でも登録できます。書かなければ「1人目だけ」 |
| `SITE_URL` | 招待リンク・再設定リンクを組み立てるときの宛先 |
| `BACKUP_TOKEN` | バックアップ取得用の秘密の文字列。24文字以上。**設定しなければその URL は存在しません** |
| `BACKUP_DIR` | バックアップの置き場（コンテナ内）。既定 `/backups` |
| `NODE_ENV` | `production` のとき、ログインの記録を HTTPS 限定にします |

## 作りの理由

- **ビルド工程がありません。** 素の Node と素のブラウザで動きます。壊れる箇所を減らすためです
- **パスワードはブラウザから出ません。** ログインに送るのは、パスワードと
  そのアカウントのソルト（アカウントごとの乱数）から導いた**トークン**
  （パスワードそのものではない、送信専用の値）です。サーバーはそれを scrypt で保管しますが、
  トークンでは暗号化された鍵は開きません（導出を二手に分け、鍵を開ける側は
  ブラウザに残しています）。＝**保管されているものを読まれても、
  通信を覗かれても、中身は開きません。**
  守れないのは「このサイト自身が別のコードを配ること」で、
  ブラウザで暗号化する仕組みは全部そうです
- **scrypt は Node に同梱**なので、ネイティブの拡張を持ち込まずに済みます。
  Node を上げても壊れません
- **通知は、スマホのブラウザの通知の受け口（iPhone なら Apple）へ直接送ります。** 他社の中継を通しません
- **Webhookは Slack と同じ形**（`{"text": "*名前* — 本文"}`）。
  PC 側の通知フックは送り先を変えるだけで、書き換えは要りません

## パスワードを忘れた人が出たら

メールは送っていないので、**管理者が再設定リンクを作って渡します**:

```bash
docker exec taskboard node src/reset.js someone@example.com
```

24時間有効・1回だけ使えるリンクが出ます。使われた時点で、その人の開いているセッションは
すべて閉じます（乗っ取られていた場合に備えて）。

## テストの走らせ方（ローカル）

27 本あります。**19 本はサーバーと DB を要求し、そのうち 3 本（`push-rule` `start-signal` `tenancy`）はさらに自己署名証明書と通知鍵を要求します。**
`deck-seal-agent` と `deck-agent` は PC Agent の exe も要ります。
足りないと「異常終了」や「通知が 0 件」に見えますが、それは環境の不足であって不具合ではありません。

```bash
# 1. 使い捨ての DB
docker exec postgres psql -U postgres -c "create database taskboard_test;"

# 2. 偽の通知先が使う証明書（test/*.pem は .gitignore 済み）
cd test && MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

# 3. 通知鍵
npm run vapid

# 4. サーバー（NODE_TLS_REJECT_UNAUTHORIZED=0 は"サーバー側にも"要る。
#    偽の通知先が自己署名なので、送る側が拒否する）
DATABASE_URL=postgres://<ユーザー>:<パスワード>@127.0.0.1:5432/taskboard_test \
PORT=3040 REGISTRATION_OPEN=true NODE_TLS_REJECT_UNAUTHORIZED=0 \
VAPID_SUBJECT=mailto:test@example.com VAPID_PUBLIC_KEY=<公開鍵> VAPID_PRIVATE_KEY=<秘密鍵> \
node src/server.js &

# 5. テスト（REGISTRATION_OPEN はテスト側にも要る＝e2e が「扉」の期待を切り替える）
DATABASE_URL=... BASE=http://127.0.0.1:3040 REGISTRATION_OPEN=true NODE_TLS_REJECT_UNAUTHORIZED=0 \
  node test/e2e.js
```

**DB 不要なのは 7 本**（`crypto` `crypto-agreement` `deck-seal` `download` `editors` `i18n` `settings-order`）。
このうち `i18n` は、画面の文言が両言語で揃っているか・地の文に日本語が残っていないかを見ます。

## ライセンス

ソースコードは **MIT License** で公開しています。全文は [LICENSE](LICENSE) にあります。

- **してよいこと**: 使う・中身を読む・改造する・配り直す・商用で使う。自分のサーバーに設置して運用してかまいません
- **条件は 1 つ**: コピーや改造版を配るときは、`LICENSE` の著作権表示と許諾文をそのまま付けてください
- **無保証**: このソフトウェアを使って起きた損害について、作者は責任を負いません

### 利用している他者のソフトウェア

| もの | どこで使うか | ライセンス |
|---|---|---|
| [pg](https://github.com/brianc/node-postgres) | サーバー（DB 接続） | MIT |
| [web-push](https://github.com/web-push-libs/web-push) | サーバー（通知の送信） | MPL-2.0 |
| [.NET ランタイム](https://github.com/dotnet/runtime) | PC Agent の exe に同梱 | MIT |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | PC Agent のインストーラを作る道具 | Inno Setup License |

どれもこのリポジトリには入っていません（`npm install` と `agent/build.ps1` が取得します）。
画面側（`public/`）は外部のライブラリを使っていません。
