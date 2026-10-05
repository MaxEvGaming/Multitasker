using System.Text.Json;

namespace DeckAgent;

// `DeckAgent.exe --check-obs '<args>' [--holds N] [--showing true|false]`
//
// What this program would say to OBS for one sealed instruction, without
// saying it to anything. `<args>` is the `args` object exactly as the board
// seals it — `{"op":"scene","arg":"Main"}` as well as
// `{"op":"visible","scene":"Main","source":"Overlay","arg":"toggle"}` — and it
// is read through JobPlain, so this goes through the same door an instruction
// off the wire does.
//
// The answers are made up here: `--holds` is how many sources of that name the
// pretend scene has (1 by default; 2 is the case where a name means two
// things), `--showing` is whether the source is showing at the moment, which
// is what `toggle` turns around. Every request body is printed as it would go
// on the wire.
//
// This is a stub, not OBS. It proves what is composed and what is decided —
// Obs.CarryAsync is the very code the running program uses — and nothing at
// all about a real socket.
public static class ObsCheck
{
    public static int Run(string argsJson, string[] rest)
    {
        var holds = 1;
        var showing = true;
        for (var i = 0; i < rest.Length; i += 1)
        {
            if (rest[i] == "--holds" && i + 1 < rest.Length) int.TryParse(rest[++i], out holds);
            else if (rest[i] == "--showing" && i + 1 < rest.Length) bool.TryParse(rest[++i], out showing);
        }

        Dictionary<string, JsonElement>? args;
        try
        {
            args = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(argsJson);
        }
        catch (Exception e)
        {
            Console.Out.WriteLine($"error cannot read the args: {e.Message}");
            return 1;
        }

        var job = new JobPlain { Id = "check", Kind = "obs", Args = args };
        var instruction = Obs.Instruction.From(job);
        Console.Out.WriteLine($"instruction {instruction}");
        Console.Out.WriteLine($"scene       \"{instruction.Scene}\"");
        Console.Out.WriteLine($"source      \"{instruction.Source}\"");
        Console.Out.WriteLine($"pretend     the scene holds {holds} source(s) of that name, "
            + $"and it is {(showing ? "showing" : "hidden")}");

        var fault = Obs.Fault(instruction);
        if (fault != null)
        {
            Console.Out.WriteLine($"refused before connecting: {fault}");
            Console.Out.WriteLine("verdict failed");
            return 1;
        }

        var link = new Pretend(holds, showing);
        var ok = Obs.CarryAsync(link, instruction, CancellationToken.None).GetAwaiter().GetResult();
        Console.Out.WriteLine($"requests {link.Sent}");
        Console.Out.WriteLine($"verdict {(ok ? "ok" : "failed")}");
        return ok ? 0 : 1;
    }

