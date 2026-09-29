using System.Security.Cryptography;
using System.Text;

namespace DeckAgent;

// The one thing this program and the browser have to agree on byte for byte.
// The browser seals an instruction with `encryptText` in public/crypto.js; this
// opens it. The exact form is pinned in docs/DECK_AGENT_PROTOCOL.md 「暗号文の形」 and in
// test/vectors/deck-seal.json, and test/deck-seal-agent.js runs this code over
// that file.
//
//   master   32 bytes, base64url in agent.json — the board's own key
//   dataKey  HKDF-SHA256(ikm = master, salt = zero-length, info = "taskboard/data", 32)
//   sealed   "v1." + base64url(iv, 12 bytes) + "." + base64url(ciphertext || tag)
//            AES-256-GCM, 16-byte tag appended to the ciphertext, no additional data
public static class Sealing
{
    const string DataInfo = "taskboard/data";
    const int IvBytes = 12;
    const int TagBytes = 16;

    public static byte[] FromBase64Url(string text)
    {
        var s = (text ?? "").Trim().Replace('-', '+').Replace('_', '/');
        var pad = (4 - s.Length % 4) % 4;
        return Convert.FromBase64String(s + new string('=', pad));
    }

    public static string ToBase64Url(ReadOnlySpan<byte> bytes)
        => Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    // The key as it sits in agent.json. Anything that is not 32 bytes of
    // base64url is refused here rather than at the first instruction.
    public static byte[] MasterFromText(string text)
    {
        var master = FromBase64Url(text);
        if (master.Length != 32) throw new FormatException("the key must be 32 bytes");
        return master;
    }

    public static byte[] DataKeyOf(byte[] master)
        => HKDF.DeriveKey(HashAlgorithmName.SHA256, master, 32, salt: Array.Empty<byte>(),
            info: Encoding.UTF8.GetBytes(DataInfo));

    // Throws on anything that is not a v1 seal made under this key: a wrong
    // key, a changed byte, a different format. The caller treats every throw
    // the same way — the instruction is not carried out.
    public static string Open(byte[] master, string sealedText)
    {
        var parts = (sealedText ?? "").Split('.');
        if (parts.Length != 3 || parts[0] != "v1") throw new FormatException("not a v1 seal");
        var iv = FromBase64Url(parts[1]);
        var body = FromBase64Url(parts[2]);
        if (iv.Length != IvBytes) throw new FormatException("iv must be 12 bytes");
        if (body.Length < TagBytes) throw new FormatException("too short to carry a tag");

        var ciphertext = body.AsSpan(0, body.Length - TagBytes);
        var tag = body.AsSpan(body.Length - TagBytes, TagBytes);
        var plain = new byte[ciphertext.Length];
        using var aes = new AesGcm(DataKeyOf(master), TagBytes);
        aes.Decrypt(iv, ciphertext, tag, plain);
        return Encoding.UTF8.GetString(plain);
    }

    // The inverse, with a caller-chosen IV. The agent never seals anything for
    // the board; this exists so the check tool can reproduce the pinned vector
    // from its inputs and prove the two directions agree.
    public static string Seal(byte[] master, byte[] iv, string text)
    {
        if (iv.Length != IvBytes) throw new ArgumentException("iv must be 12 bytes", nameof(iv));
        var plain = Encoding.UTF8.GetBytes(text);
        var ciphertext = new byte[plain.Length];
        var tag = new byte[TagBytes];
        using var aes = new AesGcm(DataKeyOf(master), TagBytes);
        aes.Encrypt(iv, plain, ciphertext, tag);
        var body = new byte[ciphertext.Length + TagBytes];
        ciphertext.CopyTo(body, 0);
        tag.CopyTo(body, ciphertext.Length);
        return $"v1.{ToBase64Url(iv)}.{ToBase64Url(body)}";
    }
}
