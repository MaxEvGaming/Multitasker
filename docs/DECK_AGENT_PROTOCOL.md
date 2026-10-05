# PC 側（agent）が実装する約束事

盤（`src/server.js`・`src/deck.js`）が実装済みの受け口と、その振る舞い。C# トレイアプリはこれに合わせる。
盤側の検査 `test/deck.js` が、この文書どおりの手順で PC の役を演じている＝**ここに書いてあることは実行して確かめてある**。

## 0. 前提

- PC は**盤の設定画面「PC」で登録**し、**トークン**（base64url・32 文字）を受け取る。
  **アカウント1つに PC は何台でも**登録できる（2026-09-14）。登録は**足す**だけで、既にある PC のトークンは生き続ける。
  **登録を解除**した PC のトークンだけが**その場で 404** になり、開いている SSE もその場で閉じられる。
- 盤側で PC を**1台ずつ ON / OFF** できる。**OFF は登録解除ではない**＝接続は切れず、盤が指示を送らないだけ。
  OFF の間は `events` につないでも `pending` の指示は流れてこない。ON に戻せば、**つなぎ直さなくても**その場から届く。
- 枠（square）は**どの PC で走らせるか**を選べる。既定は「**ON になっている全台**」＝1つの指示が複数の PC に届く
  （下の 3. と 5. のとおり、`ack` は2台目に 409、`result` は先に答えた方で決まる）。
  指名した PC が **OFF・登録解除済み・つながっていない**ときは、ほかの PC に回されることはなく、
  **5 秒で `expired`**＝枠は失敗の状態へ（「誰も取りに来なかった」と同じ扱い）。
- **枠の送り先だけは封じられていない。** 盤が宛先を決められないと配れないため、`tasks.agent_id` は平文で持つ。
  盤に見えるのは「どの PC に配るか」だけで、**命令の中身は読めない**（この性質は変わらない）。
- PC は**盤の鍵**（設定画面「Claude からの Webhook」の鍵。base64url・32 バイトの master）も持つ。
  指示はこの鍵でしか開かない。鍵の導出と暗号文の形は下の「2.5 暗号文の形」、
  既知ベクトルは `test/vectors/deck-seal.json`。
- Cookie は使わない。**トークンが URL に載る**（webhook と同じ作法）。TLS 越しで送ること。
- 盤は指示の中身を読めない。**開けないもの・形が違うもの・`id` が合わないもの・古いものは PC が捨てる**（盤は止められない）。

## 0.5 接続コード / pair link（かんたん接続・第2段）

PC に**盤のアドレス・トークン・鍵**を一度に渡す文字列。盤の設定「PC」の **③ この PC をつなぐ** がブラウザで組み立てて
`multitasker://` として開く（＝インストーラが登録した受け口で PC のアプリが受け取る）。同じ文字列が、スマホのときや
アプリが受け取れなかったときに **接続コード** として画面に出て、アプリの設定画面の 1 欄に貼る。

```
multitasker://pair#v1|<origin>|<token>|<key>
```

| 部分 | 中身 | 例 |
|---|---|---|
| scheme | `multitasker://pair#` 固定（大文字小文字は問わない）。**OS が `multitasker://pair/#` に書き換えて渡すので、受け側は両方受ける**（下記） | |
| 1 | 版。`v1` 固定。違えば断る | `v1` |
| 2 | 盤の origin。`http(s)://host[:port]`。パスは付けない | `https://board.example.com`、`http://127.0.0.1:3040` |
| 3 | agent のトークン（`/api/agent/register` が返すもの。base64url・16 文字以上） | `abcdefghijklmnopqrstuvwxyz012345` |
| 4 | 盤の鍵（master・base64url・32 バイト＝43 文字） | `CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY` |

- 区切りは `|`。3 つの部分のどれにも `|` は入らない（origin は scheme://host:port、トークンと鍵は base64url）。
- **`#` の後ろ（fragment）に置く**のは、fragment は HTTP の要求に載らないから。この文字列はブラウザから OS を通って
  アプリに渡るだけで、**盤のサーバーには鍵が届かない**（サーバーが持つのはトークンだけ）。
