using System.Text.Json;

namespace DeckAgent;

// `DeckAgent.exe --check-seal <vector.json> [sealed-by-browser]`
//
// The console half of test/deck-seal-agent.js. Opens the pinned vector with
// the same code the running agent uses, re-seals it with the pinned IV to show
// both directions agree, and — if handed one — opens a text the browser's own
// encryptText sealed a moment ago under a random IV. Prints one fact per line
// so the Node side can compare them, and exits 0 only if everything matched.
public static class SealCheck
{
    public static int Run(string vectorPath, string? sealedByBrowser)
    {
        var failures = 0;
        void Say(string line) => Console.Out.WriteLine(line);

        JsonElement vector;
        try
        {
            vector = JsonDocument.Parse(File.ReadAllText(vectorPath)).RootElement;
        }
        catch (Exception e)
        {
            Say($"error cannot read vector: {e.Message}");
            return 1;
        }

        var master = Sealing.MasterFromText(vector.GetProperty("masterKeyBase64url").GetString()!);
        var expectedKeyHex = vector.GetProperty("dataKeyHex").GetString()!;
        var expectedText = vector.GetProperty("plaintext").GetString()!;
        var sealedText = vector.GetProperty("sealed").GetString()!;
        var iv = Sealing.FromBase64Url(vector.GetProperty("ivBase64url").GetString()!);

        var keyHex = Convert.ToHexString(Sealing.DataKeyOf(master)).ToLowerInvariant();
        Say($"dataKey {keyHex}");
        if (keyHex != expectedKeyHex) { failures += 1; Say("mismatch dataKey"); }

        try
        {
            var opened = Sealing.Open(master, sealedText);
            Say($"plaintext {opened}");
            if (opened != expectedText) { failures += 1; Say("mismatch plaintext"); }
        }
        catch (Exception e)
        {
            failures += 1;
            Say($"error cannot open the pinned vector: {e.GetType().Name}: {e.Message}");
        }

        var resealed = Sealing.Seal(master, iv, expectedText);
        Say($"resealed {resealed}");
        if (resealed != sealedText) { failures += 1; Say("mismatch resealed"); }

        if (sealedByBrowser != null)
        {
            try
            {
                Say($"extra {Sealing.Open(master, sealedByBrowser)}");
            }
            catch (Exception e)
            {
                failures += 1;
                Say($"extra-error {e.GetType().Name}: {e.Message}");
            }
        }

        Say(failures == 0 ? "result ok" : $"result {failures} failure(s)");
        return failures == 0 ? 0 : 2;
    }
}
