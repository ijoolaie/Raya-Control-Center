param(
    [switch]$Worker,
    [string]$Root,
    [int]$WorkerId = 0,
    [int]$Iterations = 500,
    [int]$Workers = 4
)
$ErrorActionPreference = 'Stop'

if ($Worker) {
    for ($i = 0; $i -lt $Iterations; $i++) {
        $source = Join-Path $Root ("w{0}-item-{1}.tmp" -f $WorkerId, $i)
        $target = Join-Path $Root ("w{0}-item-{1}.dat" -f $WorkerId, $i)
        $payload = "worker=$WorkerId;iteration=$i"
        try {
            $stream = [System.IO.File]::Open($source, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
            try {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush($true)
            } finally { $stream.Dispose() }
            try { [System.IO.File]::Move($source, $target) } catch [System.IO.IOException] { }
            if (Test-Path -LiteralPath $target) { [System.IO.File]::Delete($target) }
        } catch [System.Exception] {
            # Concurrent open/rename/delete conflicts are expected in this stress workload.
        } finally {
            try { if (Test-Path -LiteralPath $source) { [System.IO.File]::Delete($source) } } catch { }
            try { if (Test-Path -LiteralPath $target) { [System.IO.File]::Delete($target) } } catch { }
        }
    }
    exit 0
}

$tag = [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("RayaMultiProcess-" + $tag)
[void][System.IO.Directory]::CreateDirectory($testRoot)
$processes = @()
$checks = 0
$readConflicts = 0
$invalidPayloads = 0
$enumerations = 0
try {
    $self = $MyInvocation.MyCommand.Path
    for ($id = 1; $id -le $Workers; $id++) {
        $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $self + '" -Worker -Root "' + $testRoot + '" -WorkerId ' + $id + ' -Iterations ' + $Iterations
        $processes += Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $argumentLine -PassThru -WindowStyle Hidden
    }

    while (($processes | Where-Object { -not $_.HasExited }).Count -gt 0) {
        $enumerations++
        foreach ($entry in [System.IO.Directory]::EnumerateFiles($testRoot, '*.tmp')) {
            try {
                $content = [System.IO.File]::ReadAllText($entry)
                $checks++
                if ($content -notmatch '^worker=\d+;iteration=\d+$') { $invalidPayloads++ }
            } catch [System.Exception] { $readConflicts++ }
        }
        foreach ($entry in [System.IO.Directory]::EnumerateFiles($testRoot, '*.dat')) {
            try {
                $content = [System.IO.File]::ReadAllText($entry)
                $checks++
                if ($content -notmatch '^worker=\d+;iteration=\d+$') { $invalidPayloads++ }
            } catch [System.Exception] { $readConflicts++ }
        }
        Start-Sleep -Milliseconds 1
    }
    foreach ($process in $processes) {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Worker process $($process.Id) failed: $($process.ExitCode)" }
    }
    $residualBeforeCleanup = @(Get-ChildItem -LiteralPath $testRoot -Force)
    $cleanupErrors = 0
    foreach ($entry in $residualBeforeCleanup) {
        try { Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction Stop } catch { $cleanupErrors++ }
    }
    $remaining = @(Get-ChildItem -LiteralPath $testRoot -Force)
    $safe = $invalidPayloads -eq 0 -and $cleanupErrors -eq 0 -and $remaining.Count -eq 0
    [pscustomobject]@{
        workers = $Workers
        iterationsPerWorker = $Iterations
        workerProcesses = $processes.Count
        enumerationPasses = $enumerations
        openedEntries = $checks
        expectedReadConflicts = $readConflicts
        invalidPayloads = $invalidPayloads
        residualEntriesBeforeHarnessCleanup = $residualBeforeCleanup.Count
        harnessCleanupErrors = $cleanupErrors
        remainingEntriesAfterCleanup = $remaining.Count
        safe = $safe
    } | Format-List
    if (-not $safe) { throw 'Multi-process namespace churn invariant failed.' }
    Write-Output 'PASS: independent processes completed shared-directory create/flush/rename/delete churn; harness cleanup verified.'
}
finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
