using System.Text.Json;
using System.Text.Json.Serialization;

namespace DeckAgent;

// %APPDATA%\Multitasker\agent.json. The same three things the webhook's
// notify.json holds, plus what OBS needs and how long a command may run.
//
//   {
//     "boardUrl": "https://board.example",
//     "token": "<from the board's settings, PC → register>",
//     "key": "<the board's key, base64url — the same value as notify.json's key>",
//     "obsHost": "127.0.0.1", "obsPort": 4455, "obsPassword": "",
//     "timeoutSeconds": 60,
//     "guard": true
//   }
//
// `guard` is this program's copy of the switch it set on the board (POST
// /agent/<token>/guard): cut every PC of the account off when someone signs
// in from a new device. The board holds the one that counts; this is what the
// settings window shows, and it follows the board: the board says its value
// at the top of every stream (`event: guard`) and the tray writes it here
// when it differs (TrayApp.TakeGuard, T-085).
//
// On unless switched off (T-082): a new file, and a file from before the
// switch existed, both read as on — the board makes a new registration
// the same way (sql/014_guard_default_on.sql).
public sealed class Settings
{
    public string BoardUrl { get; set; } = "";
    public string Token { get; set; } = "";
    public string Key { get; set; } = "";
    public string ObsHost { get; set; } = "127.0.0.1";
    public int ObsPort { get; set; } = 4455;
    public string ObsPassword { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 60;
    public bool Guard { get; set; } = true;

    public static string DefaultDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Multitasker");

    public static string DefaultPath => Path.Combine(DefaultDirectory, "agent.json");

    [JsonIgnore]
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(BoardUrl) && !string.IsNullOrWhiteSpace(Token) && !string.IsNullOrWhiteSpace(Key);

    [JsonIgnore]
    public TimeSpan Timeout => TimeSpan.FromSeconds(TimeoutSeconds > 0 ? TimeoutSeconds : 60);

    // The board's address without a trailing slash, so paths can be appended.
    [JsonIgnore]
    public string BoardBase => BoardUrl.Trim().TrimEnd('/');

    static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    // A missing or unreadable file is an empty configuration, not an error:
    // the tray icon says "not configured" and the settings window fills it in.
    public static Settings Load(string path)
    {
        try
        {
            if (!File.Exists(path)) return new Settings();
            return JsonSerializer.Deserialize<Settings>(File.ReadAllText(path), Json) ?? new Settings();
        }
        catch (Exception e)
        {
            Log.Write($"settings: could not read {path}: {e.Message}");
            return new Settings();
        }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this, Json) + Environment.NewLine);
    }

    public Settings Clone() => (Settings)MemberwiseClone();
}
