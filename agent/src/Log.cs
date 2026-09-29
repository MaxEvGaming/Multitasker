namespace DeckAgent;

// agent.log beside agent.json. What is logged is the shape of things —
// connected, job 42 received, job 42 ok — never the text of an instruction and
// never a command's output. The log is the only place to look when a square
// turns red, so it stays short: a megabyte, then the previous one is kept once.
public static class Log
{
    const long RotateAt = 1024 * 1024;
    static readonly object Gate = new();
    public static string Path { get; set; } = System.IO.Path.Combine(Settings.DefaultDirectory, "agent.log");

    public static void Write(string line)
    {
        var text = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {line}{Environment.NewLine}";
        lock (Gate)
        {
            try
            {
                var dir = System.IO.Path.GetDirectoryName(Path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                if (File.Exists(Path) && new FileInfo(Path).Length > RotateAt)
                    File.Move(Path, Path + ".1", overwrite: true);
                File.AppendAllText(Path, text);
            }
            catch
            {
                // A log that cannot be written is not a reason to stop working.
            }
        }
    }
}
