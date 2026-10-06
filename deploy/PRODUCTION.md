# 本番環境の作り方

新しいサーバーに一から立てる手順。**上から順に実行すれば動く**ところまで書いてある。

各段の最後に **「確認」** がある。確認が通らないまま次へ進まないこと。
このボードの壊れ方は「静かに黙る」なので、**後で気づく**のが一番高くつく。

---

## 0. サーバーを選ぶ（先に決めること）

**Spot インスタンスに置かないこと。**

回収は前触れなく来る。実測した例では **3時間のうち4回**、1分から55分まで停止した
（いずれも `systemd-poweroff` による正常停止＝回収の作法）。停止している間、

- Claude が手を止めても**通知が届かない**（このボードが存在する理由が消える）
- 開いていた画面が**真っ白になる**（読み込み直しが停止中に当たった場合。対策済みだが、
  それは「落ちても壊れない」であって「落ちない」ではない）

**必要なもの**は小さい。実測で **DB 9MB・メモリ 1.8GB のうち使用 500MB**。
`t4g.small` のオンデマンドで十分足りる。**安さのために可用性を捨てる場所ではない。**

**必要なもの:**
- Docker が動く Linux（Amazon Linux 2023 で確認済み）
- Postgres 17（同じサーバーのコンテナでよい）
- 80/443 が開いていること、22 が自分から届くこと
- ドメイン1つ

---

## 1. Postgres を用意する

既にある Postgres に**別のデータベース**を作るのが一番早い。

```bash
docker exec -it <postgres コンテナ> psql -U <ユーザー> -c "create database taskboard;"
```

新しく立てるなら、データを**名前付きボリューム**に置くこと。コンテナの中に置くと、
コンテナを作り直した瞬間に消える。

**確認:**
```bash
docker exec <postgres コンテナ> psql -U <ユーザー> -lqt | grep taskboard
```

---

## 2. 通知の鍵を作る

**一度だけ作り、二度と変えないもの。** 変えると**登録済みの iPhone が全部無効**になり、
しかも**誰にも何も知らされない**（黙って届かなくなる）。

このリポジトリで:

```bash
npm install
npm run vapid
```

出た2行をバックアップる。**秘密鍵はサーバーの `.env` にだけ置く。**

---

## 3. `.env` を書く

サーバーの `~/taskboard-config/.env`（設定と、リポジトリの中身を分ける）:

```
DATABASE_URL=postgres://<ユーザー>:<パスワード>@<host>:5432/taskboard
VAPID_SUBJECT=mailto:あなた@example.com
VAPID_PUBLIC_KEY=<手順2の公開鍵>
VAPID_PRIVATE_KEY=<手順2の秘密鍵>
BACKUP_TOKEN=<24文字以上のランダム文字列>
BACKUP_DIR=/backups
NODE_ENV=production
REGISTRATION_OPEN=true
```

`BACKUP_TOKEN` の作り方:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

```bash
chmod 600 ~/taskboard-config/.env
```

**ベータ中は `REGISTRATION_OPEN=true` を `.env` に書く**（2026-09-14 Owner『T64：解放して』）＝誰でも登録できる。
消せば「まだ誰もいない間だけ開き、1人目ができた時点で自動的に閉じる」に戻り、以後は招待コードで入れる（手順8）。

---

## 4. 立ち上げる

```bash
cd ~/taskboard && docker build -t taskboard:latest .

docker run -d --name taskboard \
  --network <postgres と同じネットワーク> \
  --restart unless-stopped \
  --env-file ~/taskboard-config/.env \
  -v ~/backups/taskboard:/backups:ro \
  taskboard:latest
```

**`-v ~/backups/taskboard:/backups:ro` を忘れないこと。** 忘れてもボードは普通に動くが、
**バックアップの引き取りだけが 503 で静かに止まる。** 読み取り専用（`:ro`）にすること。

**確認:**
```bash
docker logs taskboard | tail -1     # → taskboard listening on 3040; push configured
```
`push NOT configured` と出たら手順2・3の鍵が入っていない。

---

## 5. 表に出す

Caddy を使う場合、Caddyfile に:

```
board.example.com {
    reverse_proxy taskboard:3040
}
```

**この Caddyfile をリポジトリ側にも置くこと。** 他の何かのデプロイがサーバー上の
Caddyfile を上書きする構成なら、**次のデプロイで消えて通知だけが黙って止まる**。