- ブラウザが fragment をパーセント符号化することがある（`|`→`%7C`）。3 つの部分に `%` は無いので、PC 側は**先に unescape**してから割る。
- **Windows はカスタムスキームのリンクを handler に渡すとき `multitasker://pair#v1|…` を `multitasker://pair/#v1|…` に書き換える**
  （`#` の前に `/` を挿す。2026-09-09 に一時 echo スキームで実測。`|` はそのまま＝`%7C` にならなかった）。
  盤が組み立てるのは `pair#` のまま。**受け側（`agent/src/PairLink.cs` と `public/pair.js` の `parsePairLink`）は `pair#` と `pair/#` の両方を受ける**
  （`/` は 1 つまで。`pair//#` や `pair/v1|…` は断る）。`test/deck-agent.js` は exe を `pair/#` 形の引数で起動して接続まで確かめる。
- 既知の例（`test/deck.js` が固定している）:
  origin `https://board.example.com`、token `abcdefghijklmnopqrstuvwxyz012345`、鍵 `CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY` →
  `multitasker://pair#v1|https://board.example.com|abcdefghijklmnopqrstuvwxyz012345|CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY`
- **PC がやること**: 解析（版・4 部分・origin の形・鍵 32 バイト）→ `agent.json` の `boardUrl`/`token`/`key` を書き換える（OBS・打ち切りは残す）→
  つなぎ直す → バルーン「接続しました」。既に起動中の実例があれば、新しい起動はリンクをそれに渡して終了する（名前付きパイプ）。
  形が違えば**理由付きで断る**（落ちない）。
- 盤側の実装は `public/pair.js`（`pairLink` / `parsePairLink`）、PC 側は `agent/src/PairLink.cs`。両方が同じ形を断る。
- 「つないだか」は盤が `agents.last_seen` で見る。登録直後の行は `last_seen` が空で、アプリが新しいトークンで一度でもつなげば埋まる。
  盤は `seen_ago`（秒）も返し、45 秒以内なら「接続済み ✓」。

## 1. 受け口

すべて `https://<盤>/agent/<token>/...`。

| | | |
|---|---|---|
| `GET /agent/<token>/events?name=<コンピュータ名>` | SSE | 指示を受け取る。つなぎっぱなし。先頭に `event: guard` が1回来る（下記） |
| `POST /agent/<token>/jobs/<id>/ack` | 本文なし | 「受け取った」（`pending`→`taken`） |
| `POST /agent/<token>/jobs/<id>/result` | `{"ok": true}` か `{"ok": false}` | 結果。出力は送らない |
| `POST /agent/<token>/guard` | `{"on": true}` か `{"on": false}` | 「新しい場所からログインがあったら、このアカウントの PC を全部切る」のスイッチ（2026-09-14 追加。下記） |
| `POST /agent/<token>/resume` | 本文なし | 切られた後に戻る（2026-09-14 追加。下記） |

### `guard` / `resume`（新しい場所からのログインで切る・2026-09-14 追加）

Owner 2026-09-14『サイト側で、新しい場所からログインがあった場合、自動的に全アプリの接続を切ります。これは Windows アプリ側からしか ON できないようにします』（T-073。T-074＝A: 「新しい場所」は**新しい端末**、T-075＝A: **ON も OFF も PC のプログラムからだけ**）。

- **スイッチは PC の道からだけ**変わる（`POST …/guard`）。盤のセッション（`/api/…`）に同じものは無い＝盤からは 404。
  `agents.guard` に入り、盤の設定画面「PC」の一覧には**読むだけ**で出る。PC 側は `agent.json` の `guard` に写しを持ち、設定画面のチェックを変えて保存すると送る。
  **既定は ON**（T-082・Owner 2026-09-14『デフォルトで ON にして』。`sql/014_guard_default_on.sql` が列の既定を `true` にし、登録済みの PC も `true` に更新。PC 側 `agent.json` に `guard` が無ければ `true`＝agent 0.3.1）。
- **読むのは `events` の先頭**（T-085・2026-09-14）: 盤は `events` を開いた直後、`: connected` の次に `event: guard` / `data: {"on": true|false}` を**1回**流す（`src/deck.js` の `guardFrame`）。
  PC は受けた値が `agent.json` の `guard` と違えば書き換える（`TrayApp.TakeGuard`）＝**盤が正、PC の写しは盤に合わせる**。書けるのは今までどおり PC の `POST …/guard` だけ（T-075 は不変）。
  これで、0.3.0 が `"guard": false` を書いた `agent.json` の PC も、014 を当てた盤につなぎ直した時点で画面が ON になる。0.3.0 以前の PC は知らない event を読み飛ばす（`Worker.cs` は `event: job` だけを扱う）。
