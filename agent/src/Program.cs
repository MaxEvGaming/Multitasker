using System.Security.Cryptography;
using System.Text;

namespace DeckAgent;

static class Program
{
    // DeckAgent.exe                                  the tray program
    // DeckAgent.exe multitasker://pair#v1|...        same, and take this pair link (hand it to the
    //                                                running copy if there is one, then exit)
    // DeckAgent.exe --config <path>                  same, with the settings file elsewhere (tests)
    // DeckAgent.exe --settings                       same, and open the settings window at once
    // DeckAgent.exe --lang ja|en                     override the Windows display language
    // DeckAgent.exe --no-register                    do not write the multitasker:// registry keys (tests)
    // DeckAgent.exe --obs-config <path>              read OBS's websocket settings from here, not from
    //                                                %APPDATA%\obs-studio\... (tests; MULTITASKER_OBS_CONFIG does the same)
    // DeckAgent.exe --check-seal <vector.json> [s]   open the pinned vector and exit (test/deck-seal-agent.js)
    // DeckAgent.exe --check-pair <text>              parse a pair link and exit (test/deck-agent.js)
    // DeckAgent.exe --check-url <text>               apply the url rule and exit (test/deck-agent.js)
    // DeckAgent.exe --check-obs <args json> [...]    print the OBS requests one sealed instruction
    //                                                composes, against a stub, and exit (ObsCheck.cs)
    // DeckAgent.exe --check-marker <args json> [...] the stream marker's requests and line, against
    //                                                the same stub, and exit (ObsCheck.RunMarker)
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--check-seal")
            return SealCheck.Run(args[1], args.Length > 2 ? args[2] : null);
        if (args.Length >= 2 && args[0] == "--check-pair") return PairLink.Check(args[1]);
        if (args.Length >= 2 && args[0] == "--check-url") return UrlRule.Check(args[1]);
        if (args.Length >= 2 && args[0] == "--check-obs") return ObsCheck.Run(args[1], args[2..]);
        if (args.Length >= 2 && args[0] == "--check-marker") return ObsCheck.RunMarker(args[1], args[2..]);

        string? configPath = null;
        string? pairText = null;
        var openSettings = false;
        var register = true;
        for (var i = 0; i < args.Length; i += 1)
        {
            if (args[i] == "--config" && i + 1 < args.Length) configPath = Path.GetFullPath(args[++i]);
            else if (args[i] == "--settings") openSettings = true;
            else if (args[i] == "--no-register") register = false;
            else if (args[i] == "--obs-config" && i + 1 < args.Length) ObsConfig.Override = Path.GetFullPath(args[++i]);
            else if (args[i] == "--lang" && i + 1 < args.Length) Strings.Japanese = args[++i].StartsWith("ja", StringComparison.OrdinalIgnoreCase);
            else if (PairLink.Looks(args[i])) pairText = args[i];
        }

        // One of these per settings file. A second start does nothing and goes
        // away — the icon that is already there is the running one — unless it
        // was started to deliver a pair link, in which case the link is handed
        // to the running one first.
        var scope = configPath == null ? "" : "." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(configPath.ToLowerInvariant())))[..16];
        using var single = new Mutex(initiallyOwned: true, $"Local\\Multitasker.DeckAgent{scope}", out var first);
        if (!first)
        {
            if (pairText != null)
            {
                Log.Path = Path.Combine(Path.GetDirectoryName(configPath ?? Settings.DefaultPath)!, "agent.log");
                Handoff.Send(scope, pairText);
            }
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp(configPath, openSettings, pairText, register, scope));
        return 0;
    }
}