**同じ台の Caddy を別プロジェクトが持っている場合（いまの本番はこれ）:** その Caddy の
Caddyfile は別プロジェクトのデプロイで毎回上書きされる。そこで、その Caddyfile の先頭に
`import /config/sites/*.caddy` を置いてもらい、**盤の block は Caddy コンテナの中の
`/config/sites/<名前>.caddy` に置く**（`/config` は Caddy の設定ボリュームで、
コンテナを作り直しても残る）。置く・直す・読み込み直す:

```bash
# 【サーバー / SSH】
docker exec <Caddy のコンテナ名> ls /config/sites/                      # いま何が在るか
docker exec <Caddy のコンテナ名> cat /config/sites/<名前>.caddy         # 中身
docker exec -i <Caddy のコンテナ名> sh -c 'cat > /config/sites/<名前>.caddy' <<'EOF'
board.example.com {
    reverse_proxy taskboard:3040
}
EOF
docker exec <Caddy のコンテナ名> cat /config/sites/<名前>.caddy       # ★書けたか目で見る
docker exec <Caddy のコンテナ名> caddy reload --config /etc/caddy/Caddyfile
```

**`-i` を落とすと、ファイルが空になる。** `docker exec` は `-i` が無いと標準入力をコンテナに
渡さないので、`cat >` は何も受け取らずに**ファイルを空で作り直す**。reload のログに
`"msg":"Import file is empty"` が出たらこれ。盤は Caddy から消えて 404/502 になる。
`-i` を付けて書き直し、`cat` で中身を見てから reload する（2026-09-14 に実際に踏んだ）。

**ドメインを変えるとき**（2026-09-14 に実施）: 上の block のサーバー名を変えて reload →
`.env` の `SITE_URL` を新しい住所に → コンテナを立て直す（§7.5 の後半だけ。イメージは build し直さない）→
**スマホは新しい住所でホーム画面に追加し直して通知を有効にし直す**（通知の登録は住所ごと）→
**PC は「この PC をつなぐ」をやり直す**（PC は盤の住所を覚えている）。

DNS の A レコードをこのサーバーに向ける。証明書は Caddy が自動で取る。

**確認:**
```bash
curl -s https://board.example.com/api/health     # → {"ok":true}
```
`/api/health` は**データベースを触る**。ここが 200 ならボードと DB の両方が生きている。
トップページだけ見て判断しないこと（静的ファイルは DB が死んでいても返る）。

---

## 6. 夜ごとのバックアップ

`~/taskboard-backup.sh`（このリポジトリの `deploy/` に同じものがある）を置いて実行権を付け、

> **このスクリプトは名前を何も決め打ちしない。** Postgres のコンテナ名も、DB 名も、
> ユーザー名も、Postgres の版も、`.env` の `DATABASE_URL` と、ボードのコンテナが
> 繋がっているネットワークから割り出す。`.env` の場所だけは決められないので、
> 見つからなければ `ENV_FILE=/path/to/.env` を渡す。
>
> **初版は決め打ちしていて、しかも `set -e` で黙って止まっていた。** 存在しない名前の
> コンテナを探し、1行目で終わり、何週間も控えを1つも作らないまま、誰も気づかなかった。
> いまは失敗した理由を必ず1行出して止まる。

systemd のタイマーで毎晩回す:

```bash
sudo tee /etc/systemd/system/taskboard-backup.service > /dev/null <<'EOF'
[Unit]
Description=Nightly copy of the task board
After=docker.service

[Service]
Type=oneshot
User=<ユーザー>
ExecStart=/home/<ユーザー>/taskboard-backup.sh
StandardOutput=append:/home/<ユーザー>/backups/taskboard/log
StandardError=append:/home/<ユーザー>/backups/taskboard/log
EOF

sudo tee /etc/systemd/system/taskboard-backup.timer > /dev/null <<'EOF'
[Unit]
Description=Nightly copy of the task board

[Timer]
OnCalendar=*-*-* 18:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable --now taskboard-backup.timer
```

**`.env` も同じ束に入る。** DB より小さく、失った時に痛いのはこちら（手順2）。