- **切られる条件**: そのアカウントで `guard` が ON の PC が**1台でも**あるとき、**印の無いブラウザ**からログイン（`/api/login`・`/api/account/recover`）が成功した。
  印＝ログイン成功時に盤が置く長期 cookie `known_device`（アカウントごとの乱数・1 年・HttpOnly・サインアウトしても消えない）。
- **切られると**: そのアカウントの**全 PC**（ON の1台だけではない）に `agents.suspended_at = now()`、開いている `events` は盤がその場で閉じ、スマホに通知が1回。
  以後その PC には **`events`・`ack`・`result` とも `403` 本文 `suspended`**。指示の配り先からも外れる（OFF の台と同じ扱い）。
- **戻るのは PC の道からだけ**（`POST …/resume` → `suspended_at` を空に）。盤からは戻せない。PC 側は 403 `suspended` を受けたら**再接続を止め**（`AgentState.Suspended`）、設定画面の「再接続」（またはトレイの「再接続」）が `resume` を送ってからつなぎ直す。
- **盤のキルスイッチ**（T-077。Owner『ウェブサイト側からのキルスイッチもつけてください』）: `POST /api/agents/kill`（盤のセッション）が**同じ関数**（`suspendAll`）を呼ぶ＝guard が OFF でも全 PC が止まる。戻し方は同じ（PC の `resume` だけ）。
- 盤側の実装は `src/deck.js`（`setGuard`／`guardArmed`／`suspendAll`／`resumeAgent`）と `src/server.js`（`afterSignIn`）。検査は `test/guard.js`、実 exe は `test/deck-agent.js`。

### `name`（コンピュータ名・2026-09-14 追加）

**PC が自分のコンピュータ名を名乗る**（`Environment.MachineName`。`agent/src/Worker.cs` の `EventsUrl()`）。
盤は受け取った名前を `agents.name` に上書きし、設定画面「PC」の一覧に出す＝**何台も登録したときに見分けるためだけのもの**。
**指示の宛先ではない**（宛先は token）。

- **URL のクエリに載せる**（見出しではない）。日本語のコンピュータ名も通るよう **UTF-8 でパーセント符号化**する。
- **つなぐたびに送る**（PC の名前は変わる）。80 字で切られる。
- 付けずにつないでも断られない。その場合は**登録したときにブラウザが付けた名前**（`pc` / `phone`）がそのまま残る
  ＝「まだ一度もつながっていない台」の表示はこれ。

### 応答コード（共通）

| コード | 意味 | PC の対応 |
|---|---|---|
| `404 unknown agent` | トークンが無い（登録を解除された） | 再接続しない。利用者にトークンの入れ直しを求める |
| `403 suspended` | 切られている（新しい場所からのログイン、または盤のキルスイッチ。上記） | 再接続しない。利用者が PC で「再接続」を押したら `POST …/resume` を送ってからつなぐ |
| `429 too many` | 上限（1 時間に 600 回。接続・ack・result を全部数える） | 1 分ほど待って再接続 |
| `404 unknown job` | その `id` の指示が無い、または**他人の指示** | 捨てる |
| `409 job is <status>` | もう開いていない（`expired`・`done`・`failed`、ack の二重送り） | 捨てる。expired なら「5 秒に間に合わなかった」 |
| `400` | `result` の本文が `{"ok": true|false}` でない | 直す |
| `200 ok: taken` / `ok: done` / `ok: failed` | 受理 | — |

セキュリティヘッダ（CSP 等）は全応答に付く。無視してよい。

## 2. SSE の形

`Content-Type: text/event-stream; charset=utf-8`。標準の SSE（`\n\n` 区切り）。

```
: connected

event: job
data: {"id":"42","createdAt":"2026-09-09 10:25:33.123456+00","sealed":"v1.<iv>.<ct||tag>"}

: ping

```

- 接続直後、**この PC 宛の `pending` の指示を全部**（古い順）流す＝「送り先を選んでいない枠」の分と
  「この PC を指名した枠」の分。ほかの PC を指名した分は流れてこない。**OFF の PC には1件も流れない。**
  その後、新しい指示が出るたびに即時。
- **15 秒ごとに `: ping`**（コメント行）。これが 30 秒以上来なければ切れている＝再接続。
- `data` は 1 行の JSON。`id` は**文字列**、`createdAt` は Postgres の timestamptz の文字列そのまま
  （実測 `2026-09-09 10:26:37.009793+00`。区切りは `T` でなく空白、オフセットは `+00`。.NET は
  `DateTimeOffset.Parse` で読める）。時刻の判定には `createdAt` でなく**平文の `at`**（epoch ms）を使う。`sealed` は暗号文。
