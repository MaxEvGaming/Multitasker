using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DeckAgent;

public enum AgentState { NotConfigured, Connecting, Reconnecting, Connected, Rejected, Suspended }

// What the tray is showing right now, for anything that has to say the same
// thing somewhere else — at present the settings window's first lines, which
// told the person nothing at all about whether the PC was connected while the
// board next to it said 「接続済み ✓」 (2026-09-12).
// Board is the address the running connection is using, which is not
// necessarily what is typed in the window's 「詳細」 boxes at that moment.
public readonly record struct AgentStatus(AgentState State, string Board);

// One `event: job` block off the stream: {"id","createdAt","sealed"}.
public sealed class JobFrame
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("createdAt")] public string CreatedAt { get; set; } = "";
    [JsonPropertyName("sealed")] public string Sealed { get; set; } = "";
}

// The connection to the board and everything that follows from it, as written
// in docs/DECK_AGENT_PROTOCOL.md: hold GET /agent/<token>/events open, treat
// `: ping` as a heartbeat, come back with a growing pause when it drops, and
// for each job — receipt first, then open, check, carry out, verdict.
public sealed class Worker : IDisposable
{
    static readonly TimeSpan Quiet = TimeSpan.FromSeconds(35);      // ping is every 15 s; 30 s silent = gone
    static readonly TimeSpan Stale = TimeSpan.FromMinutes(5);       // `at` older than this is not carried out
    static readonly TimeSpan Remember = TimeSpan.FromHours(1);      // how long an id counts as seen
    static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(30);
    static readonly TimeSpan RateLimited = TimeSpan.FromSeconds(60);

    readonly Settings settings;
    readonly byte[] master;
    readonly HttpClient stream = new() { Timeout = Timeout.InfiniteTimeSpan };
    readonly HttpClient calls = new() { Timeout = TimeSpan.FromSeconds(10) };
    readonly CancellationTokenSource stop = new();
    readonly ConcurrentDictionary<string, DateTime> seen = new();

    public event Action<AgentState>? StateChanged;
    // The board's word on the guard switch, said at the top of every stream
    // (`event: guard`, docs/DECK_AGENT_PROTOCOL.md §1). The board holds the
    // one that counts; the tray keeps agent.json's copy in step with it.
    public event Action<bool>? GuardTold;
    public AgentState State { get; private set; } = AgentState.Connecting;

    public Worker(Settings settings)
    {
        this.settings = settings;
        master = Sealing.MasterFromText(settings.Key);
        var ua = new ProductInfoHeaderValue("MultitaskerDeckAgent", typeof(Worker).Assembly.GetName().Version?.ToString() ?? "0");
        stream.DefaultRequestHeaders.UserAgent.Add(ua);
        stream.DefaultRequestHeaders.Accept.ParseAdd("text/event-stream");
        calls.DefaultRequestHeaders.UserAgent.Add(ua);
    }

    public void Start() => _ = Task.Run(() => LoopAsync(stop.Token));

    public void Dispose()
    {
        stop.Cancel();
        stream.Dispose();
        calls.Dispose();
    }

    void Set(AgentState state)
    {
        if (State == state) return;
        State = state;
        StateChanged?.Invoke(state);
    }

    string Url(string path) => $"{settings.BoardBase}/agent/{settings.Token}{path}";

    // The name of this machine, sent every time the stream is opened. An account
    // can have several PCs registered, and the board's list needs something to
    // tell one line from another; without this they are all 「pc」, which is what
    // the browser guessed when the token was made. It is a label only — what an
    // instruction is addressed to is the token (docs/DECK_AGENT_PROTOCOL.md §1).
    string EventsUrl() => $"{Url("/events")}?name={Uri.EscapeDataString(Environment.MachineName)}";