**確認 — ここは必ず復元まで試すこと。試していないバックアップはバックアップではない:**
```bash
~/taskboard-backup.sh                                   # 手で一度回す
dump=$(ls -1t ~/backups/taskboard/*.dump | head -1)
docker exec <pg> psql -U <ユーザー> -c "create database restore_check;"
docker exec -i <pg> pg_restore -U <ユーザー> -d restore_check < "$dump"
# 元と件数を突き合わせる
for t in users pages tasks states moves push_subscriptions; do
  echo -n "$t: "
  docker exec <pg> psql -U <ユーザー> -d taskboard -tAc "select count(*) from $t" | tr -d '\n'
  echo -n " / "
  docker exec <pg> psql -U <ユーザー> -d restore_check -tAc "select count(*) from $t"
done
docker exec <pg> psql -U <ユーザー> -c "drop database restore_check;"
```

---

## 7. 最初のアカウント

> **既にこのボードを動かしていた場合の注意。**
> 一つ前の版は、ログインの時にパスワードそのものをサーバーへ送っていた。
> 中身は暗号化されていたが、**送られてくるパスワードを見れば運営が開けた**。
> いま送るのは、パスワードから導いたトークンで、それでは暗号化された鍵は開かない。
> **古いアカウントはそのトークンと噛み合わないのでログインできない。**
> 作り直すには、まず消す（消さないと同じメールで登録できない）:
>
> ```bash
> docker exec <postgres コンテナ> psql -U <ユーザー> -d <データベース> -c 'select email from users;'
> docker exec <postgres コンテナ> psql -U <ユーザー> -d <データベース> -c 'delete from users;'
> ```
>
> **`-U`（ユーザー）と `-d`（データベース）は別物。取り違えると**
> **`relation "users" does not exist` が出る。** 両方 `.env` の `DATABASE_URL`
> に入っている。パスワードを出さずに読むには:
>
> ```bash
> sed -n 's|^DATABASE_URL=postgres://\([^:]*\):.*@\([^/]*\)/\(.*\)$|user=\1  host=\2  db=\3|p' <.env の場所>
> ```
> **全部消える。** 枠・ページ・状態・通知の登録・Webhook は `on delete cascade`
> で一緒に消え、使用済みの招待コードは未使用に戻る（`on delete set null`）。
> **元に戻せるのは夜ごとのバックアップだけ。**
> 新しく建てる場合は関係ない。

`https://board.example.com` を開き、**「登録する」** から登録する。
（`REGISTRATION_OPEN=true` を書いていなければ、**この1人目ができた時点で入口は自動的に閉じる**。手順3参照。）

登録時に**復旧用の鍵が一度だけ表示される**。**必ず保存すること。** パスワードを忘れ、
かつこれを失うと、**タスクの中身は誰にも読めなくなる**（運営にも戻せない）。

**確認:** 一度ログアウトして、入り直せること。

---

## 7.5 更新のしかた（2回目以降）

**サーバーに git は無い。ビルドもサーバーではしない。**
手元でイメージを build して、それを送る。

**サーバーは Graviton（arm64）。** x86 の PC で普通に `docker build` すると
動かないイメージができる。`--platform linux/arm64` が要る。

**【デプロイ PC / Git Bash】** 一発で流す（2026-09-14 差し替え、2026-09-16 訂正、2026-10-05 フォルダと clone し直しを訂正、2026-10-06 止まらなかった囲い方を訂正）。**どの段で失敗しても止まり、最後に「載った版＝送った版」を照合する。**
それまでの形（`… ; docker save …`）は、`git pull` や `build.ps1` が失敗しても `;` の後へ進んで**手元に残った古いイメージを送り、健康確認が通るので成功に見えた**（T-086）。

**`<リポジトリ>` は、GitHub の `MaxEvGaming/Multitasker` を clone したフォルダ（一番上に `Dockerfile` と `agent/` がある所）。**
**2026-09-29 より前に clone したフォルダは使えない。** その日にリポジトリを公開用に作り直し、前の非公開の履歴（いまの `MaxEvGaming/Multitasker-archive`）と
新しい履歴には共通の commit が無いので、下の `git pull --ff-only` で止まる。一度だけ clone し直す:

```bash
git clone https://github.com/MaxEvGaming/Multitasker.git <新しいフォルダ>
```

`public/download/DeckAgentSetup.exe` は git に入っていないので、新しいフォルダには無い。下の手順の中の `build.ps1` が作るので、手で写す必要は無い
（その PC に .NET 10 SDK と Inno Setup 6.3+ が要る。§7.6）。

