using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DeckAgent;

// The opened instruction: {"id","at","kind","args"}, exactly as the browser
// sealed it (docs/DECK_AGENT_PROTOCOL.md 「`kind` と `args`」).
public sealed class JobPlain
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("at")] public long At { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("args")] public Dictionary<string, JsonElement>? Args { get; set; }

    // `exec` (one line handed to cmd.exe) was stopped on 2026-09-14: it ran
    // anything, with nothing to hold it back. It is refused like any kind this
    // program does not know (docs/DECK_AGENT_PROTOCOL.md §3).
    // `marker` (2026-10-05) asks OBS how far into the stream and the
    // recording the press came and writes it to a file here (Marker.cs).
    public static readonly string[] Kinds = { "open", "url", "hotkey", "text", "obs", "marker" };

    public string Arg(string name)
    {
        if (Args != null && Args.TryGetValue(name, out var v) && v.ValueKind == JsonValueKind.String)
            return v.GetString() ?? "";
        return "";
    }
}

// Carries one instruction out and says whether it worked. That verdict is the
// whole of what leaves this machine — no output, no error text (T-017). What
// went wrong is written to the local log for whoever is sitting at the PC.
public static class Executor
{
    public static async Task<bool> RunAsync(JobPlain job, Settings settings, CancellationToken ct)
    {
        try
        {
            switch (job.Kind)
            {
                case "open": return Open(job.Arg("target"));
                case "url": return Url(job.Arg("url"));
                case "hotkey": return Hotkeys.Send(job.Arg("keys"));
                // `mode` is `paced` or `burst` (T-087); missing, or anything
                // else, is paced — what every square did before there was
                // a choice (docs/DECK_AGENT_PROTOCOL.md §3 `text`).
                case "text": return TypeText(job.Arg("key"), job.Arg("text"), paced: job.Arg("mode") != "burst");
                case "obs": return await Obs.RunAsync(settings, Obs.Instruction.From(job), settings.Timeout, ct);
                case "marker": return await Marker.RunAsync(settings, job, settings.Timeout, ct);
                default:
                    Log.Write($"job {job.Id}: unknown kind");
                    return false;
            }
        }
        catch (Exception e)
        {
            Log.Write($"job {job.Id}: {job.Kind} failed: {e.GetType().Name}: {e.Message}");
            return false;
        }
    }

    // A key to open the game's chat, the line, then Enter — and with the key
    // left blank, just the line and Enter, which is the same action pointed at
    // something that is not a game.
    //
    // Where it lands is not chosen here: the letters go to the window that is
    // in front of this PC at that moment (T-047 = C). After the chat key there
    // is one short wait (ChatKeySettle) before the line, and nothing before
    // Enter. Whether the letters themselves are spaced apart (`paced`, T-049
    // = A) or sent in one go (`burst`) is the square's choice (T-087); what a
    // window too slow to keep up does with the second is measured in
    // docs/DECK_AGENT_PROTOCOL.md §3 `text`. The wait after the chat key is
    // the same for both.
    //
    // This takes as long as the line: about 1.2 s for 40 characters. It is not
    // on the window's thread — Worker hands each instruction to the pool — and
    // the board is told the instruction arrived before any of this starts, so
    // the only clock that matters is its 60 s wait for the verdict.

    // How long the line waits after the chat key. A game opens its chat box on
    // its next frame, not on the key-up: a letter that arrives before the box
    // is open goes to the game instead of the box and is dropped. Minecraft
    // lost the leading `/` of every command this way (2026-09-14, T-084 = A).
    // Fixed, not measured per game, and only when a key was pressed — with no
    // key there is nothing to wait for.
    static readonly TimeSpan ChatKeySettle = TimeSpan.FromMilliseconds(200);

    static bool TypeText(string key, string text, bool paced)
    {
        if (string.IsNullOrEmpty(text)) return false;
        if (!string.IsNullOrWhiteSpace(key))
        {
            if (!Hotkeys.Send(key)) return false;
            Thread.Sleep(ChatKeySettle);
        }
        if (!Hotkeys.Type(text, paced)) return false;
        return Hotkeys.Send("enter");
    }

    // ShellExecute on a path: a document opens in its program, a program runs,
    // a folder opens in Explorer. "It opened" is the verdict; what happens in
    // the window afterwards is not this program's to know.
    static bool Open(string target)
    {
        if (string.IsNullOrWhiteSpace(target)) return false;
        using var p = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        return true;
    }

    // http and https, and a bare host is taken as https (UrlRule.cs). A
    // `file:` or a custom scheme handed to the shell is a way to run things,
    // and running things is not what this instruction is for.
    static bool Url(string url)
    {
        var address = UrlRule.Normalize(url);
        if (address == null)
        {
            Log.Write("url: refused — only http:// and https:// are opened");
            return false;
        }
        using var p = Process.Start(new ProcessStartInfo(address) { UseShellExecute = true });
        return true;
    }
}