    async Task LoopAsync(CancellationToken ct)
    {
        var backoff = TimeSpan.FromSeconds(1);
        var first = true;
        while (!ct.IsCancellationRequested)
        {
            Set(first ? AgentState.Connecting : AgentState.Reconnecting);
            TimeSpan pause;
            try
            {
                var outcome = await ConnectAndReadAsync(ct);
                if (outcome == Outcome.Rejected)
                {
                    Set(AgentState.Rejected);
                    Log.Write("stream: 404 unknown agent — not reconnecting until told to");
                    return;
                }
                // Cut off by a sign-in from a new device, or by the board's
                // stop (docs/DECK_AGENT_PROTOCOL.md §1). Only 「再接続」 at
                // this PC brings it back; trying on our own would be exactly
                // what the cut is there to stop.
                if (outcome == Outcome.Suspended)
                {
                    Set(AgentState.Suspended);
                    Log.Write("stream: 403 suspended — cut off; not reconnecting until 再接続 is pressed here");
                    return;
                }
                pause = outcome == Outcome.RateLimited ? RateLimited : backoff;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                Log.Write($"stream: {e.GetType().Name}: {e.Message}");
                pause = backoff;
            }
            first = false;
            Log.Write($"stream: reconnecting in {pause.TotalSeconds:0}s");
            try { await Task.Delay(pause, ct); } catch (OperationCanceledException) { return; }
            backoff = TimeSpan.FromTicks(Math.Min(backoff.Ticks * 2, MaxBackoff.Ticks));
        }
    }

    enum Outcome { Dropped, Rejected, RateLimited, Suspended }

