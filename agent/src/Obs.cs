using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace DeckAgent;

// OBS over obs-websocket 5.x (obsproject/obs-websocket, docs/generated/protocol.md),
// with nothing but the base library: ClientWebSocket for the socket, SHA256 for
// the handshake. One connection per instruction — open, identify, ask, close —
// because an instruction arrives a few times an hour and a socket held open
// across OBS restarts is a thing that has to be minded.
//
//   op 0 Hello         ← {rpcVersion, authentication?: {challenge, salt}}
//   op 1 Identify      → {rpcVersion: 1, authentication?, eventSubscriptions: 0}
//   op 2 Identified    ←
//   op 6 Request       → {requestType, requestId, requestData?}
//   op 7 RequestResponse ← {requestType, requestId, requestStatus: {result, code, comment?}, responseData?}
//
// Authentication: base64(sha256(password + salt)) → secret; base64(sha256(secret + challenge)).
// A wrong password is answered by the server closing with 4009.
//
// The port and the password are OBS's own, read off this machine's disk by
// ObsConfig.cs rather than copied out of OBS by hand; 「詳細」 is now an
// override for the cases that reading cannot cover.
//
// Most instructions are one request and done. Showing or hiding a source is
// not — a scene item is addressed by a number, and the board only knows the
// name — so the asking is behind ILink and the deciding is in CarryAsync,
// which is the same code whether the answers come off a socket or out of
// `--check-obs` (ObsCheck.cs).
public static class Obs
{
    const string SubProtocol = "obswebsocket.json";

    // What the board sealed. `Op` and `Arg` are the two the board has always
    // sent; `Scene` and `Source` are empty for every instruction saved before
    // 2026-09-13 and for every action other than `visible`
    // (docs/DECK_AGENT_PROTOCOL.md §3).
    public sealed record Instruction(string Op, string Arg, string Scene, string Source)
    {
        public static Instruction From(JobPlain job) =>
            new(job.Arg("op"), job.Arg("arg"), job.Arg("scene"), job.Arg("source"));

        public override string ToString() =>
            Op == "visible" ? $"{Op}/{Arg} {Scene} -> {Source}" : $"{Op}/{Arg}";
    }

    // One answer to one request. `Data` is the `responseData` object, which is
    // absent on the requests that only do something (ValueKind.Undefined then).
    public sealed record Reply(bool Ok, int Code, string Comment, JsonElement Data)
    {
        public int Number(string name) =>
            Data.ValueKind == JsonValueKind.Object && Data.TryGetProperty(name, out var v) && v.TryGetInt32(out var n) ? n : -1;

