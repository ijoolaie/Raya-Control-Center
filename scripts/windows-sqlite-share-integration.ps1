param(
  [string]$NodeExe = 'node',
  [string]$WorkerPath = (Join-Path $PSScriptRoot 'windows-sqlite-share-worker.mjs'),
  [switch]$AllowUnsupportedRuntime
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows only.' }
$native = @"
using System;
using System.Runtime.InteropServices;
public static class RayaSqliteShareNative {
  public const uint GENERIC_READ = 0x80000000;
  public const uint FILE_SHARE_READ = 1;
  public const uint OPEN_EXISTING = 3;
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
  public static bool Invalid(IntPtr h) { return h == new IntPtr(-1); }
}
"@
Add-Type -TypeDefinition $native
$nodeCommand = Get-Command $NodeExe -ErrorAction Stop
$NodeExe = $nodeCommand.Source
$version = (& $NodeExe --version).Trim()
$supportedRuntime = $version -match '^v(24|26)\.'
if (-not $supportedRuntime -and -not $AllowUnsupportedRuntime) {
  throw "Unsupported runtime $version; -AllowUnsupportedRuntime is for exploratory diagnostics only."
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('raya-sqlite-share-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
$worker = $null
function Assert-Result([string]$Name,[bool]$Ok,[string]$Detail) {
  $results.Add([pscustomobject]@{Name=$Name;Passed=$Ok;Detail=$Detail})
  if (-not $Ok) { throw "SQLite share probe failed: $Name ($Detail)" }
}
function Start-SqliteWorker([string]$DbPath) {
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $NodeExe
  $psi.Arguments = '"' + $WorkerPath.Replace('"','\"') + '" "' + $DbPath.Replace('"','\"') + '"'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  return [Diagnostics.Process]::Start($psi)
}
try {
  $db = Join-Path $root 'sqlite-first.db'
  $worker = Start-SqliteWorker $db
  $line = $worker.StandardOutput.ReadLine()
  if (-not $line) {
    $worker.WaitForExit(5000) | Out-Null
    throw "SQLite worker exited without readiness output: $($worker.StandardError.ReadToEnd())"
  }
  $ready = $line | ConvertFrom-Json
  Assert-Result 'sqlite-worker-ready' ($ready.state -eq 'READY') $line
  Assert-Result 'supported-node-major-or-explicit-exploratory' ($supportedRuntime -or $AllowUnsupportedRuntime.IsPresent) "node=$version exploratory=$($AllowUnsupportedRuntime.IsPresent)"
  foreach ($role in @(@{Name='main';Path=$db},@{Name='wal';Path=($db+'-wal')},@{Name='shm';Path=($db+'-shm')})) {
    if (-not (Test-Path -LiteralPath $role.Path)) {
      Assert-Result "sqlite-$($role.Name)-handle-present" $false 'file absent while SQLite worker holds connection'
      continue
    }
    $h = [RayaSqliteShareNative]::CreateFileW($role.Path,[RayaSqliteShareNative]::GENERIC_READ,[RayaSqliteShareNative]::FILE_SHARE_READ,[IntPtr]::Zero,[RayaSqliteShareNative]::OPEN_EXISTING,0,[IntPtr]::Zero)
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $blocked = [RayaSqliteShareNative]::Invalid($h)
    Assert-Result "sqlite-$($role.Name)-restrictive-open-blocked" ($blocked -and $err -eq 32) "blocked=$blocked win32=$err"
    if (-not $blocked) { [RayaSqliteShareNative]::CloseHandle($h) | Out-Null }
  }
  $worker.StandardInput.WriteLine('CLOSE')
  $worker.WaitForExit()
  Assert-Result 'sqlite-worker-clean-close' ($worker.ExitCode -eq 0) "exit=$($worker.ExitCode)"
  $worker = $null

  $db2 = Join-Path $root 'guard-first.db'
  [IO.File]::WriteAllBytes($db2,[byte[]](1,2,3,4))
  $guard = [RayaSqliteShareNative]::CreateFileW($db2,[RayaSqliteShareNative]::GENERIC_READ,[RayaSqliteShareNative]::FILE_SHARE_READ,[IntPtr]::Zero,[RayaSqliteShareNative]::OPEN_EXISTING,0,[IntPtr]::Zero)
  if ([RayaSqliteShareNative]::Invalid($guard)) { throw "Could not acquire restrictive guard: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  try {
    $blockedWorker = Start-SqliteWorker $db2
    $output = $blockedWorker.StandardOutput.ReadLine()
    $blockedWorker.WaitForExit(15000) | Out-Null
    Assert-Result 'restrictive-guard-blocks-sqlite-open' (($blockedWorker.ExitCode -ne 0) -and $output -match '"state":"OPEN_ERROR"') "exit=$($blockedWorker.ExitCode) output=$output"
  } finally {
    [RayaSqliteShareNative]::CloseHandle($guard) | Out-Null
  }
  $passed = @($results | Where-Object Passed).Count
  $failed = @($results | Where-Object { -not $_.Passed }).Count
  "RESULT: PASS ($passed assertions; $failed failures; node=$version; sqlite=$($ready.sqlite); OS=$([Environment]::OSVersion.Version); exploratory=$($AllowUnsupportedRuntime.IsPresent))"
}
finally {
  if ($worker -and -not $worker.HasExited) {
    $worker.StandardInput.WriteLine('CLOSE')
    if (-not $worker.WaitForExit(5000)) { $worker.Kill() }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}