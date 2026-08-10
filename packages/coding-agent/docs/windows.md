# Windows Setup

LYStar requires a Bash-compatible shell for the built-in `bash` Tool. On Windows x64, the installer and first interactive startup provision a LYStar-managed MinGit Bash under `~/.pi/agent/bin/mingit/`; users do not need a system Git installation.

The managed archive is pinned to MinGit `2.55.0.3` and a fixed SHA-256. LYStar downloads from npmmirror first and falls back to the official Git for Windows Release, validates Bash and Git in staging, then replaces the shared managed directory atomically.

Run the bootstrap explicitly with:

```powershell
lc --ensure-windows-bash
```

Use a verified local archive without network access:

```powershell
lc --ensure-windows-bash --archive .\MinGit-2.55.0.3-64-bit.zip --offline
```

Interactive standalone launches open the Windows-only `lystar-terminal.exe` host, which runs the existing TUI through ConPTY and renders it with local xterm.js and Noto Sans CJK assets. Automation remains attached to the invoking terminal. Use `lc --attached` to keep an interactive TUI in PowerShell, CMD, SSH, or an IDE terminal.

`PI_OFFLINE=1` disables implicit downloads. An explicit `shellPath` still overrides the managed shell:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

Without an override, resolution order is:

1. LYStar-managed MinGit Bash
2. Git Bash in known system locations
3. `bash.exe` on PATH

All built-in Bash operations, `!command` config resolution, Git package commands, branch inspection, extension-local Bash operations, and injected Node harness environments receive the same managed MinGit PATH explicitly. They do not depend on the parent PowerShell PATH.