        public bool? Flag(string name) =>
            Data.ValueKind == JsonValueKind.Object && Data.TryGetProperty(name, out var v)
                ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => (bool?)null }
                : null;
    }

    // Somewhere to send requests. The real one is a socket to OBS; the test
    // one writes the bodies down and answers out of a script, so what this
    // program composes can be read without OBS being switched on.
    // `refusalIsAnAnswer` is for the one place a "no" is ordinary rather than
    // a fault — asking whether a second source of the same name exists — so
    // the log does not carry a line that reads like a failure every time a
    // source is shown.
    public interface ILink
    {
        Task<Reply> AskAsync(string requestType, object? requestData, CancellationToken ct, bool refusalIsAnAnswer = false);
    }

    public static async Task<bool> RunAsync(Settings s, Instruction i, TimeSpan timeout, CancellationToken ct)
    {
        // Anything that cannot be carried out is refused before a socket is
        // opened: a connection refused for a typo reads like OBS being off.
        var wrong = Fault(i);
        if (wrong != null)
        {
            Log.Write($"obs: {wrong} ({i})");
            return false;
        }

        return await WithLinkAsync(s, timeout, ct, (link, token) => CarryAsync(link, i, token));
    }

    // An identified connection to OBS for as long as `use` runs, then closed.
    // Shared by the instructions above and by the stream marker (Marker.cs),
    // which only asks. A refused connection, a wrong password or the timeout
    // is thrown, as it always was.
    public static async Task<T> WithLinkAsync<T>(Settings s, TimeSpan timeout, CancellationToken ct,
        Func<ILink, CancellationToken, Task<T>> use)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(timeout);
        var token = deadline.Token;

        using var ws = new ClientWebSocket();
        ws.Options.AddSubProtocol(SubProtocol);

        // Where to go and what to say when we get there: OBS's own settings
        // file, unless somebody typed something into 「詳細」 (ObsConfig.cs).
        var obs = ObsConfig.Resolve(s);
        Log.Write($"obs: {obs.Address} (port: {(obs.PortFromObs ? "OBS's settings" : "settings window")}, "
            + $"password: {(obs.PasswordFromObs ? "OBS's settings" : obs.Password.Length > 0 ? "settings window" : "none")})");
        // Said before the attempt rather than after it, because the failure
        // this produces is a bare connection refusal with nothing in it about
        // why the port is shut.
        if (obs.Found.Found && !obs.Found.Enabled)
            Log.Write("obs: OBS's own settings have the websocket server switched off (server_enabled false) — "
                + "turn it on in OBS's Tools → WebSocket Server Settings, or in this program's settings window, and start OBS again");

        await ws.ConnectAsync(new Uri($"ws://{obs.Host}:{obs.Port}/"), token);

        var hello = await ReceiveAsync(ws, token);
        if (Op(hello) != 0) throw new InvalidOperationException("expected Hello");
        var identify = new Dictionary<string, object?> { ["rpcVersion"] = 1, ["eventSubscriptions"] = 0 };
        if (hello.GetProperty("d").TryGetProperty("authentication", out var auth))
        {
            var challenge = auth.GetProperty("challenge").GetString() ?? "";
            var salt = auth.GetProperty("salt").GetString() ?? "";
            identify["authentication"] = Answer(obs.Password ?? "", salt, challenge);
        }
        await SendAsync(ws, new { op = 1, d = identify }, token);

        var identified = await ReceiveAsync(ws, token);
        if (Op(identified) != 2) throw new InvalidOperationException("expected Identified");

        try
        {
            return await use(new SocketLink(ws), token);
        }
        finally
        {
            try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); } catch { }
        }
    }

    // The instruction, as requests. Everything but `visible` is one request
    // and its verdict; `visible` is the name→number lookup, the check that
    // the name means one thing, the present state if it is being swapped
    // over, and then the setting.
    public static async Task<bool> CarryAsync(ILink link, Instruction i, CancellationToken ct)
    {
        if (i.Op != "visible")
        {
            var (requestType, requestData) = Translate(i.Op, i.Arg);
            if (requestType == null) { Log.Write($"obs: unknown op/arg: {i}"); return false; }
            return (await link.AskAsync(requestType, requestData, ct)).Ok;
        }

        // A scene item is addressed by its number, and the board holds names,
        // so the number is looked up every time — it is not stable across OBS
        // restarts or a source being removed and put back.
        var found = await link.AskAsync("GetSceneItemId", new { sceneName = i.Scene, sourceName = i.Source }, ct);
        if (!found.Ok)
        {
            Log.Write($"obs: no source named \"{i.Source}\" in scene \"{i.Scene}\" ({found.Code}) {found.Comment}");
            return false;
        }
        var sceneItemId = found.Number("sceneItemId");
        if (sceneItemId < 0) { Log.Write("obs: GetSceneItemId answered without a sceneItemId"); return false; }

        // OBS lets one scene hold two sources of the same name, and answers
        // the lookup above with whichever it finds first — so a square could
        // quietly move the wrong one. `searchOffset` (protocol.md,
        // GetSceneItemId: ">= 0 means first forward", default 0) asks for a
        // second match: if there is one, the name does not identify anything
        // and nothing is touched.
        var second = await link.AskAsync("GetSceneItemId",
            new { sceneName = i.Scene, sourceName = i.Source, searchOffset = 1 }, ct, refusalIsAnAnswer: true);
        if (second.Ok)
        {
            Log.Write($"obs: scene \"{i.Scene}\" holds more than one source named \"{i.Source}\" "
                + $"(items {sceneItemId} and {second.Number("sceneItemId")}) — refusing, because the name does not say which. "
                + "Rename one of them in OBS.");
            return false;
        }

        bool wanted;
        if (i.Arg == "toggle")
        {
            var now = await link.AskAsync("GetSceneItemEnabled", new { sceneName = i.Scene, sceneItemId }, ct);
            var enabled = now.Ok ? now.Flag("sceneItemEnabled") : null;
            if (enabled == null)
            {
                Log.Write($"obs: could not read whether \"{i.Source}\" is showing ({now.Code}) {now.Comment}");
                return false;
            }
            wanted = !enabled.Value;
        }
        else wanted = i.Arg == "show";

        var set = await link.AskAsync("SetSceneItemEnabled",
            new { sceneName = i.Scene, sceneItemId, sceneItemEnabled = wanted }, ct);
        if (!set.Ok) Log.Write($"obs: SetSceneItemEnabled refused ({set.Code}) {set.Comment}");
        return set.Ok;
    }

    // Why this instruction cannot be carried out at all, or null if it can.
    // Checked before connecting, so a name left blank in the editor does not
    // come back as "OBS is not listening".
    public static string? Fault(Instruction i)
    {
        if (i.Op == "visible")
        {
            if (string.IsNullOrWhiteSpace(i.Scene)) return "no scene name";
            if (string.IsNullOrWhiteSpace(i.Source)) return "no source name";
            if (i.Arg is not ("show" or "hide" or "toggle")) return "show, hide or toggle is the choice";
            return null;
        }
        return Translate(i.Op, i.Arg).type == null ? "unknown op/arg" : null;
    }

    // The board's {op, arg} → obs-websocket's {requestType, requestData}, for
    // the four actions that are one request. `visible` is not here: it is a
    // sequence, and lives in CarryAsync.
    static (string? type, object? data) Translate(string op, string arg)
    {
        var a = (arg ?? "").Trim();
        switch (op)
        {
            case "scene":
                return string.IsNullOrEmpty(a) ? (null, null) : ("SetCurrentProgramScene", new { sceneName = a });
            case "record":
                return a.ToLowerInvariant() switch
                {
                    "start" => ("StartRecord", null),
                    "stop" => ("StopRecord", null),
                    "toggle" => ("ToggleRecord", null),
                    _ => (null, null),
                };
            case "stream":
                return a.ToLowerInvariant() switch
                {
                    "start" => ("StartStream", null),
                    "stop" => ("StopStream", null),
                    "toggle" => ("ToggleStream", null),
                    _ => (null, null),
                };
            case "mute":
                return string.IsNullOrEmpty(a) ? (null, null) : ("ToggleInputMute", new { inputName = a });
            default:
                return (null, null);
        }
    }

    public static string Answer(string password, string salt, string challenge)
    {
        var secret = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(password + salt)));
        return Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(secret + challenge)));
    }

    // An identified connection, asked one thing at a time.
    sealed class SocketLink(ClientWebSocket ws) : ILink
    {
        public async Task<Reply> AskAsync(string requestType, object? requestData, CancellationToken ct, bool refusalIsAnAnswer = false)
        {
            var requestId = Guid.NewGuid().ToString("N");
            await SendAsync(ws, new { op = 6, d = new { requestType, requestId, requestData } }, ct);

            // Events are not subscribed to, so the next message is the answer —
            // but read until the matching id anyway, in case that ever changes.
            for (; ; )
            {
                var message = await ReceiveAsync(ws, ct);
                if (Op(message) != 7) continue;
                var d = message.GetProperty("d");
                if (d.GetProperty("requestId").GetString() != requestId) continue;
                var status = d.GetProperty("requestStatus");
                var ok = status.GetProperty("result").GetBoolean();
                var code = status.TryGetProperty("code", out var c) ? c.GetInt32() : -1;
                var comment = (status.TryGetProperty("comment", out var m) ? m.GetString() : "") ?? "";
                if (!ok && !refusalIsAnAnswer) Log.Write($"obs: {requestType} refused ({code}) {comment}");
                var data = d.TryGetProperty("responseData", out var r) ? r.Clone() : default;
                return new Reply(ok, code, comment, data);
            }
        }
    }

    static int Op(JsonElement message) => message.TryGetProperty("op", out var op) ? op.GetInt32() : -1;

    static Task SendAsync(ClientWebSocket ws, object message, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        return ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
    }

    static async Task<JsonElement> ReceiveAsync(ClientWebSocket ws, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        for (; ; )
        {
            var result = await ws.ReceiveAsync(chunk, ct);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new InvalidOperationException($"OBS closed the socket ({(int?)ws.CloseStatus} {ws.CloseStatusDescription})");
            buffer.Write(chunk, 0, result.Count);
            if (result.EndOfMessage) break;
        }
        return JsonDocument.Parse(buffer.ToArray()).RootElement.Clone();
    }
}
