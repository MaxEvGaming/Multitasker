namespace DeckAgent;

// The settings window. Built in code rather than with the designer, so the
// two languages come from the one table in Strings.cs.
//
// The order is the board's order (public/index.html #sec-pc). What leads is
// the one thing that actually connects a PC: ③「この PC をつなぐ」 on the
// board. The 「接続コード」 box is the board's fallback, not its main road —
// the board only shows a code on a phone, or after ③ was pressed and nothing
// answered — so it is folded away here too, under 「うまくいかないとき」.
// Before this it led the window, and told people to fetch a code the board
// was not showing them (2026-09-12).
//
// The three things the code contains (board address, token, key) and the OBS
// settings stay under 「詳細」, for anyone setting the program up by hand. The
// OBS port and password are no longer among the things anyone has to fetch:
// they are read off this machine (ObsConfig.cs), and the window says where an
// OBS square is going and whether OBS is listening, so a square that does
// nothing has a reason on show rather than a silence (
// 2026-09-13 「ユーザーが手動でやんなきゃダメな事なの？」).
//
// Whichever of the two the person is, the window opens with a sentence about
// where they stand: not set up yet → press ③; set up → whether this PC is
// connected and to which board. Before this the guidance was shown only when
// nothing was configured, so a connected person got a window with no prose in
// it at all — 「▸ うまくいかないとき」 with nothing above it to be the thing
// that did not work — while the board beside it said 「接続済み ✓」
// (2026-09-12).
public sealed class SettingsForm : Form
{
    readonly string configPath;
    readonly TextBox code = new();
    readonly TextBox boardUrl = new();
    readonly TextBox token = new() { UseSystemPasswordChar = true };
    readonly TextBox key = new() { UseSystemPasswordChar = true };
    readonly TextBox obsHost = new();
    readonly NumericUpDown obsPort = new() { Minimum = 1, Maximum = 65535 };
    readonly TextBox obsPassword = new() { UseSystemPasswordChar = true };
    readonly NumericUpDown timeout = new() { Minimum = 1, Maximum = 86400 };
    readonly CheckBox startAtLogon = new();
    readonly CheckBox guard = new();
    readonly CheckBox reveal = new();
    readonly TableLayoutPanel advanced;
    readonly Button toggle;
    readonly TableLayoutPanel fallback;
    readonly Button fallbackToggle;
    readonly Button connect;
    readonly Button ok;

    // The three lines at the top, and where their words come from. Only built
    // for a program that is already set up; when nothing is configured the
    // same place holds the fixed 「③ を押してください」 guidance instead, and
    // these stay null.
    readonly Label? stateHead;
    readonly Label? stateBoard;
    readonly Label? stateNote;
    // 「再接続」, shown only while this PC is cut off. Pressing it is the one
    // way back after a sign-in from a new device or the board's stop; the
    // tray does the telling (TrayApp.Resume) and this only asks it to.
    readonly Button? reconnect;
    readonly Action? resume;
    readonly Func<AgentStatus>? live;
    readonly System.Windows.Forms.Timer? ticker;

    // What was found in OBS's own settings: where an OBS square is going, and
    // whether OBS is listening at all. Always drawn — the address line answers
    // 「どこに繋ぐか」 in every case, including the one where OBS is not
    // installed and the answer comes from 「詳細」 (
    // 2026-09-13).
    readonly Label obsLine;
    readonly Label obsNote;
    readonly Button obsEnable;
    int tick;

    public Settings Result { get; }

    // True when the window was closed by 「貼り付けて接続」: the tray then
    // announces the connection the way it does for a link from the browser.
    public bool PairedByCode { get; private set; }

    // True when 保存 changed the guard switch: the tray then tells the board.
    public bool GuardChanged { get; private set; }

