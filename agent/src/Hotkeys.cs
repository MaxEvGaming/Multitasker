using System.Runtime.InteropServices;

namespace DeckAgent;

// `ctrl+shift+f13`: names joined by `+`, pressed left to right, released right
// to left, through SendInput — the same path a real keyboard takes, so the key
// lands in whatever has focus, and a global hotkey registered by OBS, Discord
// or a streaming tool fires the way it would from the keyboard.
public static class Hotkeys
{
    // A key by its name. Modifiers are the left-hand ones, which is what a
    // program checking GetAsyncKeyState(VK_CONTROL) sees as "ctrl held".
    static readonly Dictionary<string, ushort> Keys = new(StringComparer.OrdinalIgnoreCase)
    {
        // modifiers
        ["ctrl"] = 0xA2, ["control"] = 0xA2, ["shift"] = 0xA0, ["alt"] = 0xA4, ["win"] = 0x5B, ["windows"] = 0x5B,
        ["rctrl"] = 0xA3, ["rshift"] = 0xA1, ["ralt"] = 0xA5, ["rwin"] = 0x5C,
        // whitespace and editing
        ["enter"] = 0x0D, ["return"] = 0x0D, ["esc"] = 0x1B, ["escape"] = 0x1B, ["tab"] = 0x09,
        ["space"] = 0x20, ["backspace"] = 0x08, ["delete"] = 0x2E, ["del"] = 0x2E, ["insert"] = 0x2D, ["ins"] = 0x2D,
        // navigation
        ["home"] = 0x24, ["end"] = 0x23, ["pageup"] = 0x21, ["pgup"] = 0x21, ["pagedown"] = 0x22, ["pgdn"] = 0x22,
        ["up"] = 0x26, ["down"] = 0x28, ["left"] = 0x25, ["right"] = 0x27,
        // locks and system
        ["capslock"] = 0x14, ["numlock"] = 0x90, ["scrolllock"] = 0x91, ["printscreen"] = 0x2C, ["prtsc"] = 0x2C,
        ["pause"] = 0x13, ["apps"] = 0x5D, ["menu"] = 0x5D,
        // punctuation (US layout names)
        ["minus"] = 0xBD, ["plus"] = 0xBB, ["equals"] = 0xBB, ["comma"] = 0xBC, ["period"] = 0xBE, ["slash"] = 0xBF,
        ["semicolon"] = 0xBA, ["quote"] = 0xDE, ["backslash"] = 0xDC, ["lbracket"] = 0xDB, ["rbracket"] = 0xDD,
        ["grave"] = 0xC0, ["backtick"] = 0xC0,
        // numpad
        ["numpad0"] = 0x60, ["numpad1"] = 0x61, ["numpad2"] = 0x62, ["numpad3"] = 0x63, ["numpad4"] = 0x64,
        ["numpad5"] = 0x65, ["numpad6"] = 0x66, ["numpad7"] = 0x67, ["numpad8"] = 0x68, ["numpad9"] = 0x69,
        ["multiply"] = 0x6A, ["add"] = 0x6B, ["subtract"] = 0x6D, ["decimal"] = 0x6E, ["divide"] = 0x6F,
        // media
        ["play_pause"] = 0xB3, ["playpause"] = 0xB3, ["play"] = 0xB3, ["media_play_pause"] = 0xB3,
        ["next"] = 0xB0, ["next_track"] = 0xB0, ["media_next"] = 0xB0,
        ["prev"] = 0xB1, ["previous"] = 0xB1, ["prev_track"] = 0xB1, ["media_prev"] = 0xB1,
        ["stop"] = 0xB2, ["media_stop"] = 0xB2,
        ["mute"] = 0xAD, ["volume_mute"] = 0xAD, ["vol_mute"] = 0xAD,
        ["volume_up"] = 0xAF, ["vol_up"] = 0xAF, ["volume_down"] = 0xAE, ["vol_down"] = 0xAE,
        ["browser_home"] = 0xAC, ["browser_back"] = 0xA6, ["browser_forward"] = 0xA7,
        ["launch_mail"] = 0xB4, ["launch_media"] = 0xB5, ["launch_app1"] = 0xB6, ["launch_app2"] = 0xB7,
    };

