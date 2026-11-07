$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\scripts\secure-data-acl.ps1'
$scriptPath = [IO.Path]::GetFullPath($scriptPath)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('raya-acl-test-' + [guid]::NewGuid().ToString('N'))
$nested = Join-Path $testRoot 'nested'
$backupDir = Join-Path $testRoot 'backups'
New-Item -ItemType Directory -Force $nested,$backupDir | Out-Null
$dbFile = Join-Path $testRoot 'control-center.sqlite'
Set-Content -LiteralPath $dbFile -Value 'disposable-test-db'
Set-Content -LiteralPath (Join-Path $testRoot 'control-center.sqlite-wal') -Value 'disposable-test-wal'
Set-Content -LiteralPath (Join-Path $backupDir 'backup.sqlite') -Value 'disposable-test-backup'
Set-Content -LiteralPath (Join-Path $nested 'nested-file.bin') -Value 'disposable-test-nested'
try {
    # A locked file must stop the operation before any ACL is changed.
    $lock = [IO.File]::Open($dbFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $lockedRejected = $false
        try { & $scriptPath -Path $testRoot -Confirm:$false | Out-Null }
        catch { $lockedRejected = $_.Exception.Message -match 'exclusive read handle' }
        if (-not $lockedRejected) { throw 'An open database file was not rejected.' }
        if ((Get-Acl -LiteralPath $testRoot).AreAccessRulesProtected) { throw 'ACLs changed despite the open-file preflight failure.' }
    } finally { $lock.Dispose() }

    # WhatIf must leave the inherited DACL untouched.
    & $scriptPath -Path $testRoot -WhatIf | Out-Null
    if ((Get-Acl -LiteralPath $testRoot).AreAccessRulesProtected) { throw 'WhatIf changed the data directory ACL.' }

    & $scriptPath -Path $testRoot -Confirm:$false | Out-Null
    $expected = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544') | Sort-Object -Unique
    $paths = @($testRoot,$nested,$backupDir,$dbFile,(Join-Path $testRoot 'control-center.sqlite-wal'),(Join-Path $backupDir 'backup.sqlite'),(Join-Path $nested 'nested-file.bin'))
    $items = @($paths | ForEach-Object { Get-Item -LiteralPath $_ })
    foreach ($item in $items) {
        $acl = Get-Acl -LiteralPath $item.FullName
        if (-not $acl.AreAccessRulesProtected) { throw ('Inheritance was not disabled: ' + $item.FullName) }
        $actual = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
        if (Compare-Object -ReferenceObject $expected -DifferenceObject $actual) { throw ('Unexpected principals on ' + $item.FullName + ': ' + ($actual -join ', ')) }
    }
    Write-Output 'PASS: locked files and WhatIf are safe; only current user, SYSTEM, and local Administrators have access on the secured test tree.'
    Write-Output ('Verified items: ' + $items.Count)
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
