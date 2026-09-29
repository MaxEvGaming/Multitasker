using System.Globalization;
using Microsoft.Win32;

namespace DeckAgent;

// Every word the tray shows, in one table, in both languages.
//
// Which of the two is settled in this order, first answer wins:
//
//   1. `--lang ja|en` on the command line (Program.cs), which wins over
//      everything — the tests and a person trying the other language use it.
//   2. What was chosen while installing. The installer's own language page is
//      the one place the person has already answered this question, so the
//      answer is kept rather than guessed at again: installer/DeckAgent.iss
//      writes `{language}` (`english` or `japanese`) to
//      HKCU\Software\Multitasker\PC Agent\Language, and it is read back here.
//   3. Windows' display language, for a copy that never went through the
//      installer — a development build, or the exe carried about on its own.
//      Two cultures are asked, because they disagree: CurrentUICulture follows
//      the region and format settings, not the display language. Measured on
//      this machine 2026-09-12, InstalledUICulture=ja-JP but
//      CurrentUICulture=en-GB, so reading only CurrentUICulture put an English
//      window on a Japanese Windows — while the installer, which reads the
//      display language, came up in Japanese. Either being `ja` is Japanese.
//   4. English.
//
// The registry is only read, never written: 2 is the installer's to write and
// the uninstaller's to remove, so a program started without an install leaves
// nothing behind.
public static class Strings
{
    // Where installer/DeckAgent.iss leaves the language chosen on its first
    // page. Kept in step with that file — the two names have to match, and
    // there is nothing else under this key.
    const string InstallKey = @"Software\Multitasker\PC Agent";
    const string LanguageValue = "Language";

    public static bool Japanese { get; set; } = ChosenAtInstall() ?? FromWindows();