    // `live` is the tray's own reading of where things stand — the same one
    // the icon and its tooltip are painted from, so the two cannot disagree.
    // Null when there is nobody to ask (no state line is drawn then).
    public SettingsForm(Settings settings, string configPath, Func<AgentStatus>? live = null, Action? resume = null)
    {
        Result = settings;
        this.configPath = configPath;
        this.live = live;
        this.resume = resume;

        Text = Strings.T("settings.title");
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font(SystemFonts.MessageBoxFont?.FontFamily ?? FontFamily.GenericSansSerif, 9.5f);

        boardUrl.Text = settings.BoardUrl;
        token.Text = settings.Token;
        key.Text = settings.Key;
        obsHost.Text = settings.ObsHost;
        obsPort.Value = settings.ObsPort is >= 1 and <= 65535 ? settings.ObsPort : 4455;
        obsPassword.Text = settings.ObsPassword;
        timeout.Value = settings.TimeoutSeconds >= 1 ? Math.Min(settings.TimeoutSeconds, 86400) : 60;
        startAtLogon.Text = Strings.T("settings.startAtLogon");
        startAtLogon.Checked = Startup.IsEnabled();
        guard.Text = Strings.T("settings.guard");
        guard.Checked = settings.Guard;
        reveal.Text = Strings.T("settings.show");
        reveal.CheckedChanged += (_, _) =>
        {
            token.UseSystemPasswordChar = !reveal.Checked;
            key.UseSystemPasswordChar = !reveal.Checked;
            obsPassword.UseSystemPasswordChar = !reveal.Checked;
        };

        // Not docked: a form sizes itself to its children only when they are
        // laid out, not docked, so everything sits in one-column tables that
        // the form wraps around.
        TableLayoutPanel Grid() {
            var g = new TableLayoutPanel
            {
                ColumnCount = 2, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(12, 6, 12, 0),
            };
            g.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            g.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 440));
            g.RowCount = 0;
            return g;
        }
        void Row(TableLayoutPanel grid, string label, Control control)
        {
            var row = grid.RowCount++;
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(3, 8, 12, 3) }, 0, row);
            control.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            control.Margin = new Padding(3, 5, 3, 3);
            grid.Controls.Add(control, 1, row);
        }
        void Span(TableLayoutPanel grid, Control control)
        {
            var row = grid.RowCount++;
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            control.AutoSize = true;
            control.Margin = new Padding(3, 6, 3, 3);
            grid.Controls.Add(control, 0, row);
            grid.SetColumnSpan(control, 2);
        }
        Label Note(string text, bool loud = false) => new()
        {
            Text = text, MaximumSize = new Size(560, 0), AutoSize = true,
            ForeColor = loud ? SystemColors.ControlText : SystemColors.GrayText,
            Font = loud ? new Font(Font, FontStyle.Bold) : Font,
        };

        // A flat, borderless button used as a fold-out heading: 「うまくいかないとき」
        // and 「詳細」 both open a panel below them.
        Button Disclosure() {
            var b = new Button { AutoSize = true, Padding = new Padding(8, 1, 8, 1), FlatStyle = FlatStyle.Flat };
            b.FlatAppearance.BorderSize = 0;
            return b;
        }

        // ---- what leads: where this PC stands, in both cases.
        //
        // Nothing set up yet → press ③ on the board, which is the only thing
        // that connects a PC. Already set up → whether it is connected at this
        // moment and to which board: someone who opened this from the menu is
        // not here to pair, they are here to find out what is going on, and
        // this program is the one that knows.
        var main = Grid();
        if (!settings.IsConfigured)
        {
            Span(main, Note(Strings.T("settings.connectHere"), loud: true));
            Span(main, Note(Strings.T("settings.connectHereNote")));
        }
        else if (live != null)
        {
            stateHead = Note("", loud: true);
            stateBoard = Note("");
            stateNote = Note("");
            Span(main, stateHead);
            Span(main, stateBoard);
            Span(main, stateNote);
            reconnect = new Button { Text = Strings.T("settings.reconnect"), AutoSize = true, Padding = new Padding(10, 2, 10, 2), Visible = false };
            reconnect.Click += (_, _) => { resume?.Invoke(); ShowState(); };
            Span(main, reconnect);
            ShowState();
        }

        // ---- 「うまくいかないとき」: the connect code, folded away
        fallbackToggle = Disclosure();
        fallbackToggle.Click += (_, _) => SetFallback(!fallback!.Visible);
        Span(main, fallbackToggle);

        fallback = Grid();
        Span(fallback, Note(Strings.T("settings.fallbackNote")));
        Row(fallback, Strings.T("settings.code"), code);
        connect = new Button { Text = Strings.T("settings.pasteConnect"), AutoSize = true, Padding = new Padding(10, 2, 10, 2) };
        connect.Click += (_, _) => PasteAndConnect();
        Span(fallback, connect);

        var tail = Grid();
        Span(tail, guard);
        Span(tail, startAtLogon);

        // ---- OBS: read off this machine rather than copied out of OBS by hand
        //
        // Out here rather than inside 「詳細」, which is folded away: the whole
        // point of the line is that someone whose OBS square did nothing can
        // see why without knowing where to look. One grey line for the ordinary
        // case, and prose plus a button only when something is actually wrong.
        obsLine = Note("");
        obsNote = Note("");
        obsEnable = new Button { Text = Strings.T("settings.obsEnable"), AutoSize = true, Padding = new Padding(10, 2, 10, 2), Visible = false };
        obsEnable.Click += (_, _) => TurnObsOn();
        Span(tail, obsLine);
        Span(tail, obsNote);
        Span(tail, obsEnable);
        ShowObs();
        // Typing in 「詳細」 moves the address and the 「どこから来たか」 in the
        // line above it, so the rule about a typed field winning is watched
        // rather than read about.
        obsHost.TextChanged += (_, _) => ShowObs();
        obsPort.ValueChanged += (_, _) => ShowObs();
        obsPassword.TextChanged += (_, _) => ShowObs();

        // The connection comes and goes while this window is open, and a line
        // that was true when it opened is worse than no line at all. A second
        // is well under what anyone notices and costs three string comparisons;
        // the state itself is pushed onto this thread by the worker, so there
        // is nothing to poll but a field. OBS's settings are a file, and a file
        // is worth opening rather less often — every fifth pass, which is
        // quick enough to catch someone switching the server on in OBS while
        // this window sits beside it.
        ticker = new System.Windows.Forms.Timer { Interval = 1000 };
        ticker.Tick += (_, _) =>
        {
            ShowState();
            if (++tick % 5 == 0) ShowObs();
        };
        ticker.Start();

        // ---- 「詳細」: the fields the code fills in, and the OBS settings
        toggle = Disclosure();
        toggle.Click += (_, _) => SetAdvanced(!advanced!.Visible);
        Span(tail, toggle);

        advanced = Grid();
        Span(advanced, Note(Strings.T("settings.advancedNote")));
        Row(advanced, Strings.T("settings.boardUrl"), boardUrl);
        Row(advanced, Strings.T("settings.token"), token);
        Row(advanced, Strings.T("settings.key"), key);
        Span(advanced, reveal);
        Row(advanced, Strings.T("settings.obsHost"), obsHost);
        Row(advanced, Strings.T("settings.obsPort"), obsPort);
        Row(advanced, Strings.T("settings.obsPassword"), obsPassword);
        Row(advanced, Strings.T("settings.timeout"), timeout);
        // The path can be long; wrapped, or it would widen the label column
        // and push the boxes off the window.
        Span(advanced, new Label
        {
            Text = string.Format(Strings.T("settings.file"), configPath), ForeColor = SystemColors.GrayText,
            MaximumSize = new Size(560, 0),
        });
        advanced.Visible = false;
        SetAdvanced(false);
        fallback.Visible = false;

        ok = new Button { Text = Strings.T("settings.ok"), AutoSize = true, Padding = new Padding(10, 2, 10, 2) };
        var cancel = new Button { Text = Strings.T("settings.cancel"), AutoSize = true, Padding = new Padding(10, 2, 10, 2), DialogResult = DialogResult.Cancel };
        ok.Click += (_, _) => Save();
        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(12, 6, 12, 12), Anchor = AnchorStyles.Right,
        };
        buttons.Controls.Add(ok);
        buttons.Controls.Add(cancel);

        var outer = new TableLayoutPanel { ColumnCount = 1, RowCount = 5, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        for (var i = 0; i < 5; i += 1) outer.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        outer.Controls.Add(main, 0, 0);
        outer.Controls.Add(fallback, 0, 1);
        outer.Controls.Add(tail, 0, 2);
        outer.Controls.Add(advanced, 0, 3);
        outer.Controls.Add(buttons, 0, 4);

        SetFallback(false);
        CancelButton = cancel;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Controls.Add(outer);
        Shown += (_, _) => { if (fallback.Visible) code.Focus(); };
    }

    // Whether the third line is on show. Kept here rather than read back off
    // the label, because a control's Visible answers for its parents too and
    // this is first called while the window is still being built.
    bool noteVisible = true;

    // The first lines, written from the tray's own reading of the connection.
    // Called once while the window is built and once a second after that, so
    // a connection that drops or comes back is seen without reopening.
    void ShowState()
    {
        if (live == null || stateHead == null || stateBoard == null || stateNote == null) return;
        var now = live();
        // A program with all three settings filled in that the tray still
        // calls NotConfigured got there one way only: the key would not load,
        // so no connection was ever attempted.
        var (head, note) = now.State switch
        {
            AgentState.Connected => (Strings.T("settings.stateConnected"), Strings.T("settings.stateConnectedNote")),
            AgentState.Connecting => (Strings.T("settings.stateConnecting"), ""),
            AgentState.Reconnecting => (Strings.T("settings.stateReconnecting"), Strings.T("settings.stateReconnectingNote")),
            AgentState.Rejected => (Strings.T("settings.stateRejected"), Strings.T("settings.stateRejectedNote")),
            AgentState.Suspended => (Strings.T("settings.stateSuspended"), Strings.T("settings.stateSuspendedNote")),
            _ => (Strings.T("state.badKey"), Strings.T("settings.stateBadKeyNote")),
        };
        var cutOff = now.State == AgentState.Suspended;
        if (reconnect != null && reconnect.Visible != cutOff) reconnect.Visible = cutOff;
        var board = string.Format(Strings.T("settings.stateBoard"), now.Board);

        // Only what changed: assigning a label its own text still lays the
        // form out again, and this runs every second for as long as the
        // window is open.
        if (stateHead.Text != head) stateHead.Text = head;
        if (stateBoard.Text != board) stateBoard.Text = board;
        if (stateNote.Text != note) stateNote.Text = note;
        if (noteVisible != note.Length > 0) stateNote.Visible = noteVisible = note.Length > 0;
    }

    // What is in the OBS boxes at this moment, which is what would be saved —
    // so the line reads off the form rather than off the disk and follows a
    // password as it is typed.
    Settings Typed() => new()
    {
        ObsHost = obsHost.Text,
        ObsPort = (int)obsPort.Value,
        ObsPassword = obsPassword.Text,
    };

    // Where an OBS square is going and whether OBS is listening, from OBS's own
    // settings file. Called while the window is built, every five seconds after
    // that, and whenever one of the three boxes changes.
    void ShowObs()
    {
        var obs = ObsConfig.Resolve(Typed());
        var found = obs.Found;

        var line = string.Format(Strings.T("settings.obsEndpoint"), obs.Address,
            Strings.T(obs.PortFromObs ? "settings.obsFromObs" : "settings.obsFromHere"),
            Strings.T(obs.PasswordFromObs ? "settings.obsFromObs"
                : obs.Password.Length > 0 ? "settings.obsFromHere" : "settings.obsFromNothing"));

        // Grey for 「これでいい」, ordinary text for the three states that
        // explain a square doing nothing.
        var (note, loud) =
            !found.Found && found.Problem != null
                ? (string.Format(Strings.T("settings.obsBadFile"), found.Path, found.Problem), true)
            : !found.Found
                ? (string.Format(Strings.T("settings.obsNoFile"), found.Path), true)
            : !found.Enabled
                ? (Strings.T("settings.obsOff"), true)
                : (Strings.T("settings.obsOn"), false);

        if (obsLine.Text != line) obsLine.Text = line;
        if (obsNote.Text != note) obsNote.Text = note;
        var colour = loud ? SystemColors.ControlText : SystemColors.GrayText;
        if (obsNote.ForeColor != colour) obsNote.ForeColor = colour;
        // Only offered when there is a file to write and it says off: nothing
        // to switch on when OBS is not installed, and nothing to do when the
        // server is already on.
        var offer = found.Found && !found.Enabled;
        if (obsEnable.Visible != offer) obsEnable.Visible = offer;
    }

    // 「OBS の待ち受けを有効にする」. The one place this program writes another
    // program's settings, and it takes a press and a Yes — the window says what
    // file is about to change and that OBS has to be started again before it
    // means anything (measured 2026-09-12; ObsConfig.cs).
    void TurnObsOn()
    {
        var path = ObsConfig.ConfigPath;
        var running = ObsConfig.ObsIsRunning() ? Strings.T("settings.obsEnableRunning") : "";
        var ask = string.Format(Strings.T("settings.obsEnableAsk"), path, running);
        if (MessageBox.Show(this, ask, Strings.T("app.name"), MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
            return;

        var (ok, problem) = ObsConfig.Enable();
        ShowObs();
        MessageBox.Show(this,
            ok ? string.Format(Strings.T("settings.obsEnabled"), ObsConfig.Resolve(Typed()).Address)
               : string.Format(Strings.T("settings.obsEnableFailed"), problem),
            Strings.T("app.name"), MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) ticker?.Dispose();
        base.Dispose(disposing);
    }

    void SetAdvanced(bool open)
    {
        advanced.Visible = open;
        toggle.Text = (open ? "▾ " : "▸ ") + Strings.T("settings.advanced");
    }

    // Enter follows what is on show: with the code box out, it is 「貼り付けて
    // 接続」; folded away, it is 保存. Opening it puts the cursor in the box,
    // so the fold costs one press and no hunting.
    void SetFallback(bool open)
    {
        fallback.Visible = open;
        fallbackToggle.Text = (open ? "▾ " : "▸ ") + Strings.T("settings.fallback");
        AcceptButton = open ? connect : ok;
        if (open && Visible) code.Focus();
    }

    // 「貼り付けて接続」. An empty box is filled from the clipboard first —
    // the button says paste, and one press should be enough. Then the code is
    // read, its three parts put where the hand route would put them, and the
    // window saved and closed as if 保存 had been pressed.
    void PasteAndConnect()
    {
        if (string.IsNullOrWhiteSpace(code.Text))
        {
            try { if (Clipboard.ContainsText()) code.Text = Clipboard.GetText().Trim(); }
            catch { /* a clipboard that will not open is the same as an empty one */ }
        }
        if (string.IsNullOrWhiteSpace(code.Text)) { Complain(Strings.T("settings.needCode"), code); return; }

        var (link, reason) = PairLink.Parse(code.Text);
        if (link == null)
        {
            Complain($"{Strings.T("pair.refused")}\n\n{Strings.T(reason)}", code);
            return;
        }
        boardUrl.Text = link.Origin;
        token.Text = link.Token;
        key.Text = link.Key;
        PairedByCode = true;
        Save();
    }

    void Save()
    {
        var url = boardUrl.Text.Trim();
        // Nothing filled in anywhere: the person has not pasted a code. Say
        // that — and unfold the box first, or the complaint would point at a
        // field that is not on show.
        if (url.Length == 0 && string.IsNullOrWhiteSpace(token.Text) && string.IsNullOrWhiteSpace(key.Text))
        { SetFallback(true); Complain(Strings.T("settings.needCode"), code); return; }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http"))
        { SetAdvanced(true); Complain(Strings.T("settings.invalidUrl"), boardUrl); return; }
        if (string.IsNullOrWhiteSpace(token.Text)) { SetAdvanced(true); Complain(Strings.T("settings.invalidToken"), token); return; }
        try { Sealing.MasterFromText(key.Text); }
        catch { SetAdvanced(true); Complain(Strings.T("settings.invalidKey"), key); return; }

        Result.BoardUrl = url;
        Result.Token = token.Text.Trim();
        Result.Key = key.Text.Trim();
        Result.ObsHost = obsHost.Text.Trim();
        Result.ObsPort = (int)obsPort.Value;
        Result.ObsPassword = obsPassword.Text;
        Result.TimeoutSeconds = (int)timeout.Value;
        GuardChanged = Result.Guard != guard.Checked;
        Result.Guard = guard.Checked;

        try
        {
            Result.Save(configPath);
            Startup.Set(startAtLogon.Checked);
        }
        catch (Exception e)
        {
            Complain(string.Format(Strings.T("settings.saveFailed"), e.Message), null);
            return;
        }
        Log.Write(PairedByCode ? "settings: saved from a connect code" : "settings: saved");
        DialogResult = DialogResult.OK;
        Close();
    }

    void Complain(string text, Control? focus)
    {
        MessageBox.Show(this, text, Strings.T("app.name"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
        focus?.Focus();
    }
}
