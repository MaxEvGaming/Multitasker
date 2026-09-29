using System.Text.RegularExpressions;

namespace DeckAgent;

// multitasker://pair#v1|<origin>|<token>|<key>
//
// The one string the board hands this program: everything agent.json needs,
// in the order it needs it. It arrives either as the argument Windows passes
// when the browser opens a `multitasker://` link (installer/DeckAgent.iss,
// Protocol.cs), or pasted into the settings window as the 「接続コード」 —
// the same string both ways, except that Windows, when it hands a custom-
// scheme link to its handler, rewrites `multitasker://pair#…` into
// `multitasker://pair/#…` (a `/` before the `#`; measured 2026-09-09). So
// both `pair#` and `pair/#` are accepted here — one `/` at most, nothing
// else between `pair` and `#`. The board's own copy of this rule is
// public/pair.js (`pairLink` / `parsePairLink`), and the exact format is in
// docs/DECK_AGENT_PROTOCOL.md 「接続コード / pair link」.
//
// Refused, with a reason that names the part: not our scheme, not v1, not
// four parts, an origin that is not http(s)://host[:port], a token that is
// not base64url, a key that is not 32 bytes. Nothing here is interpreted
// beyond that — the token and the key are handed to the board and the
// sealing code as they are.
public sealed record PairLink(string Origin, string Token, string Key)
{
    public const string Prefix = "multitasker://pair#";
    // What the OS actually delivers (see above).
    public const string PrefixSlash = "multitasker://pair/#";
    public const string Version = "v1";

    static readonly Regex OriginShape = new(@"^https?://[^/\s|]+$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex TokenShape = new(@"^[A-Za-z0-9_-]{16,}$", RegexOptions.Compiled);

    // Whether an argument is meant for this at all — `DeckAgent.exe --config x`
    // is not, `DeckAgent.exe multitasker://…` is.
    public static bool Looks(string? text) =>
        text != null && text.TrimStart().StartsWith("multitasker:", StringComparison.OrdinalIgnoreCase);

    // Either a link or the key (Strings.cs) of the sentence saying what was
    // wrong with it. The sentence is for the person at the PC, who pasted
    // something and is owed a reason in plain words rather than a stack trace.
    public static (PairLink? link, string reason) Parse(string? text)
    {
        var s = (text ?? "").Trim();
        string body;
        if (s.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)) body = s[Prefix.Length..];
        else if (s.StartsWith(PrefixSlash, StringComparison.OrdinalIgnoreCase)) body = s[PrefixSlash.Length..];
        else return (null, "pair.notALink");
        // A browser may percent-encode the fragment on its way to the OS; none
        // of the parts can contain `%`, so undoing that is always safe.
        try { body = Uri.UnescapeDataString(body); } catch { return (null, "pair.badShape"); }
        var parts = body.Split('|');
        if (parts.Length != 4) return (null, "pair.badShape");
        if (parts[0] != Version) return (null, "pair.badVersion");
        var origin = parts[1].Trim();
        var token = parts[2].Trim();
        var key = parts[3].Trim();
        if (!OriginShape.IsMatch(origin) || !Uri.TryCreate(origin, UriKind.Absolute, out var uri)
            || string.IsNullOrEmpty(uri.Host)) return (null, "pair.badOrigin");
        if (!TokenShape.IsMatch(token)) return (null, "pair.badToken");
        try { Sealing.MasterFromText(key); } catch { return (null, "pair.badKey"); }
        return (new PairLink(origin.TrimEnd('/'), token, key), "");
    }

    // `DeckAgent.exe --check-pair <text>`: the parser on its own, one line
    // out, for test/deck-agent.js to try the shapes that must be refused
    // without a message box appearing.
    public static int Check(string text)
    {
        var (link, reason) = Parse(text);
        if (link == null) { Console.Out.WriteLine($"error {reason}"); return 2; }
        Console.Out.WriteLine($"ok origin={link.Origin} token={link.Token} keyBytes={Sealing.FromBase64Url(link.Key).Length}");
        return 0;
    }
}
