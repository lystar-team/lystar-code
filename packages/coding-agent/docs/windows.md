# Run Pi on Windows

LYStar requires a Bash-compatible shell for the built-in `bash` Tool. On Windows x64, the installer and first interactive startup provision a LYStar-managed MinGit Bash under `~/.pi/agent/bin/mingit/`; users do not need a system Git installation.

Pi uses Git Bash by default on Windows. Checked locations (in order):

Follow the main [Quickstart](quickstart.md) to install and authenticate Pi. Use this page to choose and configure its command environment.

## Choose native Windows or WSL

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


## PowerShell Tool

## Use Git Bash on native Windows

For most native Windows users, installing [Git for Windows](https://git-scm.com/download/win) is sufficient.

Pi resolves Bash in this order:

1. `shellPath` from `~/.pi/agent/settings.json`
2. Git Bash at `%ProgramFiles%\Git\bin\bash.exe`
3. Git Bash at `%ProgramFiles(x86)%\Git\bin\bash.exe`
4. `bash.exe` on `PATH`, including Cygwin, MSYS2, or legacy WSL Bash

Start Pi and enter this command to verify the shell:

```text
!printf 'Bash is working\n'
```

If Pi cannot find Bash, it reports the locations it checked. Install Git for Windows, put another Bash executable on `PATH`, or configure `shellPath`.

## Let the model use PowerShell

The optional `powershell` tool runs commands through `pwsh.exe` when available, then falls back to Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

PowerShell discovery checks these locations in order:

1. `pwsh.exe` on `PATH`
2. `%ProgramFiles%\PowerShell\7\pwsh.exe`
3. `powershell.exe` on `PATH`
4. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

Use `defaultTools` to enable PowerShell alongside the built-in tools. To replace the model-facing `bash` tool with `powershell`, add this to `~/.pi/agent/settings.json`:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

`["-bash", "+powershell"]` does the same while keeping any other default tools you configured.

Restart Pi, then ask it to run a harmless PowerShell command. The `!` and `!!` editor commands continue to use Bash. The `powershell` tool is available only when Pi runs as a native Windows process.

See [Settings](settings.md#tools) for other tool combinations.

`PI_OFFLINE=1` disables implicit downloads. An explicit `shellPath` still overrides the managed shell:

## WSL

WSL path conversion on Windows and extra Git branch polling in WSL recognize `/mnt/<drive>`, not custom mount roots.

When using the legacy WSL `bash.exe` launcher from Windows, Pi sends commands over stdin to avoid command-line quoting problems.

## Use a custom Bash executable

Set `shellPath` when Bash is installed somewhere Pi does not discover automatically:

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

## Choose a terminal

Windows terminals run Pi through a console host (conhost). Some bundle an up-to-date copy; others use the older one built into Windows, which has bugs that affect Pi.

We recommend [Windows Terminal](https://aka.ms/terminal). It always ships an up-to-date conhost, and Pi is best tested with it.

Last updated: October 2026.

| Terminal | Conhost | Status |
|---|---|---|
| [Windows Terminal](https://aka.ms/terminal) | Bundled, current | Recommended |
| [VS Code](https://code.visualstudio.com), [Tabby](https://tabby.sh), [WezTerm](https://wezterm.org) nightly | Bundled, current | Works |
| [Alacritty](https://alacritty.org) | Built-in, unless `conpty.dll` and `OpenConsole.exe` from Windows Terminal are next to `alacritty.exe` | Works only with those files |
| WezTerm 20240203 and older | Bundled, old | [Known issues](#known-issues) |
| Classic console (`cmd.exe` or PowerShell without Windows Terminal), mintty (Git Bash), ConEmu, Cmder, [Hyper](https://hyper.is), Windows OpenSSH | Built-in | [Known issues](#known-issues) |

## Configure Windows Terminal

Windows Terminal reserves or rewrites some modified keys. See [Windows Terminal](terminal-setup.md#windows-terminal) to configure `Shift+Enter` and `Alt+Enter`, and [Keybindings](keybindings.md) for Pi's Windows and WSL shortcut defaults.

## Known issues

These issues come from conhost. Microsoft has fixed them in its source, but has not said when the built-in conhost will get the fixes.

| Issue | Affects | Remedy |
|---|---|---|
| Switching from fullscreen to regular mode, or `Ctrl+G` from fullscreen, crashes the session ([#9186](https://github.com/earendil-works/pi/issues/9186), [microsoft/terminal#17515](https://github.com/microsoft/terminal/issues/17515)) | Built-in conhost | Use a terminal with a current conhost, or start Pi with `--tui-mode regular` |
| Text such as `;0;rgb:0000/0000/0000` appears in the prompt, and BEL opens the external editor ([#10256](https://github.com/earendil-works/pi/issues/10256)) | Built-in conhost behind another terminal: mintty, Windows OpenSSH | Use a terminal with a current conhost |
| Fragments such as `79` or `55` appear in the prompt ([#10717](https://github.com/earendil-works/pi/issues/10717)) | WezTerm 20240203 | Use WezTerm nightly |
| In regular mode, each keystroke redraws the input line on a new row ([#6300](https://github.com/earendil-works/pi/issues/6300)) | Built-in conhost, classic console | Use fullscreen mode (the default), or a terminal with a current conhost |
