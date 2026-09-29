using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DeckAgent;

// Once a day, GET <board>/download/agent/version.json and compare. A newer
// version puts 「更新あり（x.y.z）」 in the tray menu; choosing it opens the
// download address in the browser. Nothing is downloaded or run from here —
// the person at the PC does that, through the same installer the board
// hands out (T-028: no code signing, so no silent updates either).
//
//   {"version": "0.2.0", "file": "DeckAgentSetup.exe"}
public sealed class Updates : IDisposable
{
    static readonly TimeSpan Every = TimeSpan.FromHours(24);

    sealed class Manifest
    {
        [JsonPropertyName("version")] public string Version { get; set; } = "";
        [JsonPropertyName("file")] public string File { get; set; } = "";
    }

    readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    readonly CancellationTokenSource stop = new();
    readonly Version running;
    string boardBase = "";

    // (the newer version, where to get it). Raised on a worker thread.
    public event Action<Version, string>? Available;

    public Updates()
    {
        var v = typeof(Updates).Assembly.GetName().Version ?? new Version(0, 0, 0);
        running = new Version(v.Major, v.Minor, Math.Max(v.Build, 0));
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("MultitaskerDeckAgent", running.ToString()));
    }

    public Version Running => running;

    // Called on start and whenever the settings change. An empty board address
    // means there is nowhere to ask, and nothing is asked.
    public void Watch(string boardBaseUrl)
    {
        boardBase = (boardBaseUrl ?? "").Trim().TrimEnd('/');
        _ = Task.Run(() => LoopAsync(boardBase, stop.Token));
    }

    async Task LoopAsync(string forBoard, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && forBoard == boardBase)
        {
            if (forBoard.Length > 0) await CheckAsync(forBoard, ct);
            try { await Task.Delay(Every, ct); } catch (OperationCanceledException) { return; }
        }
    }

    async Task CheckAsync(string board, CancellationToken ct)
    {
        try
        {
            var json = await http.GetStringAsync($"{board}/download/agent/version.json", ct);
            var manifest = JsonSerializer.Deserialize<Manifest>(json);
            if (manifest == null || !Version.TryParse(manifest.Version, out var offered) || string.IsNullOrWhiteSpace(manifest.File))
            {
                Log.Write("update: version.json is not in the expected shape");
                return;
            }
            offered = new Version(offered.Major, offered.Minor, Math.Max(offered.Build, 0));
            // The file name is joined onto the board's download folder, and only
            // a plain name is accepted — the manifest must not be able to point
            // anywhere else.
            var file = Path.GetFileName(manifest.File);
            if (file != manifest.File) { Log.Write("update: file name refused"); return; }
            if (offered > running)
            {
                Log.Write($"update: {offered} is offered (running {running})");
                Available?.Invoke(offered, $"{board}/download/{Uri.EscapeDataString(file)}");
            }
            else
            {
                Log.Write($"update: none (offered {offered}, running {running})");
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception e)
        {
            Log.Write($"update: could not check: {e.GetType().Name}: {e.Message}");
        }
    }

    public void Dispose()
    {
        stop.Cancel();
        http.Dispose();
    }
}
