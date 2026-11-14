param(
    [string]$ChildProbePath,
    [uint32]$ChildDesiredAccess = 0,
    [uint32]$ChildShareMode = 7
)
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This probe must run on Windows.'
}

$native = @"
using System;
using System.Runtime.InteropServices;

public static class RayaWindowsShareProbe {
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint DELETE_ACCESS = 0x00010000;
    public const uint OPEN_EXISTING = 3;
    public const uint FILE_SHARE_READ = 1;
    public const uint FILE_SHARE_WRITE = 2;
    public const uint FILE_SHARE_DELETE = 4;
    public const uint MOVEFILE_REPLACE_EXISTING = 1;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(
        string fileName, uint desiredAccess, uint shareMode,
        IntPtr securityAttributes, uint creationDisposition,
        uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveFileExW(string existingName, string newName, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteFileW(string fileName);

    public static IntPtr Open(string path, uint access, uint share) {
        return CreateFileW(path, access, share, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    }

    public static bool IsInvalid(IntPtr handle) {
        return handle == new IntPtr(-1);
    }

    public static string ShareName(uint share) {
        return ((share & FILE_SHARE_READ) != 0 ? "R" : "-") +
               ((share & FILE_SHARE_WRITE) != 0 ? "W" : "-") +
               ((share & FILE_SHARE_DELETE) != 0 ? "D" : "-");
    }
}
"@

Add-Type -TypeDefinition $native -ErrorAction Stop

if ($ChildProbePath) {
    $childHandle = [RayaWindowsShareProbe]::Open($ChildProbePath, $ChildDesiredAccess, $ChildShareMode)
    if ([RayaWindowsShareProbe]::IsInvalid($childHandle)) {
        "OPEN_FAIL:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    else {
        [RayaWindowsShareProbe]::CloseHandle($childHandle) | Out-Null
        'OPEN_OK'
    }
    exit 0
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("raya-win-share-probe-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$checks = [System.Collections.Generic.List[object]]::new()

function Assert-Probe([string]$Name, [bool]$Condition, [string]$Detail) {
    $checks.Add([pscustomobject]@{ Name = $Name; Passed = $Condition; Detail = $Detail })
    if (-not $Condition) {
        throw "Probe assertion failed: $Name ($Detail)"
    }
}

try {
    $shareMasks = 0..7
    $accessCases = @(
        @{ Name = 'read'; Access = [RayaWindowsShareProbe]::GENERIC_READ; RequiredShare = [RayaWindowsShareProbe]::FILE_SHARE_READ },
        @{ Name = 'write'; Access = [RayaWindowsShareProbe]::GENERIC_WRITE; RequiredShare = [RayaWindowsShareProbe]::FILE_SHARE_WRITE },
        @{ Name = 'read-write'; Access = ([RayaWindowsShareProbe]::GENERIC_READ -bor [RayaWindowsShareProbe]::GENERIC_WRITE); RequiredShare = ([RayaWindowsShareProbe]::FILE_SHARE_READ -bor [RayaWindowsShareProbe]::FILE_SHARE_WRITE) }
    )

    foreach ($accessCase in $accessCases) {
        foreach ($existingShare in $shareMasks) {
            foreach ($candidateShare in $shareMasks) {
                $path = Join-Path $root 'matrix.bin'
                [IO.File]::WriteAllBytes($path, [byte[]](1,2,3,4))
                $first = [RayaWindowsShareProbe]::Open($path, [uint32]$accessCase.Access, [uint32]$existingShare)
                if ([RayaWindowsShareProbe]::IsInvalid($first)) {
                    throw "Initial open failed unexpectedly: $($accessCase.Name), share=$existingShare, error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
                }
                try {
                    $second = [RayaWindowsShareProbe]::Open($path, [uint32]$accessCase.Access, [uint32]$candidateShare)
                    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    $actual = -not [RayaWindowsShareProbe]::IsInvalid($second)
                    $expected = (($existingShare -band $accessCase.RequiredShare) -eq $accessCase.RequiredShare) -and (($candidateShare -band $accessCase.RequiredShare) -eq $accessCase.RequiredShare)
                    Assert-Probe "$($accessCase.Name):$existingShare->$candidateShare" ($actual -eq $expected) "actual=$actual expected=$expected win32=$errorCode"
                    if ($actual) {
                        [RayaWindowsShareProbe]::CloseHandle($second) | Out-Null
                    }
                }
                finally {
                    [RayaWindowsShareProbe]::CloseHandle($first) | Out-Null
                }
            }
        }
    }

    # A permissive pre-existing writer remains open; a later restrictive open cannot revoke it.
    $path = Join-Path $root 'preexisting-writer.bin'
    [IO.File]::WriteAllBytes($path, [byte[]](1,2,3,4))
    $writer = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_WRITE, 7)
    if ([RayaWindowsShareProbe]::IsInvalid($writer)) { throw 'Could not create pre-existing writer handle.' }
    try {
        $restrictive = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_READ, [RayaWindowsShareProbe]::FILE_SHARE_READ)
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Assert-Probe 'pre-existing-writer-not-revoked' ([RayaWindowsShareProbe]::IsInvalid($restrictive)) "expected sharing violation; win32=$errorCode"
        if (-not [RayaWindowsShareProbe]::IsInvalid($restrictive)) {
            [RayaWindowsShareProbe]::CloseHandle($restrictive) | Out-Null
        }
        $oneByte = [byte[]](0)
        $written = [IO.File]::WriteAllBytes
        # Verify the pre-existing handle remains valid by opening a compatible writer.
        $compatible = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_WRITE, 7)
        Assert-Probe 'pre-existing-writer-still-compatible' (-not [RayaWindowsShareProbe]::IsInvalid($compatible)) 'second compatible writer should open'
        if (-not [RayaWindowsShareProbe]::IsInvalid($compatible)) {
            [RayaWindowsShareProbe]::CloseHandle($compatible) | Out-Null
        }
    }
    finally {
        [RayaWindowsShareProbe]::CloseHandle($writer) | Out-Null
    }

    # A retained handle that omits FILE_SHARE_WRITE rejects a later writer.
    $path = Join-Path $root 'restrictive-first.bin'
    [IO.File]::WriteAllBytes($path, [byte[]](1,2,3,4))
    $guard = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_READ, [RayaWindowsShareProbe]::FILE_SHARE_READ)
    if ([RayaWindowsShareProbe]::IsInvalid($guard)) { throw 'Could not create restrictive guard handle.' }
    try {
        $laterWriter = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_WRITE, 7)
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Assert-Probe 'restrictive-handle-blocks-later-writer' ([RayaWindowsShareProbe]::IsInvalid($laterWriter)) "expected sharing violation; win32=$errorCode"
        if (-not [RayaWindowsShareProbe]::IsInvalid($laterWriter)) {
            [RayaWindowsShareProbe]::CloseHandle($laterWriter) | Out-Null
        }
    }
    finally {
        [RayaWindowsShareProbe]::CloseHandle($guard) | Out-Null
    }

