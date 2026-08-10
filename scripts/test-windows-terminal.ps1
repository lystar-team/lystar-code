param(
    [Parameter(Mandatory = $true)][string]$BundleDir,
    [string]$ScreenshotPath = ""
)

$ErrorActionPreference = "Stop"
$BundleDir = [IO.Path]::GetFullPath($BundleDir)
$HostExecutable = Join-Path $BundleDir "lystar-terminal.exe"
$CodeExecutable = Join-Path $BundleDir "lc.exe"
if (!(Test-Path $HostExecutable) -or !(Test-Path $CodeExecutable)) { throw "Windows terminal bundle is incomplete: $BundleDir" }

$SmokeProcess = Start-Process -FilePath $HostExecutable -ArgumentList "--smoke-test" -Wait -PassThru
if ($SmokeProcess.ExitCode -ne 0) { throw "Terminal host smoke test failed: $($SmokeProcess.ExitCode)" }

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LYStarTerminalTestNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@

$Process = Start-Process -FilePath $HostExecutable -ArgumentList "--windows-terminal-ui-smoke" -PassThru
try {
    $Handle = [IntPtr]::Zero
    for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
        Start-Sleep -Milliseconds 100
        $Process.Refresh()
        $Handle = $Process.MainWindowHandle
        if ($Handle -ne [IntPtr]::Zero) { break }
    }
    if ($Handle -eq [IntPtr]::Zero) { throw "Terminal host did not create a window." }

    [void][LYStarTerminalTestNative]::MoveWindow($Handle, 80, 80, 1000, 700, $true)
    Start-Sleep -Seconds 2

    $Rect = New-Object LYStarTerminalTestNative+RECT
    if (![LYStarTerminalTestNative]::GetWindowRect($Handle, [ref]$Rect)) { throw "Unable to read terminal window bounds." }
    $Width = $Rect.Right - $Rect.Left
    $Height = $Rect.Bottom - $Rect.Top
    if ($Width -lt 800 -or $Height -lt 500) { throw "Terminal window did not resize: ${Width}x${Height}" }

    $Bitmap = New-Object Drawing.Bitmap $Width, $Height
    $Graphics = [Drawing.Graphics]::FromImage($Bitmap)
    try {
        $Graphics.CopyFromScreen($Rect.Left, $Rect.Top, 0, 0, $Bitmap.Size)
    }
    finally {
        $Graphics.Dispose()
    }
    if (!$ScreenshotPath) { $ScreenshotPath = Join-Path $BundleDir "windows-terminal-smoke.png" }
    $ScreenshotPath = [IO.Path]::GetFullPath($ScreenshotPath)
    $Bitmap.Save($ScreenshotPath, [Drawing.Imaging.ImageFormat]::Png)

    $Colors = New-Object 'System.Collections.Generic.HashSet[int]'
    for ($Y = 0; $Y -lt $Height; $Y += 20) {
        for ($X = 0; $X -lt $Width; $X += 20) {
            [void]$Colors.Add($Bitmap.GetPixel($X, $Y).ToArgb())
        }
    }
    $Bitmap.Dispose()
    if ($Colors.Count -lt 3) { throw "Terminal screenshot is blank or monochrome: $ScreenshotPath" }

    if (![LYStarTerminalTestNative]::PostMessage($Handle, 0x8003, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw "Unable to send terminal smoke input."
    }
    if (!$Process.WaitForExit(15000)) { throw "Terminal host did not exit after receiving smoke input." }
    if ($Process.ExitCode -ne 0) { throw "Terminal host exited with $($Process.ExitCode)." }

    foreach ($Executable in @($CodeExecutable, $HostExecutable)) {
        $Icon = [Drawing.Icon]::ExtractAssociatedIcon($Executable)
        if (!$Icon -or $Icon.Width -lt 16) { throw "Missing executable icon: $Executable" }
        $Icon.Dispose()
    }
    Write-Host "Windows terminal window, resize, screenshot, ConPTY input/exit, and icons passed: $ScreenshotPath"
}
finally {
    if (!$Process.HasExited) { $Process.Kill() }
}