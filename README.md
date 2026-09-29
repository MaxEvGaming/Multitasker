# Multitasker

日本語版: [README.ja.md](README.ja.md)

A small site for seeing, at a glance, the Claude sessions you have running side by side — as nine squares.
It takes word from Claude through a webhook of the same shape as Slack's, and notifies your phone only when it needs to.

How to set it up on a server is in [deploy/PRODUCTION.md](deploy/PRODUCTION.md) (in Japanese).

## What it does

- **Nine squares.** One square is one piece of work
- Each square shows **a title, a state, and (if the state runs a timer) a ring of the time left**
- **The left half and the right half of a square lead to different places.** Which leads where is shown faintly under the square
- **You make the states, and the arrows that leave them.** "Waiting, On it, Running, Stopped" are the examples a new board starts with;
  you can add more, and change the order they go round in
- **When Claude reports that a session has stopped**, the square carrying that name moves by itself
- **When you give Claude an instruction**, the square carrying that name moves by itself too
- **When the expected time runs out**, it moves by itself as well
- **Your phone is notified only when a square moved by itself.** It stays quiet when you pressed the square (you already know)

## What a state holds

| | Meaning |
|---|---|
| ◀ Where a left tap leads | Where the square goes when its left half is pressed. Leave it empty and the left half does nothing |
| Where a right tap leads ▶ | The same, for the right half |
| Where it goes when Claude stops | Used both for Claude's report that it has stopped and for the timer running out |
| Where it goes on an instruction | Used for the report that you have given Claude an instruction |
| Run a timer | While the square is in this state, the ring runs down |

## Sending instructions to a PC

Put a **command** on a square and the square becomes a button that drives your PC.
Pressing it (either half) sends an instruction to the PC instead of following the arrows.

- **What it can do**: open an app or a file / open a URL /
  press a hotkey (written `ctrl+shift+f13`) / type text (press the key that opens chat → type the line → Enter; for game commands) /
  OBS (switch scene, recording, streaming, mute or unmute an audio source, show or hide a source).
  Running a command (one line handed to `cmd /c`) **was switched off on 2026-09-14, because it ran any one line with nothing to hold it back**
- **How the square moves**: press → the **While the PC is working** state (default: Running) → on success, the **When it succeeds** state (default: Waiting);
  on failure, the **When it fails** state (default: Stopped). All three can be chosen per square, from your own states
- **The 5-second rule**: if **no PC comes for the instruction within 5 seconds of the press, it is thrown away and the square goes to the failure state**.
  This cannot be changed. Once a PC has said "received", **no result within 60 seconds counts as a failure**
- **Only the colour comes back**: success or failure. The command's output is never sent
- **It rings only when the PC has answered (success, failure, or nobody came)**. It does not ring on the press.
  This is the same rule as every other square: notify only when the square moved by itself
- **Encryption is required**: the browser seals the command with the same key as the square's name, and the server cannot read it.
  An instruction the server can read is an instruction that whoever takes over the server can write.
  On a board that is not encrypted, the settings screen says "Turn on encryption first" and no command can be entered

**Connecting a PC:** three steps under Settings → **PC** (see "The PC side" below). One account can register any number of PCs;
the list in the settings screen **switches each one ON or OFF** (OFF does not drop the connection — the board just stops sending to it) and removes it.
A square can choose **Which PC it runs on**; the default is "Every PC that is switched on".
What the PC side has to implement is in [docs/DECK_AGENT_PROTOCOL.md](docs/DECK_AGENT_PROTOCOL.md) (in Japanese).

## The PC side (installing)

Instructions are received and carried out by a small tray program that stays running on the PC, **Multitasker PC Agent** (`agent/`, Windows only).
Details are in [agent/README.md](agent/README.md) (in Japanese). **Setting it up is a matter of pressing what the board tells you to press.**

1. In the board's **Settings → PC**, press **① Download** to get `DeckAgentSetup.exe`
2. Run it and press Next to the end (no administrator rights needed; it also registers the program to start at logon and to receive `multitasker://` links).
   When it finishes the program starts, and a round icon appears next to the clock
3. In **a browser on the same PC**, press **Settings → PC → ③ Connect this PC**. The browser opens a `multitasker://pair#…` link,
   the program receives the board's address, token and key, and connects. Once the PC section says **Connected ✓**, pressing a square runs it on that PC

