# Windows Setup

LYStar requires a Bash-compatible shell for the built-in `bash` Tool. On Windows x64, the installer and first interactive startup provision a LYStar-managed MinGit Bash under `~/.pi/agent/bin/mingit/`; users do not need a system Git installation.

The managed archive is pinned to MinGit `2.55.0.3` and a fixed SHA-256. LYStar downloads from npmmirror first and falls back to the official Git for Windows Release, validates Bash and Git in staging, then replaces the shared managed directory atomically.

Run the bootstrap explicitly with:

```powershell
la --ensure-windows-bash
```

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
