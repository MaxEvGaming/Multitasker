using System.Text.RegularExpressions;

namespace DeckAgent;

// What a `url` instruction may open: http and https, and nothing else. A
// bare host (`example.com`) is taken to mean `https://example.com` — the
// board does the same when the square is saved (public/pair.js), so this is
// only for a square saved before that rule, or by hand. Anything with some
// other scheme (`file:`, a drive letter, a custom handler) is refused: a
// scheme handed to the shell is a way to run things, and the instruction for
// running things is `exec`.
public static class UrlRule
{
    static readonly Regex HasScheme = new(@"^[a-zA-Z][a-zA-Z0-9+.\-]*:", RegexOptions.Compiled);

    // The address to open, or null when it is not one this program opens.
    public static string? Normalize(string? text)
    {
        var s = (text ?? "").Trim();
        if (s.Length == 0) return null;
        if (!HasScheme.IsMatch(s)) s = "https://" + s.TrimStart('/');
        if (!Uri.TryCreate(s, UriKind.Absolute, out var uri)) return null;
        if (!string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return null;
        if (string.IsNullOrEmpty(uri.Host)) return null;
        return s;
    }

    // `DeckAgent.exe --check-url <text>`: the rule on its own, one line out,
    // so test/deck-agent.js can try it without a browser window opening.
    public static int Check(string text)
    {
        var url = Normalize(text);
        Console.Out.WriteLine(url == null ? "refused" : $"open {url}");
        return url == null ? 2 : 0;
    }
}