**If you are setting up from a phone, or the program did not receive the link**, the board shows a **Connect code** (the same string).
Copy it, paste it into the **Connect code** field of the program's settings window (double-click the tray icon), and press **Paste and connect**.
The original three fields (board address, token, key) are under **Advanced** in that window and can be filled in by hand.

To use OBS, open **Tools → WebSocket Server Settings** in OBS and enable the WebSocket server.
The program reads the port and the password from that PC's own OBS settings; there is nothing to type
(the OBS fields under Settings → Advanced are only for using values other than the ones OBS has).

**Updates:** at start-up and every 24 hours the program looks at `<board>/download/agent/version.json`, and if there is a newer version
the tray menu shows **Update available (x.y.z)**. Choosing it opens the download. It never downloads and replaces itself on its own.

Settings are in `%APPDATA%\Multitasker\agent.json`, and the log is `agent.log` in the same place (success or failure only; command output is not written).
Uninstalling leaves `agent.json` behind.

**What the board has to carry:** `public/download/DeckAgentSetup.exe` (in `.gitignore`, 33 MB) and `public/download/agent/version.json`.
`agent/build.ps1` puts both there (it needs the .NET 10 SDK and Inno Setup 6.3+). Getting them to production is
section 7.6 of [deploy/PRODUCTION.md](deploy/PRODUCTION.md).

Checks: `node test/deck-seal-agent.js` (agreement of the encryption; needs the exe) and
`DATABASE_URL=... node test/deck-agent.js` (starts the real exe and presses squares → success / failure / the 5-second expiry; starting with a `multitasker://pair#…` argument →
`agent.json` is written and it connects; handing over to an instance already running; parsing the connect code; the URL rules).

## Running it locally

```bash
docker run -d --name tb-dev -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=taskboard -p 55432:5432 postgres:17-alpine
npm install
npm run vapid            # put the two lines it prints into the variables below
DATABASE_URL=postgres://postgres:dev@127.0.0.1:55432/taskboard \
VAPID_SUBJECT=mailto:you@example.com \
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
npm start
```

Open `http://127.0.0.1:3040` and make an account with **Create account**.
With `REGISTRATION_OPEN=true` anyone can register. Without it, registration is open only while there are no users, and closes once the first one exists.

## Tests

With the server running, in another window:

```bash
DATABASE_URL=... node test/e2e.js        # the board, end to end
DATABASE_URL=... node test/security.js   # attempt limits, changing and resetting passwords, deletion, the webhook's limit
DATABASE_URL=... node test/push-rule.js  # when a notification rings
DATABASE_URL=... node test/password-never-sent.js  # the password never leaves the browser
DATABASE_URL=... node test/deck.js       # instructions to a PC (press → collected → answered → the square moves; thrown away at 5 seconds; limits), building the connect code, completing URLs
node test/deck-seal.js                   # known-answer vector for a sealed instruction (checked against the C# side)
```

`deck.js` plays the PC's part itself (the same SSE stream and the same three URLs as the real one).
It has **two checks that wait 5 seconds and one that makes 620 requests**, so it takes about 30 seconds.
`push-rule.js` also checks "silent on the press, rings only when the answer comes".

`push-rule.js` uses a self-signed certificate for its fake push service, so
**the server has to be started with `NODE_TLS_REJECT_UNAUTHORIZED=0`**, and
the certificate has to be made in `test/` first (tests only; the push services used in production have real certificates):

```bash
cd test && openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem   -days 2 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
```

`e2e.js` walks a real Postgres from registration through the rounds, the webhook and the timer running out.
`security.js` actually makes the requests: repeated wrong passwords get locked out, the rows of a deleted account
are really gone, and a webhook that keeps being hit is refused.
`push-rule.js` **stands up a fake push service and counts what actually arrives**, and checks
"silent when you pressed it, rings only when it moved by itself"
(it needs the self-signed certificate in `test/*.pem`; how to make it is at the top of that file).

## Environment variables

