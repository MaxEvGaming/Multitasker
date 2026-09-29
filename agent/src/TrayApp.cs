using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace DeckAgent;

// The tray icon and the menu under it. Owns the Worker: builds one from the
// settings, replaces it when the settings change or 「再接続」 is chosen, and
// colours the icon from its state. Also the receiving end of a pair link —
// from the command line on start, from a second copy over the pipe, or
// pasted into the settings window — and the daily look for an update.
public sealed class TrayApp : ApplicationContext
{
    readonly string configPath;
    readonly NotifyIcon tray;
    readonly ToolStripMenuItem status;
    readonly ToolStripMenuItem update;
    readonly Form pump;          // never shown; a handle to marshal state changes onto the UI thread
    readonly Dictionary<AgentState, Icon> icons = new();
    readonly Handoff handoff;
    readonly Updates updates = new();
    Settings settings;
    Worker? worker;
    SettingsForm? openForm;
    // What the icon is showing. The settings window reads it through Status()
    // so its first lines and the icon cannot say different things.
    AgentState shown = AgentState.NotConfigured;
    // Set when a pair link has just been taken; the next Connected is
    // announced with a balloon, so the person who pressed 「この PC をつなぐ」
    // on the board sees the PC answer.
    bool announceConnected;

    public TrayApp(string? configPath, bool openSettings = false, string? pairText = null, bool register = true, string scope = "")
    {
        this.configPath = configPath ?? Settings.DefaultPath;
        Log.Path = Path.Combine(Path.GetDirectoryName(this.configPath)!, "agent.log");
        settings = Settings.Load(this.configPath);

        pump = new Form { ShowInTaskbar = false, WindowState = FormWindowState.Minimized, Opacity = 0 };
        _ = pump.Handle;

        foreach (var (state, colour) in new[]
        {
            (AgentState.NotConfigured, Color.FromArgb(140, 140, 140)),
            (AgentState.Connecting, Color.FromArgb(230, 170, 30)),
            (AgentState.Reconnecting, Color.FromArgb(230, 170, 30)),
            (AgentState.Connected, Color.FromArgb(60, 170, 90)),
            (AgentState.Rejected, Color.FromArgb(200, 60, 60)),
            (AgentState.Suspended, Color.FromArgb(150, 90, 200)),
        }) icons[state] = Paint(colour);

        status = new ToolStripMenuItem { Enabled = false };
        update = new ToolStripMenuItem { Visible = false };
        var menu = new ContextMenuStrip();
        menu.Items.Add(status);
        menu.Items.Add(update);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Strings.T("menu.settings"), null, (_, _) => ShowSettings());
        menu.Items.Add(Strings.T("menu.reconnect"), null, (_, _) => Reconnect());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Strings.T("menu.exit"), null, (_, _) => Quit());

        tray = new NotifyIcon { ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => ShowSettings();

        Log.Write($"agent {updates.Running} started; settings at {this.configPath}");

        // So a browser can reach this program. Not fatal: without it the
        // connect code still works, and the log says why the link did not.
        if (register)
        {
            try { Protocol.Register(); }
            catch (Exception e) { Log.Write($"protocol: could not register multitasker://: {e.Message}"); }
        }

        handoff = new Handoff(scope);
        handoff.Listen((link) => pump.BeginInvoke(() => TakePairLink(link, fromPipe: true)));

        updates.Available += (version, url) => pump.BeginInvoke(() =>
        {
            update.Text = string.Format(Strings.T("menu.update"), version);
            update.Tag = url;
            update.Visible = true;
        });
        update.Click += (_, _) =>
        {
            if (update.Tag is string url) OpenInBrowser(url);
        };

        Restart();
        if (pairText != null)
        {
            TakePairLink(pairText, fromPipe: false);
        }
        // Nothing to connect to yet: the first thing a fresh install needs is
        // the window with the guidance, not a grey icon to go looking for.
        else if (openSettings || !settings.IsConfigured)
        {
            pump.BeginInvoke(ShowSettings);
        }
    }

    // A fresh Worker from the settings on disk. The old one is disposed first,
    // which drops its stream; the board hands anything still pending to the new
    // one, and the new one's seen-set is empty — an instruction the old one had
    // received but not yet answered could in principle be offered again, and
    // the board's 409 on the second receipt is what settles that.
    void Restart()
    {
        worker?.Dispose();
        worker = null;
        updates.Watch(settings.IsConfigured ? settings.BoardBase : "");

        if (!settings.IsConfigured)
        {
            Show(AgentState.NotConfigured, Strings.T("state.notConfigured"));
            return;
        }
        try
        {
            worker = new Worker(settings);
        }
        catch (Exception e)
        {
            Log.Write($"settings: {e.Message}");
            Show(AgentState.NotConfigured, Strings.T("state.badKey"));
            return;
        }
        worker.StateChanged += (state) => pump.BeginInvoke(() => Show(state, TextFor(state)));
        worker.GuardTold += (on) => pump.BeginInvoke(() => TakeGuard(on));
        Show(AgentState.Connecting, Strings.T("state.connecting"));
        worker.Start();
    }

    // The board's word on the guard switch, sent at the top of every stream
    // (docs/DECK_AGENT_PROTOCOL.md §1, T-085). The board holds the one that
    // counts and only this program can change it (T-075, over /guard); the
    // copy in agent.json is what the settings window shows, and it follows
    // the board rather than the other way round — so a file written when the
    // switch was off by default (0.3.0) reads on once the PC has connected to
    // a board where it is on (sql/014_guard_default_on.sql).
    void TakeGuard(bool on)
    {
        if (settings.Guard == on) return;
        settings.Guard = on;
        Log.Write($"guard: the file said {(on ? "off" : "on")} — updated to {(on ? "on" : "off")}");
        try { settings.Save(configPath); }
        catch (Exception e) { Log.Write($"guard: could not save: {e.Message}"); }
    }

    // A pair link, wherever it came from: checked, written to agent.json in
    // place of the three fields it carries (the OBS settings and the timeout
    // are kept), and the connection restarted with it. A link that does not
    // parse is refused with a sentence, not a crash — the person may have
    // pasted the wrong thing, and is told which part was wrong.
    void TakePairLink(string text, bool fromPipe)
    {
        Log.Write($"pair: link received ({(fromPipe ? "from another start" : "from the command line")})");
        var (link, reason) = PairLink.Parse(text);
        if (link == null)
        {
            Log.Write($"pair: refused ({reason})");
            MessageBox.Show($"{Strings.T("pair.refused")}\n\n{Strings.T(reason)}", Strings.T("app.name"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        // The window that is open is the one asking for a connect code, and
        // the code has just arrived by another road: it has nothing left to
        // ask. It is closed — with DialogResult.Cancel, so ShowSettings does
        // not save the half-typed form over what the link just wrote. Anything
        // typed into it is dropped; the connection that happened wins over the
        // one that was being typed. The tray still says 「接続しました」 in its
        // balloon, so the closing is not silent.
        //
        // Only when the link is good and was written: a link that was refused,
        // or that could not be saved, leaves the window up, because it is
        // where the person can still fix it by hand.
        if (Apply(link)) CloseSettings();
    }

    void CloseSettings()
    {
        if (openForm == null || openForm.IsDisposed) return;
        Log.Write("pair: closing the settings window");
        openForm.DialogResult = DialogResult.Cancel;
        openForm.Close();
    }

    bool Apply(PairLink link)
    {
        settings.BoardUrl = link.Origin;
        settings.Token = link.Token;
        settings.Key = link.Key;
        try
        {
            settings.Save(configPath);
        }
        catch (Exception e)
        {
            Log.Write($"pair: could not save: {e.Message}");
            MessageBox.Show(string.Format(Strings.T("settings.saveFailed"), e.Message), Strings.T("app.name"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }
        Log.Write("pair: settings written; connecting");
        announceConnected = true;
        Restart();
        return true;
    }

    // 「再接続」 from the menu. After a cut the board has to be told this PC is
    // back before a stream will be accepted; otherwise it is a plain restart.
    void Reconnect()
    {
        if (shown == AgentState.Suspended) Resume();
        else Restart();
    }

    // Coming back after a cut (a sign-in from a new device, or the board's
    // stop). Told to the board first, then connected again. If the board
    // could not be told, the stream is refused once more and the icon says
    // so — nothing is lost by trying.
    async void Resume()
    {
        Log.Write("resume: pressed");
        Show(AgentState.Connecting, Strings.T("state.connecting"));
        await Worker.ResumeAsync(settings);
        Restart();
    }

    static string TextFor(AgentState state) => state switch
    {
        AgentState.Connected => Strings.T("state.connected"),
        AgentState.Connecting => Strings.T("state.connecting"),
        AgentState.Reconnecting => Strings.T("state.reconnecting"),
        AgentState.Rejected => Strings.T("state.rejected"),
        AgentState.Suspended => Strings.T("state.suspended"),
        _ => Strings.T("state.notConfigured"),
    };

    // Where this PC stands, for the settings window. The board is the one the
    // running connection is using — what is typed into 「詳細」 at that moment
    // is not connected to anything until it is saved.
    AgentStatus Status() => new(shown, settings.BoardBase);

    void Show(AgentState state, string text)
    {
        shown = state;
        tray.Icon = icons[state];
        status.Text = text;
        var tip = $"{Strings.T("app.name")} — {text}";
        tray.Text = tip.Length > 127 ? tip[..127] : tip;   // NotifyIcon.Text is capped at 127 characters
        if (state == AgentState.Rejected)
        {
            announceConnected = false;
            tray.ShowBalloonTip(10_000, Strings.T("app.name"), Strings.T("balloon.rejected"), ToolTipIcon.Warning);
        }
        else if (state == AgentState.Suspended)
        {
            announceConnected = false;
            tray.ShowBalloonTip(10_000, Strings.T("app.name"), Strings.T("balloon.suspended"), ToolTipIcon.Warning);
        }
        else if (state == AgentState.Connected && announceConnected)
        {
            announceConnected = false;
            tray.ShowBalloonTip(5_000, Strings.T("app.name"), Strings.T("balloon.paired"), ToolTipIcon.Info);
        }
    }

    void ShowSettings()
    {
        if (openForm != null && !openForm.IsDisposed) { openForm.Activate(); return; }
        using var form = new SettingsForm(settings.Clone(), configPath, Status, Resume);
        openForm = form;
        var answer = form.ShowDialog();
        openForm = null;
        if (answer != DialogResult.OK) return;
        settings = form.Result;
        if (form.PairedByCode) announceConnected = true;
        // The switch lives on the board; the file only remembers what was
        // asked for. Told over the PC's own road, which is the only one that
        // can (docs/DECK_AGENT_PROTOCOL.md §1).
        if (form.GuardChanged) _ = Worker.SetGuardAsync(settings, settings.Guard);
        Restart();
    }

    static void OpenInBrowser(string url)
    {
        try { using var p = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception e) { Log.Write($"update: could not open {url}: {e.Message}"); }
    }

    void Quit()
    {
        tray.Visible = false;
        worker?.Dispose();
        handoff.Dispose();
        updates.Dispose();
        Log.Write("agent exiting");
        ExitThread();
    }

    // A filled circle in the state's colour. Drawn rather than shipped, so the
    // exe stays one file with nothing beside it.
    static Icon Paint(Color colour)
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var fill = new SolidBrush(colour);
            using var edge = new Pen(Color.FromArgb(90, 0, 0, 0), 2);
            g.FillEllipse(fill, 3, 3, 26, 26);
            g.DrawEllipse(edge, 3, 3, 26, 26);
        }
        return Icon.FromHandle(bitmap.GetHicon());
    }
}