    // Keys whose scan code carries the E0 prefix on a real keyboard. Without
    // the flag, "right" arrives as numpad-6 and "delete" as numpad-period.
    static readonly HashSet<ushort> Extended = new()
    {
        0xA3, 0xA5, 0x5B, 0x5C, 0x5D,               // rctrl, ralt, lwin, rwin, apps
        0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22,         // ins del home end pgup pgdn
        0x25, 0x26, 0x27, 0x28,                     // arrows
        0x2C, 0x90, 0x6F,                           // printscreen numlock divide
        0xB0, 0xB1, 0xB2, 0xB3, 0xAD, 0xAE, 0xAF,   // media
        0xA6, 0xA7, 0xAC, 0xB4, 0xB5, 0xB6, 0xB7,
    };

    // Names → virtual keys, in the order written. Throws on anything unknown or
    // empty, so a misspelt hotkey is a failed instruction rather than a wrong
    // key pressed in some window.
    public static ushort[] Parse(string keys)
    {
        var names = (keys ?? "").Split('+', StringSplitOptions.TrimEntries);
        if (names.Length == 0 || names.Any(string.IsNullOrEmpty)) throw new FormatException("empty key name");
        var codes = new ushort[names.Length];
        for (var i = 0; i < names.Length; i += 1) codes[i] = CodeOf(names[i]);
        return codes;
    }

    static ushort CodeOf(string name)
    {
        var n = name.ToLowerInvariant();
        if (Keys.TryGetValue(n, out var vk)) return vk;
        if (n.Length == 1)
        {
            var c = n[0];
            if (c >= 'a' && c <= 'z') return (ushort)(0x41 + (c - 'a'));
            if (c >= '0' && c <= '9') return (ushort)(0x30 + (c - '0'));
        }
        if (n.Length is 2 or 3 && n[0] == 'f' && int.TryParse(n.AsSpan(1), out var f) && f >= 1 && f <= 24)
            return (ushort)(0x70 + (f - 1));
        throw new FormatException($"unknown key: {name}");
    }