**全体を `(` と `)` で囲い、`set -eo pipefail` を掛けてある。** 外すと、貼り付けた Git Bash そのものが終了して窓が閉じ、失敗した段のエラーが読めない（2026-09-16 T-097）。
**囲いのあとを `|| echo …` にしてはいけない。** bash は `||` の左に置かれたものの中では `set -e` を効かせないので、途中の段が失敗しても最後まで走る（2026-10-06 に実際に起きた。`git pull --ff-only` が失敗したのに先へ進み、古い中身のまま build と入れ替えが走って、版の照合も同じ版どうしで「OK」になった）。だから終わりは `); rc=$?; [ $rc -eq 0 ] || echo …` の形にしてある。`pipefail` は、`docker save | gzip | ssh` のような管の途中の失敗でも止めるため。

```bash
KEY=<鍵>; HOST=<ユーザー>@<サーバー>; BOARD=https://<盤>; H=/home/<ユーザー>; DB=board; WEB=<Caddy と同じネットワーク>; CADDY=<Caddy のコンテナ名>
(
set -eo pipefail
cd <リポジトリ>
git pull --ff-only
echo "== deploying $(git log --oneline -1)"
powershell -NoProfile -ExecutionPolicy Bypass -File ./agent/build.ps1
test -f public/download/DeckAgentSetup.exe
WANT=$(cat public/download/agent/version.json); echo "== installer $WANT"
docker buildx build --platform linux/arm64 -t taskboard:latest --load .
ssh -i $KEY $HOST 'docker image inspect taskboard:latest >/dev/null 2>&1 && docker tag taskboard:latest taskboard:rollback || true'
docker save taskboard:latest | gzip | ssh -i $KEY $HOST 'docker load'
ssh -i $KEY $HOST "set -e; SITE=/config/sites/taskboard.caddy
docker rm -f taskboard-next 2>/dev/null || true
docker run -d --name taskboard-next --network $DB --restart unless-stopped --memory=512m --env-file $H/taskboard-config/.env -v $H/backups/taskboard:/backups:ro taskboard:latest
docker network connect $WEB taskboard-next
ok=0; for i in 1 2 3 4 5 6 7 8 9 10; do docker exec taskboard-next node -e \"fetch('http://127.0.0.1:3040/api/health').then(r=>r.text()).then(t=>process.exit(t.includes('true')?0:1)).catch(()=>process.exit(1))\" && ok=1 && break; sleep 2; done
[ \$ok = 1 ] || { echo 'new container is not healthy; old one left running'; docker logs taskboard-next | tail -5; exit 1; }
printf '<盤のドメイン> {
    reverse_proxy taskboard-next:3040
}
' | docker exec -i $CADDY sh -c \"cat > \$SITE\"
docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile
docker rm -f taskboard
docker rename taskboard-next taskboard
printf '<盤のドメイン> {
    reverse_proxy taskboard:3040
}
' | docker exec -i $CADDY sh -c \"cat > \$SITE\"
docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile
docker logs taskboard | tail -1"
GOT=$(curl -s $BOARD/download/agent/version.json)
[ "$GOT" = "$WANT" ] && echo "== OK: live $GOT" || { echo "== NOT UPDATED: live $GOT, wanted $WANT"; exit 1; }
); rc=$?; [ $rc -eq 0 ] || echo "== 失敗（rc=$rc）: すぐ上のエラーの段で止まりました（サーバーの古い方は動いたまま）"
```

最後の行が `== OK: live {"version":…}` で終わらなければ**更新されていない**。途中で止まったなら、`== 失敗:` の直前にその段のエラーが出ている。それを見てから直す。

**【サーバー / SSH】** 入れ替える — **止めずに**（2026-09-14 T-079＝A。それまでは `docker rm -f` → `run` で数十秒止まり、
その間の PC の接続が切れ、押した指示は 5 秒で失敗していた）:

順番が全部。**新しい方を先に立てて健康を確かめ、Caddy の向き先を切り替えてから、古い方を消す。**
途中で失敗したら古い方が動いたまま残る。