- `event: job` 以外のイベント名は今は無い。知らないイベントは無視する（将来足せるように）。
- 接続時に `agents.last_seen` が更新される（設定画面に「最後の接続」として出る）。ping と ack/result でも更新。

## 2.5 暗号文の形

`jobs.sealed` と `tasks.command_sealed` の正確な形。PC 側はこれに合わせる。既知ベクトルは **`test/vectors/deck-seal.json`**（`node test/deck-seal.js` が
盤の `crypto.js` で開けることを毎回確かめている）。

- **鍵**: 盤の設定画面「Claude からの Webhook」に出る鍵（base64url・32 バイト）が master。
  `dataKey = HKDF-SHA256(ikm = master, salt = 空（0 バイト。32 個の 0 ではない）, info = "taskboard/data" の UTF-8, L = 32)`。
  .NET なら `HKDF.DeriveKey(HashAlgorithmName.SHA256, master, 32, salt: Array.Empty<byte>(), info: Encoding.UTF8.GetBytes("taskboard/data"))`。
- **暗号**: AES-256-GCM。IV 12 バイト（ブラウザは乱数）、タグ 16 バイト、additional data なし。
  平文は JSON 文字列の UTF-8。
- **文字列の形**: `v1.<iv>.<ciphertext||tag>` — 3 つの部分を `.` で結ぶ。各部分は **base64url・パディングなし**
  （`+`→`-`、`/`→`_`、末尾の `=` を落とす）。第 3 部分は **暗号文の直後にタグを連結**したもの（先頭ではない）。
  .NET の `AesGcm.Decrypt` はタグを別引数で取るので、末尾 16 バイトを切り分けて渡す。
- **`jobs.sealed` の平文**（ブラウザが `JSON.stringify` で作る。空白なし）:
  `{"id":"<jobs.id を文字列で>","at":<押した時刻・epoch ms>,"kind":"…","args":{…}}`
  `kind` と `args` は 3. の表のとおり。`id` は **文字列**（`"42"`）で、SSE の `data` の `id` と一致していなければ捨てる。
- **`tasks.command_sealed` の平文**（枠に保存される雛形。agent には渡らない）: `{"kind":"…","args":{…}}`。
  押した時にブラウザがこれを開き、`id` と `at` を足して封じ直したものが `jobs.sealed`。
- **ベクトル**（`test/vectors/deck-seal.json` より）: master `CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY`、
  IV `AAECAwQFBgcICQoL`（= 00 01 … 0b）、平文 `{"id":"42","at":1757400000000,"kind":"exec","args":{"command":"echo hi"}}`
  （暗号の一致を確かめるための固定の例。`exec` は 2026-09-14 に止めたので、PC はこの指示を実行しない）
  → `v1.AAECAwQFBgcICQoL.hFlKbLv-Q-FXpFs45idgiPxaVksrJAjEa__6Eu_H3y2N22JjyO4ZbdZjmJ1dp2dXxhCAP4m-b6Us7WVotC46RQoA0vao9_ycttT9BoLoahIXzKazcAPYu0Q`。
  導出した dataKey（hex）は `9e7b49899be7263879ec60cd7d48a3b9e6c5f50f1b90724e4204f497db73b71c`。
  PC 側の検査は **この 3 つを開いて平文が一致すること**と、**盤の `encryptText` が封じたもの（IV は乱数）を開けること**の両方を置く。

## 3. 1 件の指示の流れ（PC がやること）

1. `event: job` を受ける。
2. **`sealed` を開く**（HKDF → AES-GCM。「2.5 暗号文の形」参照）。開けなければ **ack 済みのまま `{"ok":false}` を返す**（枠は失敗の状態になる。黙って捨てると盤は 5 秒後に `expired` にするが、「開けなかった」と「取りに来なかった」を盤で区別できる方がよい＝2026-09-09 実装で確定）。
3. 平文 `{"id","at","kind","args"}` を読む。**次のどれかなら実行せず `{"ok":false}` を返す**（**既知の `id` の再配達だけは黙って捨てる**＝実行中の 1 回目の答えを上書きしないため）:
   - `id` が `data.id` と違う
   - `id` を既に処理した（**既知の番号を覚えておく**。少なくとも直近 1 時間ぶん）
   - `at` が今より **5 分以上古い**（時計ずれの余裕。盤は 5 秒で捨てるので普通は来ない）
   - `kind` が `open|url|hotkey|text|obs|marker` のどれでもない（**`exec` もここに入る**＝2026-09-14 に止めた。下の表の注）
