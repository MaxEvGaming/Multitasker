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

    // Writes down what it is asked and answers the way OBS's protocol.md says
    // OBS would: a lookup past the last match of a name is ResourceNotFound
    // (600), and the two requests that ask something answer with the field
    // named in their Response Fields table.
    sealed class Pretend(int holds, bool showing) : Obs.ILink
    {
        public int Sent { get; private set; }

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
                default:
                    return Answered(null);
            }
        }

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
