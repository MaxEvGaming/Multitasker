using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace DeckAgent;

// Where OBS keeps its websocket server's settings, and what this program takes
// from them.
//
// obs-websocket (5.x, shipped inside OBS since 28) writes them in plain text to
//
//     %APPDATA%\obs-studio\plugin_config\obs-websocket\config.json
//
// Measured on this machine, 2026-09-13 (the password shown by length only):
//
//     {"alerts_enabled": false, "auth_required": true, "first_load": false,
//      "server_enabled": false, "server_password": "<16 chars>",
//      "server_port": 4455}
//
// So the two things a person used to copy out of OBS's Tools → WebSocket Server
// Settings and paste into 「詳細」 — the port and the password — are already on
// the disk of the very machine this program runs on. It reads them, and nobody
// types anything (decided
// 2026-09-13: 「利用者に手でやらせない」).
//
// Read, never written — with one exception, Enable(), which is only ever
// reached by pressing a button that says what it is about to do. Turning
// another program's server on behind its owner's back is not this program's to
// do, and `server_enabled` does not mean anything until OBS is started again
// regardless (measured 2026-09-12: written while OBS was closed, the port was
// open once OBS had started; flipping it while OBS was running did nothing).
public static class ObsConfig
{
    public const string DefaultHost = "127.0.0.1";
    public const int DefaultPort = 4455;

    // Where to look. In order: `--obs-config <path>` on the command line, then
    // MULTITASKER_OBS_CONFIG in the environment, then OBS's own place. The
    // first two exist so the three cases — present and listening, present and
    // off, absent — can be built out of copies during testing without going
    // anywhere near the real file.
    public const string EnvironmentVariable = "MULTITASKER_OBS_CONFIG";
    public static string? Override { get; set; }

    public static string ConfigPath
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(Override)) return Override!;
            var fromEnvironment = Environment.GetEnvironmentVariable(EnvironmentVariable);
            if (!string.IsNullOrWhiteSpace(fromEnvironment)) return fromEnvironment!;
            return System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "obs-studio", "plugin_config", "obs-websocket", "config.json");
        }
    }

    // What was in that file, or why there was nothing to read. `Problem` is
    // null for a file that is simply not there — an ordinary state, since most
    // PCs have no OBS on them — and holds the reason when there is a file that
    // could not be read.
    public sealed record Lookup(
        string Path, bool Found, string? Problem,
        bool Enabled, int Port, string Password, bool AuthRequired)
    {
        public static Lookup Nothing(string path, string? problem) =>
            new(path, false, problem, false, 0, "", false);
    }

    public static Lookup Read()
    {
        var path = ConfigPath;
        try
        {
            if (!File.Exists(path)) return Lookup.Nothing(path, null);
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Lookup.Nothing(path, "the file is not a JSON object");
            return new Lookup(
                path, true, null,
                Flag(root, "server_enabled"),
                Number(root, "server_port"),
                Text(root, "server_password"),
                Flag(root, "auth_required"));
        }
        catch (Exception e)
        {
            return Lookup.Nothing(path, $"{e.GetType().Name}: {e.Message}");
        }
    }

    static bool Flag(JsonElement o, string name) =>
        o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    static int Number(JsonElement o, string name) =>
        o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : 0;

    static string Text(JsonElement o, string name) =>
        o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    // Where an OBS instruction is actually going, and where each part of that
    // came from — the window says both, so a square that does not work is not
    // a mystery.
    public sealed record Endpoint(
        string Host, int Port, string Password, Lookup Found, bool PortTyped, bool PasswordTyped)
    {
        // True when this part is OBS's answer rather than the one in 「詳細」.
        public bool PortFromObs => Found.Found && !PortTyped;
        public bool PasswordFromObs => Found.Found && !PasswordTyped;
        public string Address => $"{Host}:{Port}";
    }

    public static Endpoint Resolve(Settings s) => Resolve(s, Read());

    // 「詳細」 wins over OBS's file, because somebody typed it and this program
    // is not going to quietly undo that (decided 2026-09-13: 「利用者が『詳細』
    // に値を入れていたら、そちらを優先する」).
    //
    // What counts as typed: a password box that is not empty, and a port that
    // is not the 4455 this program ships with. There is no mark on the disk
    // saying which fields a hand went near — agent.json has held obsPort 4455
    // since before any of this — so a field still at its shipped value is
    // taken as one nobody touched. The window says which of the two is in use
    // for each of the port and the password, and the labels in 「詳細」 say
    // what leaving them alone means, so the rule is on show rather than
    // guessed at. The one case it reads wrong is a person who moved OBS off
    // 4455 and then deliberately typed 4455 here; they can see it in the
    // window, and the host box takes any value at all.
    public static Endpoint Resolve(Settings s, Lookup found)
    {
        var host = string.IsNullOrWhiteSpace(s.ObsHost) ? DefaultHost : s.ObsHost.Trim();
        var typedPort = s.ObsPort is > 0 and < 65536 && s.ObsPort != DefaultPort;
        var typedPassword = !string.IsNullOrEmpty(s.ObsPassword);

        var port =
            typedPort ? s.ObsPort
            : found.Found && found.Port is > 0 and < 65536 ? found.Port
            : s.ObsPort is > 0 and < 65536 ? s.ObsPort
            : DefaultPort;
        var password =
            typedPassword ? s.ObsPassword
            : found.Found ? found.Password
            : s.ObsPassword ?? "";

        return new Endpoint(host, port, password, found, typedPort, typedPassword);
    }

    // 「OBS の待ち受けを有効にする」: server_enabled ← true in OBS's own file,
    // everything else in it left as it was. Reached only from the button, and
    // only after the window has said that this writes OBS's settings and that
    // OBS has to be started again for it to take.
    public static (bool ok, string? problem) Enable()
    {
        var path = ConfigPath;
        try
        {
            if (JsonNode.Parse(File.ReadAllText(path)) is not JsonObject o)
                throw new InvalidOperationException("the file is not a JSON object");
            o["server_enabled"] = true;
            // Written beside it and moved over, so a full disk or a crash
            // leaves OBS's settings as they were rather than half-written.
            var temp = path + ".multitasker-tmp";
            File.WriteAllText(temp, o.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
            File.Move(temp, path, overwrite: true);
            Log.Write($"obs: server_enabled set to true in {path} (takes effect when OBS is started again)");
            return (true, null);
        }
        catch (Exception e)
        {
            Log.Write($"obs: could not set server_enabled in {path}: {e.GetType().Name}: {e.Message}");
            return (false, $"{e.GetType().Name}: {e.Message}");
        }
    }

    // Whether OBS is up, for the sentence in front of that button: what is
    // written now takes effect at the next start, so the order that works is
    // close OBS, press, start OBS.
    public static bool ObsIsRunning()
    {
        foreach (var name in new[] { "obs64", "obs32", "obs" })
        {
            try
            {
                var found = Process.GetProcessesByName(name);
                foreach (var p in found) p.Dispose();
                if (found.Length > 0) return true;
            }
            catch { /* a process list that will not come is not an answer either way */ }
        }
        return false;
    }
}