4. **すぐ `ack`** を送る（作成から **5 秒**以内に届かなければ盤が `expired` にして枠を失敗の状態に動かす。PC が実行を始めてから ack するのでは遅い）。
5. 実行する。**60 秒**で打ち切り＝失敗（agent 設定で変更可、ただし盤は ack から 60 秒で `failed` にするので、それより長くしても盤は待たない）。
6. `result` に `{"ok": true|false}` を送る。**出力・エラー文は送らない**。
7. `result` が `409` で返ったら、盤は既に見切りをつけている。ログに残して終わり。

`ack` を送り損ねても `result` は受理される（答えは受領証より強い）。ただし 5 秒を過ぎていれば `409`。

### `kind` と `args`

| kind | args | やること |
|---|---|---|
| `open` | `{"target": "<パス>"}` | シェルで開く（`ShellExecute` 相当）。開けたら ok |
| `url` | `{"url": "https://…"}` | 既定ブラウザで開く。`http://` と `https://`。始まりの無い `example.com` は `https://` を補う（盤も保存時に補う）。それ以外（`file:` 等）は失敗 |
| `hotkey` | `{"keys": "ctrl+shift+f13"}` | `+` 区切り。修飾は `ctrl` `shift` `alt` `win`、キーは英数・`f1`〜`f24` など |
| `text` | `{"key": "t", "text": "<打つ文字列>", "mode": "paced"}` | チャットを開くキーを押す → 文字列を打つ → Enter（2026-09-13 追加）。`mode` は `paced`（1文字ずつ）か `burst`（一気に）。**無ければ `paced`**（T-087・2026-09-14 追加）|
| `obs` | `{"op": "scene", "arg": "<シーン名>"}` | シーン切替 |
| `obs` | `{"op": "record", "arg": "start|stop|toggle"}` | 録画 |
| `obs` | `{"op": "stream", "arg": "start|stop|toggle"}` | 配信 |
| `obs` | `{"op": "mute", "arg": "<音源名>"}` | その音源のミュートを切り替える |
| `obs` | `{"op": "visible", "scene": "<シーン名>", "source": "<ソース名>", "arg": "show|hide|toggle"}` | そのソースの表示／非表示（2026-09-13 追加） |
| `marker` | `{"label": "<ラベル>", "lang": "ja|en"}`（`label` は無ければ `""`。盤で 40 文字まで。`lang` は押した時の盤の言語） | 配信マーカー（2026-10-05 追加）。OBS に配信と録画の経過時間を訊き、押した瞬間の値を PC のファイルに 1 行足す。下の `marker` |

OBS の接続先（host/port/password）は **PC 側の設定**。指示には入らない。

**`exec`（`{"command": "<1 行>"}` を `cmd /c` で走らせる）は 2026-09-14 に止めた。理由: 任意の1行を歯止め無しで実行するため。** PC は知らない kind と同じく `{"ok":false}` を返し、盤は種類の選択肢から外した（既に `exec` で封じてある枠はふつうの枠として読む）。本体 `Executor.ExecAsync` は消した＝戻すなら `git show 7e43698:agent/src/Executor.cs`。

#### `text`（文字を打ち込む・2026-09-13 追加）

`SendInput` の **`KEYEVENTF_UNICODE`**（`wVk=0`・`wScan` に UTF-16 の1単位）で1文字ずつ押して離す。
キー配列に依存せず、**日本語もそのまま打てる**（サロゲートペアは2単位＝2回押す）。

- 順序は **`key` を押す → `text` を打つ → `enter` を押す**。`key` の書き方は `hotkey` と同じ（`t`・`ctrl+shift+m` など）。
- **`key` が空なら何も押さず、すぐ打ち始める**（ゲーム以外に使うときの形）。
- **`text` が空なら実行せず失敗**。`key` が読めない名前なら失敗。
- **打ち込む先は、そのとき最前面にある窓**。窓の指定はしない（T-047＝C。Owner 決定）。
  同じ PC のブラウザから押せばブラウザに入る＝スマホや別の PC から押す前提。