```bash
H=/home/ec2-user; DB=board; WEB=<Caddy と同じネットワーク>; CADDY=<Caddy のコンテナ名>; SITE=/config/sites/taskboard.caddy; HOSTNAME=<盤のドメイン>
# 1. 新しい方を仮の名前で立てる（古い方はそのまま動いている）
docker rm -f taskboard-next 2>/dev/null
docker run -d --name taskboard-next --network $DB --restart unless-stopped --memory=512m   --env-file $H/taskboard-config/.env -v $H/backups/taskboard:/backups:ro taskboard:latest
docker network connect $WEB taskboard-next
# 2. 新しい方が健康か（DB まで届くか）。駄目ならここで止める＝古い方が生きている
for i in 1 2 3 4 5 6 7 8 9 10; do docker exec taskboard-next node -e "fetch('http://127.0.0.1:3040/api/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(t.includes('true')?0:1)}).catch(()=>process.exit(1))" && break; sleep 2; done
# 3. Caddy の向き先を新しい方へ（★ -i を落とすとファイルが空になる。§5）
docker exec -i $CADDY sh -c "cat > $SITE" <<EOF
$HOSTNAME {
    reverse_proxy taskboard-next:3040
}
EOF
docker exec $CADDY cat $SITE && docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile
# 4. 古い方を消す（この瞬間だけ PC の接続が切れ、数秒で新しい方へつなぎ直す）
docker rm -f taskboard
# 5. 名前を戻し、Caddy も戻す（バックアップや `docker logs taskboard` が名前を頼るため。rename と reload は続けて打つ）
docker rename taskboard-next taskboard
docker exec -i $CADDY sh -c "cat > $SITE" <<EOF
$HOSTNAME {
    reverse_proxy taskboard:3040
}
EOF
docker exec $CADDY cat $SITE && docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile
```

**なぜ名前を戻すか**: 夜のバックアップ（`taskboard-backup.sh`）と手順書の `docker logs taskboard` は
コンテナ名 `taskboard` を頼る。仮の名前のまま残すと、翌朝のバックアップが「no container called taskboard」で止まる。
5 の rename → reload の間だけ Caddy が `taskboard-next` を引けず、その 1 秒弱は 502 になり得る。

**`--network` は1つしか指定できない。** Postgres 側で起動して、Caddy 側は
`docker network connect` で後から繋ぐ。繋がないと Caddy が `taskboard:3040` を
見つけられず 502 になる。ネットワーク名は:

```bash
docker inspect <Caddy のコンテナ名> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

**確認:**

```bash
docker logs taskboard | tail -2
docker exec taskboard node -e "fetch('http://127.0.0.1:3040/api/health').then(r=>r.text()).then(console.log)"
```

`taskboard listening on 3040; push configured` と `{"ok":true}` の両方。
**`.env` は送らないので書き換わらない。** 通知の鍵が変わるとスマホの登録が全部無効になる。

---

## 7.6 PC 側のインストーラを盤に置く（`public/download/`）

盤の **設定 → PC → ① ダウンロード** は `https://<盤>/download/DeckAgentSetup.exe` を配り、
PC のアプリは `https://<盤>/download/agent/version.json` を見て更新を知る。
**この 2 つはイメージに入れる静的ファイル**（`Dockerfile` が `public/` を丸ごと COPY する）で、
**exe は git に入っていない**（33 MB・`.gitignore`）。だからデプロイのたびに、**イメージを build する前に** `public/download/` に置く。

**【Windows の PC / PowerShell】** exe とインストーラを作って `public/download/` に置く（.NET 10 SDK と Inno Setup 6.3+ が要る。
ISCC は `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe` を探す）:

```powershell
cd <リポジトリ>
.\agent\build.ps1
```

最後に次の 2 行が出ること（`<版>` は `agent/DeckAgent.csproj` の `<Version>`）:

```
== copied to ...\public\download\DeckAgentSetup.exe
== wrote  ...\public\download\agent\version.json: {"version":"<版>","file":"DeckAgentSetup.exe"}
```

版は `agent/DeckAgent.csproj` の `<Version>` が正本。上げるときはそこだけ変えて `build.ps1` を回せば、
インストーラの版表示・`version.json`・アプリが名乗る版が揃う。**`version.json` は git に入っているので、
版を上げたら commit する**（そうしないと別の PC で build したイメージが古い版を名乗る）。

そのあと **7.5 の手順そのまま**（`docker buildx build --platform linux/arm64 …` → `docker save | ssh … docker load` → 入れ替え）。
**Windows で build するなら `build.ps1` の直後に同じ PC で `docker buildx build` を実行する。** 別の PC（Linux 等）で build する場合は、
`public/download/DeckAgentSetup.exe` をその PC の同じ場所に先に置く（`scp` でよい。`version.json` は git に入っている）。

**確認:**

```bash
curl -s https://<盤>/download/agent/version.json          # → {"version":"<版>","file":"DeckAgentSetup.exe"}
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' https://<盤>/download/DeckAgentSetup.exe
                                                           # → 200 と 30,000,000 台の数字
```