    // `DeckAgent.exe --check-marker '<args>' [--stream <ms>|off] [--record <ms>|off]
    //                [--lag <ms>] [--write <folder>]`
    //
    // The stream marker (Marker.cs) against the same stub: `--stream` and
    // `--record` are how far in OBS says it is when asked (off = not running;
    // both off by default), `--lag` is how long before the asking the press
    // was (1000 by default). Prints the requests, the line, and the verdict.
    // Writes nothing unless `--write` names a folder, and then only there —
    // never into %APPDATA%. Output is UTF-8, because the line can be Japanese.
    public static int RunMarker(string argsJson, string[] rest)
    {
        long? stream = null, record = null;
        long lag = 1000;
        string? folder = null;
        for (var i = 0; i < rest.Length; i += 1)
        {
            if (rest[i] == "--stream" && i + 1 < rest.Length) stream = Ms(rest[++i]);
            else if (rest[i] == "--record" && i + 1 < rest.Length) record = Ms(rest[++i]);
            else if (rest[i] == "--lag" && i + 1 < rest.Length) long.TryParse(rest[++i], out lag);
            else if (rest[i] == "--write" && i + 1 < rest.Length) folder = rest[++i];
        }

        using var stdout = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
        Dictionary<string, JsonElement>? args;
        try
        {
            args = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(argsJson);
        }
        catch (Exception e)
        {
            stdout.WriteLine($"error cannot read the args: {e.Message}");
            return 1;
        }

        // Whole milliseconds, as `at` is, so `--lag` is exactly the lag.
        var now = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var job = new JobPlain { Id = "check", Kind = "marker", At = now.ToUnixTimeMilliseconds() - lag, Args = args };
        stdout.WriteLine($"pretend     stream {(stream == null ? "off" : $"{stream} ms")}, record {(record == null ? "off" : $"{record} ms")}, pressed {lag} ms before asking");

        var link = new Pretend(1, true) { StreamMs = stream, RecordMs = record };
        var line = Marker.ComposeAsync(link, job.At, job.Arg("label"), job.Arg("lang"), () => now, CancellationToken.None).GetAwaiter().GetResult();
        stdout.WriteLine($"requests {link.Sent}");
        if (line == null)
        {
            stdout.WriteLine("line (none)");
            stdout.WriteLine("verdict failed");
            return 1;
        }
        stdout.WriteLine($"line {line.Replace("\t", "<TAB>")}");
        if (folder != null)
            stdout.WriteLine($"written {Marker.Append(folder, Marker.Pressed(job.At), line)}");
        stdout.WriteLine("verdict ok");
        return 0;
    }

    static long? Ms(string text) => long.TryParse(text, out var n) ? n : null;

    // Writes down what it is asked and answers the way OBS's protocol.md says
    // OBS would: a lookup past the last match of a name is ResourceNotFound
    // (600), and the two requests that ask something answer with the field
    // named in their Response Fields table.
    sealed class Pretend(int holds, bool showing) : Obs.ILink
    {
        public int Sent { get; private set; }

        // For the stream marker: how far into the stream and the recording
        // OBS says it is, in ms; null is not running.
        public long? StreamMs { get; init; }
        public long? RecordMs { get; init; }

        public Task<Obs.Reply> AskAsync(string requestType, object? requestData, CancellationToken ct, bool refusalIsAnAnswer = false)
        {
            Sent += 1;
            var body = requestData == null ? "(none)" : JsonSerializer.Serialize(requestData);
            Console.Out.WriteLine($"request {requestType} {body}");

            var offset = Field(requestData, "searchOffset");
            switch (requestType)
            {
                case "GetSceneItemId":
                {
                    var skip = offset == null ? 0 : int.Parse(offset);
                    if (skip >= holds) return Refused(600, "No scene items were found by that name or offset.");
                    return Answered($"{{\"sceneItemId\": {7 + skip}}}");
                }
                case "GetSceneItemEnabled":
                    return Answered($"{{\"sceneItemEnabled\": {(showing ? "true" : "false")}}}");
                case "GetStreamStatus":
                    return Answered(Status(StreamMs));
                case "GetRecordStatus":
                    return Answered(Status(RecordMs));
                default:
                    return Answered(null);
            }
        }

        // The fields protocol.md lists for both requests that matter here:
        // outputActive, and outputDuration in milliseconds (0 when stopped).
        static string Status(long? ms) =>
            ms == null
                ? "{\"outputActive\": false, \"outputDuration\": 0}"
                : $"{{\"outputActive\": true, \"outputDuration\": {ms.Value}}}";

        static Task<Obs.Reply> Answered(string? responseData) =>
            Task.FromResult(new Obs.Reply(true, 100, "",
                responseData == null ? default : JsonDocument.Parse(responseData).RootElement.Clone()));

        static Task<Obs.Reply> Refused(int code, string comment) =>
            Task.FromResult(new Obs.Reply(false, code, comment, default));

        // The anonymous objects Obs.cs builds are read back the same way OBS
        // would read them: off the JSON, not off the C# type.
        static string? Field(object? requestData, string name)
        {
            if (requestData == null) return null;
            var o = JsonDocument.Parse(JsonSerializer.Serialize(requestData)).RootElement;
            return o.TryGetProperty(name, out var v) ? v.ToString() : null;
        }
    }
}