- **`key` を押した直後に 200ms 待ってから打ち始める**（T-084＝A。Owner 2026-09-14『T84：A』）。ゲームはチャット欄を
  次の描画で開くので、待ち無しでは先頭の1文字が欄の開く前に届いて捨てられる＝2026-09-14 に Minecraft で
  コマンドの先頭の `/` が消えた。値は固定（`Executor.cs` の `ChatKeySettle`）。**`key` が空なら待たない。Enter の前には待たない。**
  窓の指定はしない（T-047＝C）のは変わらない。
- **打ち方は枠ごとに `mode` で選ぶ**（T-087。Owner 2026-09-14『切り替えできるようにしてください』）。
  盤の枠の設定（種類「文字を打ち込む」）の「打ち方」＝「1文字ずつ」(`paced`)／「一気に」(`burst`)。封じた指示の `args.mode` に載る。
  **`mode` が無い枠・知らない値は `paced`**（`public/pair.js` の `textMode`、PC 側は `Executor.cs`）。
  - `paced`: **1文字ごとに 25ms の間合いを空ける**（T-049＝A。Owner 2026-09-14『T49：A』）。下の表のとおり、
    待ち無しでは受け側が追いつかず長い行が崩れるため。**サロゲートペアは1文字なので2単位を続けて送り、
    間合いはその外側に入る。** 実測 1.2 秒／40字（`Thread.Sleep` は OS のタイマ刻みに切り上がるので実際は
    1文字あたり約 31ms）。盤が返事を待つのは 60 秒なので、それに収まるのは約 1,900 字まで。
  - `burst`: **全文字ぶんの `INPUT` を 1 回の `SendInput` で送る**（T-049 の前の形。`Hotkeys.Burst`）。待ちは無い。
    受け側が追いつくかは受け側次第（下の表＝メモ帳では崩れる）。チャットキー後の 200ms（T-084）はどちらにも入る。
- **盤は `text` を 500 字までしか保存させない**（T-051＝A。Owner 2026-09-14『T51：A』）。60 秒 ÷ 約 31ms/字＝
  約 1,900 字を超える行は必ず失敗するため、そうなる枠を作れないようにしてある。数えるのは**文字**（サロゲート
  ペアは 1 字＝PC の間合いの入り方と同じ）。盤側の実装は `public/pair.js` の `TEXT_MAX`／`textTooLong`。

**受け側が追いつかない場合がある（2026-09-13 実測）。** 同じ経路・同じ1回の `SendInput` で:

| 打ち込み先 | 文字列 | 結果 |
|---|---|---|
| Win32 の素のテキスト欄（WinForms `TextBox`） | `hello 123 abcdefghij こんにちは、世界 test line`（46字） | **完全一致** |
| Windows 11 のメモ帳（WinUI・書式モード） | `こんにちは、世界`（8字） | **完全一致** |
| Windows 11 のメモ帳 | `/gamemode creative`（18字） | 崩れる（`/cccccccccreative`） |
| Windows 11 のメモ帳 | 1文字ごとに 25ms 空けた同じ長文 | 完全一致 |

＝**こちらの打ち方（`KEYEVENTF_UNICODE`）は正しく、メモ帳が速い注入に追いつかない**（文字数は保たれ、
直前の文字の繰り返しに化ける＝キーリピートへの併合と見られる）。**T-049＝A で、1文字ごとに間合いを
空ける形にした（2026-09-14 実装済み）。**

**同じメモ帳での前後比較（2026-09-14 実測。`Hotkeys.Type` を直接呼び、UI Automation で読み戻し）:**

| 打ち方 | 文字列 | 所要 | 結果 |
|---|---|---|---|
| 1回の `SendInput` にまとめる（直す前） | `/gamemode creative` | 15ms | 崩れる（`/gamemode eeeeeeee`） |
| 1文字ごとに 25ms（いまの `Hotkeys.Type`） | `/gamemode creative` | 527ms | **完全一致** |

#### `marker`（配信マーカー・2026-10-05 追加）

配信中に切り抜きたい場面で無言で押す枠。**押した瞬間が配信・録画の開始から何分何秒か**を、この PC のファイルに記録する。
盤へは成功／失敗だけが返り、時刻は盤に送らない（T-495 A・T-496 A・T-498 A・T-499 A）。

1. OBS に `GetStreamStatus` と `GetRecordStatus` を訊く（obs-websocket 5.x。どちらも `outputActive`（bool）と
   `outputDuration`（**ミリ秒**）を返す。v5.0.0 から。`protocol.md` で確認済み）。接続は他の OBS の指示と同じ（`Obs.WithLinkAsync`）