    // `english` / `japanese` — the Name of the entry in the installer's
    // [Languages] section. null when there is no value (never installed, or an
    // install from before this was written) or when it says something this
    // program does not know, and then the display language decides instead.
    static bool? ChosenAtInstall()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(InstallKey, writable: false);
            if (key?.GetValue(LanguageValue) is not string name) return null;
            if (name.StartsWith("ja", StringComparison.OrdinalIgnoreCase)) return true;
            if (name.StartsWith("en", StringComparison.OrdinalIgnoreCase)) return false;
            return null;
        }
        catch { return null; }
    }

    static bool FromWindows() =>
        IsJapanese(CultureInfo.InstalledUICulture) || IsJapanese(CultureInfo.CurrentUICulture);

    static bool IsJapanese(CultureInfo culture) =>
        culture.TwoLetterISOLanguageName.Equals("ja", StringComparison.OrdinalIgnoreCase);

    public static string T(string id)
    {
        var table = Japanese ? Ja : En;
        return table.TryGetValue(id, out var s) ? s : (En.TryGetValue(id, out var e) ? e : id);
    }

    static readonly Dictionary<string, string> En = new()
    {
        ["app.name"] = "Multitasker PC Agent",
        ["state.notConfigured"] = "Not connected yet — on the board, open Settings → PC and press ③ “Connect this PC”",
        ["state.connecting"] = "Connecting…",
        ["state.reconnecting"] = "Reconnecting…",
        ["state.connected"] = "Connected",
        ["state.rejected"] = "The board refused this PC — press “Connect this PC” on the board again",
        ["state.badKey"] = "The key in the settings is not a 32-byte base64url key",
        ["state.suspended"] = "Cut off — someone signed in to the board from a new device (or pressed the board's stop). Press Reconnect here to come back",
        ["menu.settings"] = "Settings…",
        ["menu.reconnect"] = "Reconnect",
        ["menu.update"] = "Update available ({0}) — open the download",
        ["menu.exit"] = "Exit",
        ["settings.title"] = "Multitasker PC Agent — Settings",
        ["settings.connectHere"] = "On the board, open Settings → PC and press ③ “Connect this PC”.",
        ["settings.connectHereNote"] = "Press it on this PC, in the browser. This window then closes on its own and the icon next to the clock says it is connected. Leave this program running; there is nothing to type here.",
        // The first lines of the window when the program is already set up:
        // where this PC stands, kept current while the window is open.
        ["settings.stateConnected"] = "✓ Connected",
        ["settings.stateConnectedNote"] = "Squares with a command run on this PC. This window can be closed; leave the program itself running.",
        ["settings.stateConnecting"] = "Connecting…",
        ["settings.stateReconnecting"] = "Not connected — trying again",
        ["settings.stateReconnectingNote"] = "The board is not answering. Check that it is running and can be reached from this PC. This program keeps trying, and this line changes as soon as it connects.",
        ["settings.stateRejected"] = "The board does not know this PC",
        ["settings.stateRejectedNote"] = "On the board, open Settings → PC and press “Connect this PC” again.",
        ["settings.stateBadKeyNote"] = "Fix the key under “Advanced”, or connect again from the board.",
        ["settings.stateSuspended"] = "Cut off: someone signed in from a new device.",
        ["settings.stateSuspendedNote"] = "Press Reconnect on this PC.",
        ["settings.reconnect"] = "Reconnect",
        ["settings.guard"] = "When someone signs in from a new device, cut off every PC on this account",
        ["settings.stateBoard"] = "Board: {0}",
        ["settings.fallback"] = "If that did not work",
        ["settings.fallbackNote"] = "Two cases: the board is open on a phone, so ③ cannot reach this PC, or ③ was pressed and nothing answered. In both the board shows a connect code — copy it there and paste it below. It holds the board address, a token and the key, so nothing else has to be typed.",
        ["settings.code"] = "Connect code",
        ["settings.pasteConnect"] = "Paste and connect",
        ["settings.needCode"] = "Nothing has been filled in yet. On the board, open Settings → PC and press ③ “Connect this PC”. Only if that does not reach this PC does the board show a connect code — paste that into the “Connect code” box.",
        // What was found in OBS's own settings, and where an OBS square is
        // therefore going. Shown whether or not OBS is installed, because the
        // failure it explains — a square that does nothing — looks the same
        // from the outside in every one of these cases.
        ["settings.obsEndpoint"] = "OBS: {0}  (port: {1}, password: {2})",
        ["settings.obsFromObs"] = "from OBS",
        ["settings.obsFromHere"] = "typed here",
        ["settings.obsFromNothing"] = "none",
        ["settings.obsOn"] = "OBS is set to listen. Squares that switch scenes or start recording go to that address.",
        ["settings.obsOff"] = "OBS is not listening, so squares for OBS will not work. OBS's own settings have its WebSocket server switched off.",
        ["settings.obsNoFile"] = "OBS's settings were not found ({0}). If OBS is not installed on this PC, that is all it means. If it is, fill the port and the password in under “Advanced” from OBS's Tools → WebSocket Server Settings.",
        ["settings.obsBadFile"] = "OBS's settings could not be read ({0}): {1}. The port and the password under “Advanced” are used instead.",
        ["settings.obsEnable"] = "Switch OBS's WebSocket server on",
        ["settings.obsEnableAsk"] = "This changes OBS's own settings file:\n\n{0}\n\nIt sets the WebSocket server to on, and leaves everything else in that file alone.\n\nIt does not take effect until OBS is started again. Close OBS, press Yes, then start OBS.{1}\n\nChange it?",
        ["settings.obsEnableRunning"] = "\n\nOBS is running at the moment.",
        ["settings.obsEnabled"] = "Done. Start OBS again and it will listen on {0}.",
        ["settings.obsEnableFailed"] = "OBS's settings could not be changed: {0}",
        ["settings.advanced"] = "Advanced",
        ["settings.advancedNote"] = "What the connect code fills in, for setting up by hand — and the OBS connection. The OBS port and password are read from OBS itself; fill these in only to use something other than what OBS says.",
        ["settings.boardUrl"] = "Board address (https://…)",
        ["settings.token"] = "Agent token (board: Settings → PC → Advanced)",
        ["settings.key"] = "Board key (the same key as notify.json)",
        ["settings.obsHost"] = "OBS WebSocket host",
        ["settings.obsPort"] = "OBS WebSocket port (4455 = whatever OBS says)",
        ["settings.obsPassword"] = "OBS WebSocket password (blank = whatever OBS says)",
        ["settings.timeout"] = "Command timeout (seconds)",
        ["settings.startAtLogon"] = "Start when I sign in to Windows",
        ["settings.show"] = "Show",
        ["settings.ok"] = "Save",
        ["settings.cancel"] = "Cancel",
        ["settings.file"] = "Settings file: {0}",
        ["settings.invalidUrl"] = "The board address must start with http:// or https://",
        ["settings.invalidToken"] = "The token is missing",
        ["settings.invalidKey"] = "The key must be 32 bytes in base64url (as shown in the board's settings)",
        ["settings.invalidPort"] = "The OBS port must be between 1 and 65535",
        ["settings.invalidTimeout"] = "The timeout must be at least 1 second",
        ["settings.saveFailed"] = "Could not save the settings: {0}",
        ["balloon.rejected"] = "The board no longer knows this PC. On the board, open Settings → PC and press “Connect this PC” again (or paste a new connect code here).",
        ["balloon.paired"] = "Connected. Squares with a command now run on this PC.",
        ["balloon.suspended"] = "Cut off: someone signed in to the board from a new device (or pressed the board's stop). Open Settings and press Reconnect to come back.",
        ["pair.refused"] = "This is not a connect code this program can use. The short way is on the board: Settings → PC, press ③ “Connect this PC”. To go on by code, copy the whole of the one the board shows and paste it again.",
        ["pair.notALink"] = "It does not start with multitasker://pair# — only part of it may have been copied.",
        ["pair.badShape"] = "It should have four parts separated by |, and this does not.",
        ["pair.badVersion"] = "It was made for a different version of this program. Update the program from the board's Settings → PC and try again.",
        ["pair.badOrigin"] = "The board address inside it is not an http:// or https:// address.",
        ["pair.badToken"] = "The token inside it is not in the expected form.",
        ["pair.badKey"] = "The key inside it is not a 32-byte key.",
    };

    static readonly Dictionary<string, string> Ja = new()
    {
        ["app.name"] = "Multitasker PC エージェント",
        ["state.notConfigured"] = "まだつながっていません — 盤の 設定 → PC で③「この PC をつなぐ」を押してください",
        ["state.connecting"] = "接続中…",
        ["state.reconnecting"] = "再接続中…",
        ["state.connected"] = "接続済み",
        ["state.rejected"] = "盤にこの PC を拒否されました — 盤で「この PC をつなぐ」をもう一度押してください",
        ["state.badKey"] = "設定の鍵が 32 バイトの base64url ではありません",
        ["state.suspended"] = "切断中 — 盤に新しい場所からログインがありました（または盤で止められました）。ここで「再接続」を押すと戻ります",
        ["menu.settings"] = "設定…",
        ["menu.reconnect"] = "再接続",
        ["menu.update"] = "更新あり（{0}）— ダウンロードを開く",
        ["menu.exit"] = "終了",
        ["settings.title"] = "Multitasker PC エージェント — 設定",
        ["settings.connectHere"] = "盤の 設定 →「PC」を開いて、③「この PC をつなぐ」を押してください。",
        ["settings.connectHereNote"] = "押すのは、この PC のブラウザです。押すとこの画面は自分で閉じ、時計の横のアイコンが「接続済み」になります。このプログラムはそのままにしておいてください。ここに打つものはありません。",
        ["settings.stateConnected"] = "✓ 接続済み",
        ["settings.stateConnectedNote"] = "コマンドを入れた枠を押すと、この PC で動きます。この画面は閉じて構いません（プログラムはそのままにしておいてください）。",
        ["settings.stateConnecting"] = "つないでいます…",
        ["settings.stateReconnecting"] = "つながっていません — つなぎ直しています",
        ["settings.stateReconnectingNote"] = "盤から返事がありません。盤が動いているか、この PC から届くかを確かめてください。届けばひとりでにつながり、ここの表示も変わります。",
        ["settings.stateRejected"] = "盤がこの PC を知りません",
        ["settings.stateRejectedNote"] = "盤の 設定 → PC で「この PC をつなぐ」をもう一度押してください。",
        ["settings.stateBadKeyNote"] = "「詳細」で鍵を直すか、盤でつなぎ直してください。",
        ["settings.stateSuspended"] = "新しい場所からログインがあったので切りました。",
        ["settings.stateSuspendedNote"] = "この PC で「再接続」を押してください。",
        ["settings.reconnect"] = "再接続",
        ["settings.guard"] = "新しい場所からログインがあったら、このアカウントの PC を全部切る",
        ["settings.stateBoard"] = "接続先: {0}",
        ["settings.fallback"] = "うまくいかないとき",
        ["settings.fallbackNote"] = "スマホで盤を開いていて ③ がこの PC に届かない場合と、③ を押しても返事が無かった場合です。どちらでも盤が接続コードを出すので、それをコピーして下の欄に貼ってください。盤のアドレス・トークン・鍵が全部入っているので、ほかに打つものはありません。",
        ["settings.code"] = "接続コード",
        ["settings.pasteConnect"] = "貼り付けて接続",
        ["settings.needCode"] = "まだ何も入っていません。盤の 設定 → PC を開いて、③「この PC をつなぐ」を押してください。それがこの PC に届かないときだけ盤が接続コードを出すので、そのときは「接続コード」の欄に貼ってください。",
        ["settings.obsEndpoint"] = "OBS: {0}（ポート: {1}／パスワード: {2}）",
        ["settings.obsFromObs"] = "OBS から読み取り",
        ["settings.obsFromHere"] = "ここに入れたもの",
        ["settings.obsFromNothing"] = "なし",
        ["settings.obsOn"] = "OBS 側の待ち受けは有効です。シーン切替や録画の枠は、このアドレスに届きます。",
        ["settings.obsOff"] = "OBS 側の待ち受けが切れているので、OBS の枠を押しても動きません（OBS の設定で WebSocket サーバーがオフになっています）。",
        ["settings.obsNoFile"] = "OBS の設定が見つかりませんでした（{0}）。この PC に OBS を入れていないなら、それだけの意味です。入れているのにこれが出る場合は、OBS の ツール → WebSocket サーバー設定 の値を「詳細」のポートとパスワードに入れてください。",
        ["settings.obsBadFile"] = "OBS の設定を読めませんでした（{0}）: {1}。「詳細」のポートとパスワードを使います。",
        ["settings.obsEnable"] = "OBS の待ち受けを有効にする",
        ["settings.obsEnableAsk"] = "OBS 自身の設定ファイルを書き換えます:\n\n{0}\n\nWebSocket サーバーをオンにするだけで、ほかは触りません。\n\nこれは OBS を起動し直すまで効きません。OBS を閉じてから「はい」を押し、そのあと OBS を起動してください。{1}\n\n書き換えますか？",
        ["settings.obsEnableRunning"] = "\n\n※ いま OBS が動いています。",
        ["settings.obsEnabled"] = "書き換えました。OBS を起動し直すと、{0} で待ち受けます。",
        ["settings.obsEnableFailed"] = "OBS の設定を書き換えられませんでした: {0}",
        ["settings.advanced"] = "詳細",
        ["settings.advancedNote"] = "接続コードが埋める欄（手で設定する場合用）と、OBS の接続先です。OBS のポートとパスワードは OBS 自身から読むので、OBS が言うのとは別の値を使いたいときだけ入れてください。",
        ["settings.boardUrl"] = "盤のアドレス（https://…）",
        ["settings.token"] = "エージェントのトークン（盤: 設定 → PC → 詳細）",
        ["settings.key"] = "盤の鍵（notify.json と同じ鍵）",
        ["settings.obsHost"] = "OBS WebSocket のホスト",
        ["settings.obsPort"] = "OBS WebSocket のポート（4455 のままなら OBS に従う）",
        ["settings.obsPassword"] = "OBS WebSocket のパスワード（空欄なら OBS に従う）",
        ["settings.timeout"] = "コマンドの打ち切り（秒）",
        ["settings.startAtLogon"] = "ログオン時に起動",
        ["settings.show"] = "表示",
        ["settings.ok"] = "保存",
        ["settings.cancel"] = "キャンセル",
        ["settings.file"] = "設定ファイル: {0}",
        ["settings.invalidUrl"] = "盤のアドレスは http:// か https:// で始めてください",
        ["settings.invalidToken"] = "トークンが入っていません",
        ["settings.invalidKey"] = "鍵は base64url の 32 バイトです（盤の設定画面に出るもの）",
        ["settings.invalidPort"] = "OBS のポートは 1〜65535 です",
        ["settings.invalidTimeout"] = "打ち切りは 1 秒以上にしてください",
        ["settings.saveFailed"] = "設定を保存できませんでした: {0}",
        ["balloon.rejected"] = "盤がこの PC を知りません。盤の設定「PC」で「この PC をつなぐ」をもう一度押してください（または新しい接続コードをここに貼ってください）。",
        ["balloon.paired"] = "接続しました。コマンドを入れた枠は、この PC で動きます。",
        ["balloon.suspended"] = "切断しました。盤に新しい場所からログインがありました（または盤で止められました）。設定を開いて「再接続」を押すと戻ります。",
        ["pair.refused"] = "この接続コードは、このプログラムでは読めません。早いのは盤の 設定 → PC で③「この PC をつなぐ」を押すことです。コードで進めるなら、盤が出したものを全部コピーして貼り直してください。",
        ["pair.notALink"] = "multitasker://pair# で始まっていません。一部だけコピーされたのかもしれません。",
        ["pair.badShape"] = "| で区切られた 4 つの部分があるはずですが、そうなっていません。",
        ["pair.badVersion"] = "このプログラムとは別の版向けのコードです。盤の 設定 → PC からプログラムを更新して、やり直してください。",
        ["pair.badOrigin"] = "中の盤のアドレスが http:// でも https:// でもありません。",
        ["pair.badToken"] = "中のトークンの形が違います。",
        ["pair.badKey"] = "中の鍵が 32 バイトの鍵ではありません。",
    };
}
