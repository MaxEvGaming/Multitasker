using System.IO.Pipes;
using System.Text;

namespace DeckAgent;

// One program per settings file (the mutex in Program.cs). When a browser
// opens a pair link, Windows starts a second copy with the link as its
// argument; that copy hands the link to the one already running, over a
// named pipe, and goes away. The running one is the one with the tray icon,
// so it is the one that should say 「接続しました」.
//
// The pipe carries one UTF-8 string per connection and nothing else. It is
// per user (named pipes are), and the only thing that can be done with it is
// to offer a pair link, which the receiver then checks like any other.
public sealed class Handoff : IDisposable
{
    readonly string name;
    readonly CancellationTokenSource stop = new();

    public static string PipeName(string scope) => $"Multitasker.DeckAgent{scope}.pair";

    public Handoff(string scope) { name = PipeName(scope); }

    // The receiving end. `onLink` is called on a worker thread; the caller
    // marshals to the UI thread itself.
    public void Listen(Action<string> onLink) => _ = Task.Run(() => LoopAsync(onLink, stop.Token));

    async Task LoopAsync(Action<string> onLink, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(name, PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await server.WaitForConnectionAsync(ct);
                using var reader = new StreamReader(server, Encoding.UTF8);
                var text = await reader.ReadToEndAsync(ct);
                if (!string.IsNullOrWhiteSpace(text)) onLink(text.Trim());
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception e)
            {
                Log.Write($"handoff: {e.GetType().Name}: {e.Message}");
                try { await Task.Delay(500, ct); } catch (OperationCanceledException) { return; }
            }
        }
    }

    // The sending end, from the copy that is about to exit. True if the
    // running copy took it.
    public static bool Send(string scope, string link, int timeoutMs = 3000)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName(scope), PipeDirection.Out);
            client.Connect(timeoutMs);
            var bytes = Encoding.UTF8.GetBytes(link);
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
            return true;
        }
        catch (Exception e)
        {
            Log.Write($"handoff: could not hand the link over: {e.GetType().Name}: {e.Message}");
            return false;
        }
    }

    public void Dispose() => stop.Cancel();
}