2. **両方 `outputActive=false` なら失敗**。OBS につながらない・どちらかの要求が断られた・答えが読めないときも失敗
3. 動いている方の `outputDuration` から **（答えが届いた時刻 − 指示の `at`）** を引き、押した瞬間の経過時間にする。負なら 0。
   `at` は押した端末の時計、引く側はこの PC の時計なので、二つの時計のずれはそのまま数字に入る
4. `%APPDATA%\Multitasker\markers\<yyyy-MM-dd>.txt` に 1 行追記（UTF-8・BOM なし・1 押し 1 行・タブ区切り）。書けたら成功

```
2026-10-05 21:14:03<TAB>配信 01:23:45<TAB>録画 00:58:12<TAB>神プレイ            ← lang が "ja"
2026-10-05 21:14:03<TAB>Stream 01:23:45<TAB>Recording 00:58:12<TAB>best play   ← それ以外
```

- **「配信」「録画」の語は、押した時の盤の言語に合わせる**（2026-10-05 追加・T-503／T-505 A）。ブラウザが枠を押したときに
  いまの盤の言語（`getLang()`）を指示の中（暗号化の中）の `args.lang` に入れる。PC は `lang` が **`"ja"` ちょうど**のときだけ
  `配信`／`録画`、**それ以外（`"en"`・無い・文字列でない・知らない値）は全て `Stream`／`Recording`**（英語へフォールバック）。
  PC Agent と盤のサーバーが自分の言語を決める仕組みは変えていない（T-506 B）

- 先頭の時刻とファイル名の日付は、**押した瞬間（`at`）をこの PC のタイムゾーンで**表したもの
- 動いていない方は `配信 -` ／ `録画 -`（英語なら `Stream -` ／ `Recording -`）。ラベルが空なら最後の欄は空（行は `<TAB>` で終わる）
- 経過時間は `時:分:秒`（秒未満は切り捨て。100 時間を超えても時は 2 桁で切らない）
- ラベルの中のタブ・改行（制御文字）は空白にする（1 押し 1 行を崩さないため）
- `agent.log` には `marker ok` ／ `marker failed` だけ書く（ラベルは書かない）。OBS への接続先の行は他の OBS の指示と同じく出る
- トレイのメニュー **マーカーのフォルダを開く**（"Open the markers folder"）がこのフォルダをエクスプローラーで開く（無ければ作ってから）
- OBS のチャプターは打たない（T-496 A）。配信サイトのマーカー連携は無い（T-499 A）

**盤の側: この枠は鳴らない**（T-500 B）。盤は指示の中身を読めないので、ブラウザが枠を保存するとき、種類が `marker` なら
`tasks.quiet`（boolean・平文）を `true`、それ以外の種類では `false` を送る（`POST /api/task` の `quiet`。`true` 以外は false）。
`quiet` の枠は、PC の返事（成功・失敗・5 秒で誰も取りに来なかった・60 秒で結果が来なかった）で**動くが、通知を送らない**
（`src/deck.js` の `settle` → `board.js` の `moveTo(..., { silent })`）。利用者が切り替える欄は無い。盤に見えるのは「この枠は鳴らさない」だけ。

`--check-marker` で、OBS につながずに組み立てだけ見られる（`ObsCheck.Pretend` が OBS の役。ファイルは `--write` を付けたときだけ、その場所にだけ書く）:

```
DeckAgent.exe --check-marker "{\"label\":\"神プレイ\",\"lang\":\"ja\"}"                     # 両方止まっている → verdict failed
DeckAgent.exe --check-marker "{\"label\":\"神プレイ\",\"lang\":\"ja\"}" --stream 5026200 --lag 1200   # 配信だけ → 配信 01:23:45<TAB>録画 -<TAB>神プレイ
DeckAgent.exe --check-marker "{\"label\":\"best play\",\"lang\":\"en\"}" --stream 5026200 --lag 1200 # → Stream 01:23:45<TAB>Recording -<TAB>best play
DeckAgent.exe --check-marker "{\"label\":\"神プレイ\"}" --stream 5026200 --lag 1200                     # lang 無し → Stream 01:23:45<TAB>Recording -<TAB>神プレイ
DeckAgent.exe --check-marker "{\"label\":\"\",\"lang\":\"ja\"}" --stream 5026200 --record 3493400 --lag 1200 --write <フォルダ>
```

`--stream`／`--record` は OBS が答える経過ミリ秒（`off` か省略で止まっている）、`--lag` は押してから訊くまでのミリ秒（既定 1000）。

