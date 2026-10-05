using System.Globalization;
using System.Text;
using System.Text.Json;

namespace DeckAgent;

// 配信マーカー / stream marker (2026-10-05, T-495 = A, T-496 = A, T-498 = A).
//
// Pressed without a word while streaming: this asks OBS how far into the
// stream and the recording it is, works back to the moment of the press, and
// adds one line to a file of the day on this PC. Nothing goes back to the
// board but ok / not ok, and OBS is only asked — no chapter is written into
// the recording (T-496 = A).
//
//   %APPDATA%\Multitasker\markers\<yyyy-MM-dd>.txt     UTF-8, one line a press
//   2026-10-05 21:14:03<TAB>配信 01:23:45<TAB>録画 00:58:12<TAB>神プレイ     (lang "ja")
//
// The time and the file's date are the moment of the press (`at`) in this
// PC's time zone. Whichever of the two is not running is written `配信 -` /
// `録画 -`; an empty label leaves the last column empty. Neither running is
// a failure (T-498 = A), and so is OBS not answering.
//
// The two words are in the board's language at the press, which the browser
// puts in the instruction as `args.lang` (2026-10-05, T-503 / T-505 = A):
// "ja" writes 配信 / 録画, and anything else — "en", none, or a value nobody
// knows — writes Stream / Recording. English is the fallback in every case.
//
//   2026-10-05 21:14:03<TAB>Stream 01:23:45<TAB>Recording -<TAB>best play
//
// OBS answers a second or so after the press, so `outputDuration` (ms, in both
// GetStreamStatus and GetRecordStatus — obs-websocket protocol.md, v5.0.0) is
// taken back by how long ago the press was: the moment the answer arrived,
// minus `at`. Below zero is zero. `at` is the pressing device's clock and the
// moment the answer arrived is this PC's, so a gap between the two clocks
// lands in the figure.
public static class Marker
{
    public static string Folder => Path.Combine(Settings.DefaultDirectory, "markers");

    // One output, as of the press. Elapsed is meaningless when not Active.
    public sealed record Output(bool Active, TimeSpan Elapsed);

    static readonly object Gate = new();

    public static async Task<bool> RunAsync(Settings s, JobPlain job, TimeSpan timeout, CancellationToken ct)
    {
        var ok = false;
        try
        {
            ok = await Obs.WithLinkAsync(s, timeout, ct, async (link, token) =>
            {
                var line = await ComposeAsync(link, job.At, job.Arg("label"), job.Arg("lang"), () => DateTimeOffset.UtcNow, token);
                if (line == null) return false;
                Append(Folder, Pressed(job.At), line);
                return true;
            });
        }
        catch
        {
            // Not written to the log beyond the verdict: the log carries no
            // part of an instruction, and the label is one (Log.cs).
            ok = false;
        }
        Log.Write(ok ? "marker ok" : "marker failed");
        return ok;
    }

    // The line for one press, or null when it cannot be written: OBS refused
    // a question or answered in a shape that cannot be read, or neither the
    // stream nor the recording is running. `now` is read as each answer
    // arrives.
    public static async Task<string?> ComposeAsync(Obs.ILink link, long atMs, string label, string lang,
        Func<DateTimeOffset> now, CancellationToken ct)
    {
        var stream = await ReadAsync(link, "GetStreamStatus", atMs, now, ct);
        if (stream == null) return null;
        var record = await ReadAsync(link, "GetRecordStatus", atMs, now, ct);
        if (record == null) return null;
        if (!stream.Active && !record.Active) return null;
        return Line(Pressed(atMs), stream, record, label, lang);
    }

    static async Task<Output?> ReadAsync(Obs.ILink link, string requestType, long atMs,
        Func<DateTimeOffset> now, CancellationToken ct)
    {
        var reply = await link.AskAsync(requestType, null, ct);
        var arrived = now();
        if (!reply.Ok) return null;
        var active = reply.Flag("outputActive");
        if (active == null) return null;
        if (active == false) return new Output(false, TimeSpan.Zero);
        if (reply.Data.ValueKind != JsonValueKind.Object
            || !reply.Data.TryGetProperty("outputDuration", out var d)
            || !d.TryGetDouble(out var durationMs)) return null;
        var since = (arrived - DateTimeOffset.FromUnixTimeMilliseconds(atMs)).TotalMilliseconds;
        var atPress = Math.Max(0, durationMs - since);
        return new Output(true, TimeSpan.FromMilliseconds(atPress));
    }

    public static DateTimeOffset Pressed(long atMs) => DateTimeOffset.FromUnixTimeMilliseconds(atMs).ToLocalTime();

    public static string Line(DateTimeOffset pressed, Output stream, Output record, string label, string lang)
    {
        var (streamWord, recordWord) = Words(lang);
        return string.Join('\t',
            pressed.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
            streamWord + " " + Clock(stream),
            recordWord + " " + Clock(record),
            OneLine(label));
    }

    // Japanese only for exactly "ja"; English for everything else, a missing
    // or unknown `lang` included.
    static (string Stream, string Record) Words(string lang) =>
        lang == "ja" ? ("配信", "録画") : ("Stream", "Recording");

    static string Clock(Output o)
    {
        if (!o.Active) return "-";
        var t = o.Elapsed;
        return string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}", (long)t.TotalHours, t.Minutes, t.Seconds);
    }

    // A tab or a line break inside the label would split the press over two
    // columns or two lines; each control character becomes a space.
    static string OneLine(string label)
    {
        var b = new StringBuilder(label.Length);
        foreach (var c in label) b.Append(char.IsControl(c) ? ' ' : c);
        return b.ToString();
    }

    public static string Append(string folder, DateTimeOffset pressed, string line)
    {
        var path = Path.Combine(folder, pressed.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".txt");
        lock (Gate)
        {
            Directory.CreateDirectory(folder);
            File.AppendAllText(path, line + Environment.NewLine, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        return path;
    }
}
