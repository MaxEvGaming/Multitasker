; Multitasker PC Agent — Inno Setup 6.3 or later (x64compatible needs 6.3+).
;
; Per-user, no administrator prompt: the program goes under
; %LOCALAPPDATA%\Programs, the Run entry, the multitasker:// handler and the
; chosen language under HKCU. The settings file
; (%APPDATA%\Multitasker\agent.json) is not written here and not deleted by
; the uninstaller — the token and key survive a reinstall on purpose.
;
; Built by ..\build.ps1 after `dotnet publish`; expects ..\publish\DeckAgent.exe.
; The version comes from DeckAgent.csproj through /DMyAppVersion=…; the value
; below is only the fallback for compiling this file by hand.

#ifndef MyAppVersion
  #define MyAppVersion "0.2.0"
#endif
#define MyAppName "Multitasker PC Agent"
#define MyAppPublisher "Max EV Gathering"
#define MyAppExeName "DeckAgent.exe"
#define MyRunValue "MultitaskerDeckAgent"
#define MyScheme "multitasker"

[Setup]
AppId={{7D3C1E6A-4B2F-4F0E-9C61-5A8D2E7B3F10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Multitasker PC Agent
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\publish
; One fixed name: the board hands out /download/DeckAgentSetup.exe, and
; /download/agent/version.json says which version that is.
OutputBaseFilename=DeckAgentSetup
Compression=lzma2/max
SolidCompression=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
; A running agent holds its exe open; ask it to close before copying over it.
; The tray program holds its own exe open, so an upgrade over a running copy
; fails with "DeleteFile error code 5" partway through the install. That is the
; normal case, not the rare one: it is meant to be running. CloseApplications
; alone did not catch it (a tray program with no window does not answer the
; Restart Manager), so name the mutex the program takes at startup
; (src/Program.cs) and let Setup find it before it touches any file.
AppMutex=Local\Multitasker.DeckAgent
CloseApplications=yes
RestartApplications=no
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Files]
Source: "..\publish\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Registry]
; Start at logon. The same value name the program's own 「ログオン時に起動」
; toggle writes (src/Startup.cs), so the two never fight over it.
; uninsdeletevalue: removed by the uninstaller.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyRunValue}"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue

; multitasker:// — how the board's 「この PC をつなぐ」 reaches this program.
; The same four values the program writes for itself on start (src/Protocol.cs).
; uninsdeletekey: the whole class key goes with the uninstall.
Root: HKCU; Subkey: "Software\Classes\{#MyScheme}"; ValueType: string; ValueName: ""; ValueData: "URL:Multitasker"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#MyScheme}"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\{#MyScheme}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"",0"
Root: HKCU; Subkey: "Software\Classes\{#MyScheme}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

; The language chosen on this installer's first page, so the program comes up
; in the language the person already picked instead of guessing from Windows.
; It has to be kept, because guessing was wrong: Windows' display language and
; its region/format settings disagree on this kind of machine (measured
; 2026-09-12: InstalledUICulture=ja-JP, CurrentUICulture=en-GB), and the
; program was reading the latter — Japanese installer, English program.
; {language} is the Name from [Languages] above: "english" or "japanese".
; src/Strings.cs reads this value and nothing else under the key; it never
; writes it, so a copy run without installing leaves no trace.
; uninsdeletevalue on the value, uninsdeletekeyifempty on both keys: the
; uninstaller takes the value, then the now-empty "PC Agent" key, then the
; now-empty "Multitasker" key — in that order, being the reverse of this one.
Root: HKCU; Subkey: "Software\Multitasker"; Flags: uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Multitasker\PC Agent"; ValueType: string; ValueName: "Language"; ValueData: "{language}"; Flags: uninsdeletevalue uninsdeletekeyifempty

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the tray program so its exe can be removed. The settings file is left alone.
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "StopAgent"