#### `obs` の `args` は 2 つとは限らない（2026-09-13）

`visible` だけは**シーン名・ソース名・どうするか**の 3 つが要るので、`{op, arg}` の 2 つに収まらない。
**増やし方は「鍵を足す」**＝`op` と `arg` の意味は変えず、`visible` のときだけ `scene` と `source` が**加わる**
（`arg` は他と同じく「どうするか」＝`show|hide|toggle`）。よって:

- **古い形はそのまま動く。** 既に枠に保存済みの `{"op":"scene","arg":"Main"}` 等は 1 文字も変わらず、
  盤も同じ形で封じ続ける（`public/app.js` の `read()` は `visible` のときだけ別の形を作る）。
- **PC 側は鍵で読む**（`JobPlain.Arg(name)`）。無い鍵は空文字になるので、古い指示の `scene`/`source` は空＝
  `visible` 以外の経路には影響しない。
- **新しい形を古い PC が受けると**、`op` が `visible` で知らない操作＝`{"ok":false}` を返して枠は失敗の状態へ。
  黙って別のことをすることはない。

PC 側が OBS に投げる要求（obs-websocket 5.x `protocol.md` で確認済み）:

1. `GetSceneItemId` `{sceneName, sourceName}` → `sceneItemId`（名前→番号。番号は OBS の再起動等で変わるので毎回引く）
2. `GetSceneItemId` `{sceneName, sourceName, searchOffset: 1}` — **同名が 2 つ無いかの確認**。
   **成功したら＝2 つ以上ある＝何もせず失敗**（`{"ok":false}`）。名前ではどちらか決められないため。
   1 つだけなら `600 ResourceNotFound` が返り、先へ進む
3. `arg` が `toggle` のときだけ `GetSceneItemEnabled` `{sceneName, sceneItemId}` → `sceneItemEnabled` を読み、その逆を書く
4. `SetSceneItemEnabled` `{sceneName, sceneItemId, sceneItemEnabled}` — この結果が枠の成否

`--check-obs` で、繋がずに組み立てだけ見られる:

```
DeckAgent.exe --check-obs "{\"op\":\"visible\",\"scene\":\"Main\",\"source\":\"Overlay\",\"arg\":\"toggle\"}" --holds 1 --showing true
```

## 4. 再接続

- 切れたら **1 秒 → 2 → 4 → … 最大 30 秒**の間隔で再接続。`404 unknown agent` だけは再接続せず止まる。
- 再接続すると `pending` の指示が**改めて全部**流れてくる。**既知の `id` は捨てる**（3. のとおり）。
  盤も 5 秒で `expired` にするので、切れている間に出た指示はほぼ全部消えている＝それが仕様（Owner 指定 T-021）。
- 盤の再起動でも同じ（接続は切れ、再接続で `pending` が流れる）。

## 5. 盤側の時間の決まり（変えられない）

| | |
|---|---|
| 作成 → `ack` | **5 秒**。過ぎたら `expired`、枠は「失敗したら」の状態へ。通知が鳴る |
| `ack` → `result` | **60 秒**。過ぎたら `failed`、枠は「失敗したら」の状態へ。通知が鳴る |
| `result` `ok:true` | `done`、枠は「成功したら」の状態へ。通知が鳴る |
| `result` `ok:false` | `failed`、枠は「失敗したら」の状態へ。通知が鳴る |
| 押した瞬間 | 枠は「PC が実行している間」の状態へ。**鳴らない**（押した本人は知っている） |

**例外: `tasks.quiet` の枠（配信マーカー）は、上の表で「通知が鳴る」となっている所でも鳴らない**（動きは同じ。3. の `marker`）。

盤は 5 秒ごとに見回りもするので、盤が再起動しても期限は守られる（数秒の遅れはあり得る）。
`done`/`failed`/`expired` の行は 1 日で消える。

## 6. 手で試す（curl・Git Bash）

```bash
TOKEN=...   # 設定画面「PC」で登録したもの
curl -N "https://<盤>/agent/$TOKEN/events?name=$(hostname)"   # つないだまま、盤で枠を押す
curl -X POST https://<盤>/agent/$TOKEN/jobs/42/ack
curl -X POST -H 'Content-Type: application/json' -d '{"ok":true}' https://<盤>/agent/$TOKEN/jobs/42/result
```

`ack` が間に合わなければ 2 つ目は `409 job is expired` になる。それが 5 秒ルール。