    async Task<Outcome> ConnectAndReadAsync(CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, EventsUrl());
        using var response = await stream.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode == HttpStatusCode.NotFound) return Outcome.Rejected;
        if (response.StatusCode == HttpStatusCode.Forbidden
            && (await response.Content.ReadAsStringAsync(ct)).Trim() == "suspended") return Outcome.Suspended;
        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            Log.Write("stream: 429 too many — waiting a minute");
            return Outcome.RateLimited;
        }
        if (!response.IsSuccessStatusCode)
        {
            Log.Write($"stream: HTTP {(int)response.StatusCode}");
            return Outcome.Dropped;
        }

        Set(AgentState.Connected);
        Log.Write("stream: connected");

        // Every line resets the quiet timer; the board pings every 15 s, so a
        // read that waits longer than Quiet means the connection is dead
        // without having said so, and it is dropped from this side.
        using var body = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(body, Encoding.UTF8);
        using var quiet = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var eventName = "message";
        var data = new StringBuilder();
        for (; ; )
        {
            quiet.CancelAfter(Quiet);
            string? line;
            try { line = await reader.ReadLineAsync(quiet.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                Log.Write("stream: no ping for 35 s — dropping");
                return Outcome.Dropped;
            }
            if (line == null) { Log.Write("stream: closed by the board"); return Outcome.Dropped; }

            if (line.Length == 0)
            {
                if (data.Length > 0 && eventName == "job") Dispatch(data.ToString(), ct);
                else if (data.Length > 0 && eventName == "guard") TakeGuard(data.ToString());
                eventName = "message";
                data.Clear();
                continue;
            }
            if (line[0] == ':') continue;                              // `: ping`, `: connected`
            var colon = line.IndexOf(':');
            var field = colon < 0 ? line : line[..colon];
            var value = colon < 0 ? "" : line[(colon + 1)..].TrimStart(' ');
            if (field == "event") eventName = value;
            else if (field == "data") { if (data.Length > 0) data.Append('\n'); data.Append(value); }
            // `id`, `retry` and anything unknown are ignored, as the protocol says.
        }
    }

    // `{"on": true}` or `{"on": false}`: what the board holds for this PC.
    // Anything else is left alone — the copy on disk is not worth guessing at.
    void TakeGuard(string json)
    {
        bool on;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("on", out var value)
                || (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False))
            { Log.Write($"guard: unreadable frame: {json}"); return; }
            on = value.GetBoolean();
        }
        catch (Exception e) { Log.Write($"guard: unreadable frame: {e.Message}"); return; }
        Log.Write($"guard: the board says {(on ? "on" : "off")}");
        GuardTold?.Invoke(on);
    }

    void Dispatch(string json, CancellationToken ct)
    {
        JobFrame? frame;
        try { frame = JsonSerializer.Deserialize<JobFrame>(json); }
        catch (Exception e) { Log.Write($"job: unreadable frame: {e.Message}"); return; }
        if (frame == null || string.IsNullOrEmpty(frame.Id) || string.IsNullOrEmpty(frame.Sealed)) return;
        // Off the reading thread at once: the next frame must not wait for
        // this one to run, and the receipt must go out inside five seconds.
        _ = Task.Run(() => HandleAsync(frame, ct), ct);
    }

    async Task HandleAsync(JobFrame frame, CancellationToken ct)
    {
        // Seen already — an id offered again after a reconnect, or a
        // duplicate on the wire. The first delivery is still being carried
        // out (or was), and it is the one that answers; this one is dropped
        // without a word, so its verdict cannot overwrite the real one.
        Forget();
        if (!seen.TryAdd(frame.Id, DateTime.UtcNow))
        {
            Log.Write($"job {frame.Id}: seen before — ignored");
            return;
        }

        Log.Write($"job {frame.Id}: received");
        await PostAsync($"/jobs/{frame.Id}/ack", null, "ack", frame.Id, ct);

        bool ok;
        try
        {
            ok = await CarryOutAsync(frame, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return;
        }
        catch (Exception e)
        {
            Log.Write($"job {frame.Id}: {e.GetType().Name}: {e.Message}");
            ok = false;
        }
        Log.Write($"job {frame.Id}: {(ok ? "ok" : "failed")}");
        await PostAsync($"/jobs/{frame.Id}/result", ok ? "{\"ok\":true}" : "{\"ok\":false}", "result", frame.Id, ct);
    }

    async Task<bool> CarryOutAsync(JobFrame frame, CancellationToken ct)
    {
        string text;
        try { text = Sealing.Open(master, frame.Sealed); }
        catch (Exception e)
        {
            Log.Write($"job {frame.Id}: cannot open ({e.GetType().Name}) — wrong key or damaged text");
            return false;
        }

        JobPlain? job;
        try { job = JsonSerializer.Deserialize<JobPlain>(text); }
        catch (Exception e) { Log.Write($"job {frame.Id}: opened, but not an instruction: {e.Message}"); return false; }
        if (job == null) return false;

        if (job.Id != frame.Id)
        {
            Log.Write($"job {frame.Id}: the id inside ({job.Id}) is not the id outside — refused");
            return false;
        }
        var age = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(job.At);
        if (age > Stale)
        {
            Log.Write($"job {frame.Id}: pressed {age.TotalSeconds:0}s ago — too old, refused");
            return false;
        }
        if (Array.IndexOf(JobPlain.Kinds, job.Kind) < 0)
        {
            Log.Write($"job {frame.Id}: kind '{job.Kind}' is not one this program knows — refused");
            return false;
        }

        Log.Write($"job {frame.Id}: {job.Kind}");
        return await Executor.RunAsync(job, settings, ct);
    }

    async Task PostAsync(string path, string? json, string what, string jobId, CancellationToken ct)
    {
        try
        {
            using var content = json == null ? null : new StringContent(json, Encoding.UTF8, "application/json");
            using var response = await calls.PostAsync(Url(path), content, ct);
            var body = (await response.Content.ReadAsStringAsync(ct)).Trim();
            if (response.IsSuccessStatusCode) Log.Write($"job {jobId}: {what} → {(int)response.StatusCode} {body}");
            else Log.Write($"job {jobId}: {what} refused → {(int)response.StatusCode} {body}");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception e)
        {
            Log.Write($"job {jobId}: {what} did not reach the board: {e.GetType().Name}: {e.Message}");
        }
    }

    // The two things only this program can say to the board, over its own
    // road (docs/DECK_AGENT_PROTOCOL.md §1): ask to be cut off when someone
    // signs in from a new device, and come back after a cut. Neither needs
    // the stream, so neither needs a running Worker — a cut-off PC has none.
    public static Task<bool> SetGuardAsync(Settings settings, bool on) =>
        SayAsync(settings, "/guard", on ? "{\"on\":true}" : "{\"on\":false}", on ? "guard on" : "guard off");

    public static Task<bool> ResumeAsync(Settings settings) => SayAsync(settings, "/resume", null, "resume");

    static async Task<bool> SayAsync(Settings settings, string path, string? json, string what)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            using var content = json == null ? null : new StringContent(json, Encoding.UTF8, "application/json");
            using var response = await client.PostAsync($"{settings.BoardBase}/agent/{settings.Token}{path}", content);
            var body = (await response.Content.ReadAsStringAsync()).Trim();
            Log.Write($"{what}: → {(int)response.StatusCode} {body}");
            return response.IsSuccessStatusCode;
        }
        catch (Exception e)
        {
            Log.Write($"{what}: did not reach the board: {e.GetType().Name}: {e.Message}");
            return false;
        }
    }

    void Forget()
    {
        var cutoff = DateTime.UtcNow - Remember;
        foreach (var (id, at) in seen)
            if (at < cutoff) seen.TryRemove(id, out _);
    }
}
