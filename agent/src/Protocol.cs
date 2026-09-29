using Microsoft.Win32;

namespace DeckAgent;

// The `multitasker://` scheme, so a browser can hand a pair link to this
// program. The installer writes the same keys (installer/DeckAgent.iss); this
// writes them on every normal start too, so an exe copied somewhere by hand,
// or a development build, is reachable without the installer — and so the
// keys follow the exe if it moves.
//
//   HKCU\Software\Classes\multitasker
//     (Default)            = "URL:Multitasker"
//     URL Protocol         = ""
//     DefaultIcon\(Default)          = "<exe>",0
//     shell\open\command\(Default)   = "<exe>" "%1"
//
// Per user, no administrator. Idempotent: nothing is written when the values
// are already what they should be. `--no-register` skips it (the tests use
// that, so a test run leaves no trace in the registry).
public static class Protocol
{
    public const string Scheme = "multitasker";
    const string ClassKey = @"Software\Classes\" + Scheme;

    public static void Register()
    {
        var exe = Environment.ProcessPath ?? Application.ExecutablePath;
        var command = $"\"{exe}\" \"%1\"";
        var icon = $"\"{exe}\",0";

        using var root = Registry.CurrentUser.CreateSubKey(ClassKey, writable: true)
            ?? throw new InvalidOperationException("cannot open the class key");
        Put(root, "", "URL:Multitasker");
        Put(root, "URL Protocol", "");
        using var iconKey = root.CreateSubKey("DefaultIcon", writable: true)!;
        Put(iconKey, "", icon);
        using var commandKey = root.CreateSubKey(@"shell\open\command", writable: true)!;
        Put(commandKey, "", command);
    }

    public static bool IsRegistered()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(ClassKey + @"\shell\open\command", writable: false);
            return key?.GetValue("") is string;
        }
        catch { return false; }
    }

    static void Put(RegistryKey key, string name, string value)
    {
        if (key.GetValue(name) is string current && current == value) return;
        key.SetValue(name, value, RegistryValueKind.String);
    }
}