404 が返るなら、イメージを build したときに `public/download/DeckAgentSetup.exe` が無かった（`build.ps1` を回していない、または別の PC で build した）。
そのイメージのままだと、**盤の ① ダウンロードが 404 で静かに空振りする**（それ以外は普通に動く）。

**コード署名はしていない**（T-028「一旦なし」）。初回実行で Windows の SmartScreen が出ることがある。
盤の案内②に「詳細情報 → 実行」と書いてあるのはそのため。

---

## 8. 二人目以降（要るなら）

```bash
docker exec taskboard node src/invite.js "誰それ用" 7      # 7日間有効
docker exec taskboard node src/invite.js --list            # 未使用の一覧
```

出た `https://.../?invite=…` を直接渡す。**1回だけ使える。**

---

## 9. iPhone

1. Safari で開く
2. 共有ボタン → **ホーム画面に追加**
3. **ホーム画面のアイコンから開き直す**（iOS は追加したものにしか通知を出さない）
4. ログイン → 設定 → **この端末で通知を受け取る** → 許可
5. **テスト送信**で届くことを確認

---

## 10. Claude 側

設定 → **Claude への指示をコピー** → そのまま Claude に貼る。
送り先も鍵も設定の勘所も文面に入っている。

自分で書きたい場合は、設定の「手動で設定する場合はこちら」から
**実際に動いているスクリプト**を落とせる。

**確認:** 設定の「枠」に**実際に届いた名前**が出れば繋がっている。

**アカウントを作り直した後は、前の鍵はもう合わない。** 指示文を取り直して、PC 側の
`notify.json` の `key` を入れ替えること。**鍵が入っていないとフックは何も送らない**
（読める名前を送るくらいなら黙る、という作りにしてある）。

---

## 11. PC 側（見張りとバックアップの引き取り）

`tools/` の4ファイルを PC の好きなフォルダに置く:

```
watch.ps1  +  watch.json         （watch.example.json をもとに作る）
pull-backup.ps1  +  backup.json  （backup.example.json をもとに作る）
```

**`.json` は必ず `.ps1` の隣に。** `backup.json` の `token` は手順3の `BACKUP_TOKEN`。

タスクスケジューラで **Create Task…**（Basic ではない）:

| | 見張り | バックアップの引き取り |
|---|---|---|
| Triggers | Daily ＋ **Repeat every 5 minutes / Indefinitely** | Daily 1回だけ |
| Program | `powershell.exe` | 同左 |
| Arguments | `-NoProfile -ExecutionPolicy Bypass -File "<置いた場所>\watch.ps1"` | 同左（`pull-backup.ps1`） |

どちらも **Conditions の "Start the task only if the computer is on AC power" を外す**、
**Settings の "Run task as soon as possible after a scheduled start is missed" を入れる**。

**確認:** 手で一度 Run する。見張りは Slack に何も出なければ正常。引き取りは
`%USERPROFILE%\Backups\taskboard` にファイルが2つ増える。

**この見張りは PC が起きている間しか回らない。** 外出中の停止は帰るまで分からない。

---

## 引き継ぎのために

**このボードの壊れ方はすべて「静かに黙る」。** 動かなくなったのではなく、動いているように
見えたまま何も起きなくなる。だから確認は毎回「実際に届いたか」で行うこと。

以下は開発中に実際に起きたもので、**どれも外からは同じに見えた**（＝何も起きない）:

| 見えた症状 | 真因 |
|---|---|
| 枠が動かない | 停止の知らせだけが平文で出ていた（送る経路が2本あり、片方だけ封じ忘れ） |
| 指示しても進行中にならない | 10秒ためた停止が、後から来て開始を打ち消していた |
| 枠が全部消えた | 空のページを見ていた（何も表示しないので消えたように見えた） |
| 画面が真っ白 | 起動時の問い合わせに時限が無く、応答が来ないと**どの画面も出ない** |
| 通知が来ない | サーバーが落ちていた（Spot の回収） |
| 誰も登録できない／全員が「要求が多すぎます」 | Caddy が `X-Forwarded-For` を正しく付けていないと、全員が同じ IP に見えて、IP ごとの回数制限（登録 5 回／時・prelogin 60 回／時）が全体に掛かる（`src/security.js`。C8） |

**最後の1つだけは、直しようがない。サーバーを選ぶしかない。**