    public static bool Send(string keys)
    {
        var codes = Parse(keys);
        var inputs = new INPUT[codes.Length * 2];
        var n = 0;
        foreach (var vk in codes) inputs[n++] = KeyEvent(vk, up: false);
        for (var i = codes.Length - 1; i >= 0; i -= 1) inputs[n++] = KeyEvent(codes[i], up: true);
        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent != inputs.Length) Log.Write($"hotkey: SendInput sent {sent}/{inputs.Length} (error {Marshal.GetLastWin32Error()})");
        return sent == inputs.Length;
    }

    // Between one character and the next. 25 ms because that is what was
    // measured to work: at that spacing Windows 11's Notepad took a long line
    // exactly, where the same line sent in one go came back as one letter
    // repeated (2026-09-13, table in docs/DECK_AGENT_PROTOCOL.md §3 `text`).
    // The wait is at least this and not exactly it — Thread.Sleep is rounded up
    // to the system timer's tick, which measured about 31 ms per character on a
    // machine where nothing had asked for a finer timer. Longer only gives the
    // receiver more room, so it is left alone.
    static readonly TimeSpan Gap = TimeSpan.FromMilliseconds(25);

    // Letters rather than keys: every UTF-16 unit of the string is sent as a
    // KEYEVENTF_UNICODE press and release, which carries the character itself
    // instead of a position on a keyboard. So the PC's layout does not matter
    // and Japanese arrives as Japanese — there is no key for 「こんにちは」 to
    // press. Characters outside the basic plane are two units (a surrogate
    // pair) and go as two presses, which is what Windows expects; sending them
    // in the one call keeps them together.
    //
    // The letters land wherever the keyboard would have landed: in the window
    // that is in front at that moment. Nothing here chooses a window.
    //
    // One character per call, Gap apart, and nothing after the last one. Sent
    // all at once instead, a receiver slower than the injection merges them
    // into a key repeat and the line arrives as the same letter over and over:
    // a plain Windows text box took a 46-character line in one call exactly,
    // but Windows 11's own Notepad turned `/gamemode creative` into
    // `/cccccccccreative` (T-049 = A, Owner 2026-09-14). A 40-character line
    // takes about 1.2 s, so this must not be called on the window's thread —
    // it is not: an instruction is carried out on a pool thread
    // (Worker.Dispatch → Task.Run → Executor.RunAsync).
    //
    // `paced` false is the other shape (T-087, Owner 2026-09-14 「切り替え
    // できるように」): every unit of the line in one SendInput, which is what
    // T-049 replaced. Kept as a choice, per square, so it can be tried against
    // a game that may take it; the receiver decides whether it does.
    public static bool Type(string text, bool paced = true)
    {
        if (string.IsNullOrEmpty(text)) return true;
        if (!paced) return Burst(text);
        // One character: press and release, twice over if it is a surrogate
        // pair.
        var inputs = new INPUT[4];
        for (var i = 0; i < text.Length; )
        {
            // A surrogate pair is one character, so it goes in the one call and
            // the pause falls between characters rather than inside one.
            var units = char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]) ? 2 : 1;
            var n = 0;
            for (var u = 0; u < units; u += 1)
            {
                inputs[n++] = UnicodeEvent(text[i + u], up: false);
                inputs[n++] = UnicodeEvent(text[i + u], up: true);
            }
            var sent = SendInput((uint)n, inputs, Marshal.SizeOf<INPUT>());
            if (sent != n)
            {
                // Stops here rather than typing the rest. The caller does not
                // press Enter once this says no (Executor.TypeText), so going
                // on would only leave more of a line that nobody is going to
                // send — the same reasoning as refusing a misspelt hotkey
                // rather than pressing some other key.
                Log.Write($"type: SendInput sent {sent}/{n} at character {i} of {text.Length} (error {Marshal.GetLastWin32Error()})");
                return false;
            }
            i += units;
            if (i < text.Length) Thread.Sleep(Gap);
        }
        return true;
    }

    // The whole line in one call: a press and a release for every UTF-16 unit,
    // in order, so a surrogate pair's two units stay together as they do
    // above. Nothing is waited for. What a receiver does with it is its own
    // affair — Windows 11's Notepad merged such a line into a key repeat
    // (docs/DECK_AGENT_PROTOCOL.md §3 `text`), which is why this is a choice
    // and not the default.
    static bool Burst(string text)
    {
        var inputs = new INPUT[text.Length * 2];
        for (var i = 0; i < text.Length; i += 1)
        {
            inputs[i * 2] = UnicodeEvent(text[i], up: false);
            inputs[i * 2 + 1] = UnicodeEvent(text[i], up: true);
        }
        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent != inputs.Length)
        {
            Log.Write($"type: SendInput sent {sent}/{inputs.Length} in one go (error {Marshal.GetLastWin32Error()})");
            return false;
        }
        return true;
    }

    static INPUT UnicodeEvent(char unit, bool up)
    {
        var flags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u);
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new InputUnion
            {
                // wVk must be 0 for KEYEVENTF_UNICODE; the character travels in
                // wScan.
                ki = new KEYBDINPUT { wVk = 0, wScan = unit, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero },
            },
        };
    }

    static INPUT KeyEvent(ushort vk, bool up)
    {
        var flags = up ? KEYEVENTF_KEYUP : 0u;
        if (Extended.Contains(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = vk,
                    wScan = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC),
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero,
                },
            },
        };
    }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint MAPVK_VK_TO_VSC = 0;

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint uCode, uint uMapType);
}