| | |
|---|---|
| `DATABASE_URL` | Where Postgres is. **Use a database of its own** |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | The notification keys. `npm run vapid` makes them |
| `VAPID_SUBJECT` | A contact beginning with `mailto:` or `https://`. Apple does not accept anything else |
| `PORT` | Default 3040 |
| `REGISTRATION_OPEN` | `true` lets anyone register. Without it, only the first person can |
| `SITE_URL` | The address used when building invitation links and reset links |
| `BACKUP_TOKEN` | A secret string for fetching backups. 24 characters or more. **If it is not set, that URL does not exist** |
| `BACKUP_DIR` | Where backups are kept (inside the container). Default `/backups` |
| `NODE_ENV` | When `production`, the login cookie is HTTPS-only |

## Why it is built this way

- **There is no build step.** It runs on plain Node and a plain browser, so that there are fewer places for it to break
- **The password never leaves the browser.** What is sent to log in is a **token** derived from the password and
  the account's salt (a random value per account) — a value for sending only, not the password itself.
  The server stores it with scrypt, but the token does not open the encrypted key
  (the derivation is split in two, and the half that opens the key stays in the browser).
  So **reading what is stored, or listening to the connection, does not open the contents.**
  What this cannot protect against is the site itself serving different code,
  which is true of everything that encrypts in the browser
- **scrypt ships with Node**, so no native extension has to be brought in.
  Upgrading Node does not break it
- **Notifications go straight to the push service of the phone's browser (Apple's, for an iPhone).** No third-party relay
- **The webhook has the same shape as Slack's** (`{"text": "*name* — body"}`).
  A notification hook on the PC side only has to change where it sends; nothing needs rewriting

## When someone forgets their password

No email is sent, so **the administrator makes a reset link and hands it over**:

```bash
docker exec taskboard node src/reset.js someone@example.com
```

It prints a link that is valid for 24 hours and works once. The moment it is used, every session that person has open
is closed (in case the account had been taken over).

## Running the tests (local)

There are 27. **19 need the server and a database, and 3 of those (`push-rule` `start-signal` `tenancy`) also need the self-signed certificate and the notification keys.**
`deck-seal-agent` and `deck-agent` also need the PC Agent's exe.
When something is missing it looks like "exited abnormally" or "0 notifications", but that is the environment falling short, not a fault.

```bash
# 1. A throwaway database
docker exec postgres psql -U postgres -c "create database taskboard_test;"

# 2. The certificate the fake push service uses (test/*.pem is in .gitignore)
cd test && MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

# 3. The notification keys
npm run vapid

# 4. The server (NODE_TLS_REJECT_UNAUTHORIZED=0 is needed on the server side as well:
#    the fake push service is self-signed, so the sender would refuse it)
DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/taskboard_test \
PORT=3040 REGISTRATION_OPEN=true NODE_TLS_REJECT_UNAUTHORIZED=0 \
VAPID_SUBJECT=mailto:test@example.com VAPID_PUBLIC_KEY=<public key> VAPID_PRIVATE_KEY=<private key> \
node src/server.js &

# 5. The tests (REGISTRATION_OPEN is needed on the test side too: e2e switches what it expects of the "door")
DATABASE_URL=... BASE=http://127.0.0.1:3040 REGISTRATION_OPEN=true NODE_TLS_REJECT_UNAUTHORIZED=0 \
  node test/e2e.js
```

**7 need no database** (`crypto` `crypto-agreement` `deck-seal` `download` `editors` `i18n` `settings-order`).
Of these, `i18n` checks that the wording on screen exists in both languages and that no Japanese is left in the markup.

## Licence

The source code is released under the **MIT License**. The full text is in [LICENSE](LICENSE).

- **What you may do**: use it, read it, modify it, redistribute it, use it commercially. You may set it up and run it on your own server
- **The one condition**: when you hand on a copy or a modified version, keep the copyright notice and the permission notice from `LICENSE` with it
- **No warranty**: the author is not liable for damage arising from the use of this software

### Other people's software this uses

| What | Where it is used | Licence |
|---|---|---|
| [pg](https://github.com/brianc/node-postgres) | Server (database connection) | MIT |
| [web-push](https://github.com/web-push-libs/web-push) | Server (sending notifications) | MPL-2.0 |
| [.NET runtime](https://github.com/dotnet/runtime) | Bundled in the PC Agent's exe | MIT |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | The tool that builds the PC Agent's installer | Inno Setup License |

None of these is in this repository (`npm install` and `agent/build.ps1` fetch them).
The screen side (`public/`) uses no outside libraries.