    # Cross-process checks: a child process must observe the same share compatibility.
    $childPowerShell = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $childPowerShell)) { throw 'Windows PowerShell child executable not found.' }

    function Invoke-ChildOpen([string]$ChildPath, [uint32]$DesiredAccess, [uint32]$ShareMode) {
        $childOutput = & $childPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -ChildProbePath $ChildPath -ChildDesiredAccess $DesiredAccess -ChildShareMode $ShareMode 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Child probe failed: exit=$LASTEXITCODE output=$childOutput" }
        return ($childOutput | Out-String).Trim()
    }

    $path = Join-Path $root 'cross-process-restrictive-parent.bin'
    [IO.File]::WriteAllBytes($path, [byte[]](1,2,3,4))
    $parentGuard = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_READ, [RayaWindowsShareProbe]::FILE_SHARE_READ)
    if ([RayaWindowsShareProbe]::IsInvalid($parentGuard)) { throw 'Could not open cross-process restrictive parent handle.' }
    try {
        $childResult = Invoke-ChildOpen $path ([RayaWindowsShareProbe]::GENERIC_WRITE) 7
        Assert-Probe 'cross-process-restrictive-handle-blocks-writer' ($childResult -eq 'OPEN_FAIL:32') "child=$childResult"
    }
    finally {
        [RayaWindowsShareProbe]::CloseHandle($parentGuard) | Out-Null
    }

    $path = Join-Path $root 'cross-process-preexisting-writer.bin'
    [IO.File]::WriteAllBytes($path, [byte[]](1,2,3,4))
    $parentWriter = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_WRITE, 7)
    if ([RayaWindowsShareProbe]::IsInvalid($parentWriter)) { throw 'Could not open cross-process permissive writer.' }
    try {
        $childResult = Invoke-ChildOpen $path ([RayaWindowsShareProbe]::GENERIC_READ) ([RayaWindowsShareProbe]::FILE_SHARE_READ)
        Assert-Probe 'cross-process-preexisting-writer-rejects-restrictive-open' ($childResult -eq 'OPEN_FAIL:32') "child=$childResult"
        $childResult = Invoke-ChildOpen $path ([RayaWindowsShareProbe]::GENERIC_WRITE) 7
        Assert-Probe 'cross-process-compatible-writer-open' ($childResult -eq 'OPEN_OK') "child=$childResult"
    }
    finally {
        [RayaWindowsShareProbe]::CloseHandle($parentWriter) | Out-Null
    }
    # Rename/delete requires the retained handle to share delete.
    foreach ($shareDelete in @($false, $true)) {
        $path = Join-Path $root ("rename-" + $shareDelete + ".bin")
        $moved = Join-Path $root ("renamed-" + $shareDelete + ".bin")
        [IO.File]::WriteAllBytes($path, [byte[]](1,2,3,4))
        $share = [uint32]([RayaWindowsShareProbe]::FILE_SHARE_READ -bor [RayaWindowsShareProbe]::FILE_SHARE_WRITE)
        if ($shareDelete) { $share = $share -bor [RayaWindowsShareProbe]::FILE_SHARE_DELETE }
        $handle = [RayaWindowsShareProbe]::Open($path, [RayaWindowsShareProbe]::GENERIC_READ, $share)
        if ([RayaWindowsShareProbe]::IsInvalid($handle)) { throw "Could not open rename probe handle: $shareDelete" }
        try {
            $renamed = [RayaWindowsShareProbe]::MoveFileExW($path, $moved, 0)
            $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Assert-Probe "rename-share-delete-$shareDelete" ($renamed -eq $shareDelete) "actual=$renamed expected=$shareDelete win32=$errorCode"
        }
        finally {
            [RayaWindowsShareProbe]::CloseHandle($handle) | Out-Null
        }

        $deletePath = Join-Path $root ("delete-" + $shareDelete + ".bin")
        [IO.File]::WriteAllBytes($deletePath, [byte[]](1,2,3,4))
        $deleteHandle = [RayaWindowsShareProbe]::Open($deletePath, [RayaWindowsShareProbe]::GENERIC_READ, $share)
        if ([RayaWindowsShareProbe]::IsInvalid($deleteHandle)) { throw "Could not open delete probe handle: $shareDelete" }
        try {
            $deleted = [RayaWindowsShareProbe]::DeleteFileW($deletePath)
            $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Assert-Probe "delete-share-delete-$shareDelete" ($deleted -eq $shareDelete) "actual=$deleted expected=$shareDelete win32=$errorCode"
        }
        finally {
            [RayaWindowsShareProbe]::CloseHandle($deleteHandle) | Out-Null
        }
    }

    $passed = @($checks | Where-Object Passed).Count
    $failed = @($checks | Where-Object { -not $_.Passed }).Count
    "RESULT: PASS ($passed assertions; $failed failures; 192 access/share combinations; same-process and cross-process pre-existing-handle/writer-ordering, rename, and delete checks)"
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
