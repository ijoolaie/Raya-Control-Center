$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\scripts\secure-data-acl.ps1'
$scriptPath = [IO.Path]::GetFullPath($scriptPath)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('raya-acl-test-' + [guid]::NewGuid().ToString('N'))
$separateRoot = Join-Path ([IO.Path]::GetTempPath()) ('raya-acl-backup-test-' + [guid]::NewGuid().ToString('N'))
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

    # A file hard-linked outside the selected tree must be rejected before any ACL changes.
    $hardlinkRoot = Join-Path $testRoot 'hardlink-case'
    New-Item -ItemType Directory -Path $hardlinkRoot | Out-Null
    $outsideFile = Join-Path $testRoot 'outside-hardlink-target.bin'
    $insideLink = Join-Path $hardlinkRoot 'linked-file.bin'
    Set-Content -LiteralPath $outsideFile -Value 'outside-the-selected-tree'
    $linkOutput = & $env:ComSpec /d /c ('mklink /H "' + $insideLink + '" "' + $outsideFile + '"') 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('Could not create the disposable hard-link regression fixture: ' + ($linkOutput -join ' ')) }
    $hardlinkRejected = $false
    try { & $scriptPath -Path $hardlinkRoot -Confirm:$false | Out-Null }
    catch { $hardlinkRejected = $_.Exception.Message -match 'multiple hard links' }
    if (-not $hardlinkRejected) { throw 'A file with an external hard link was not rejected.' }
    if ((Get-Acl -LiteralPath $hardlinkRoot).AreAccessRulesProtected) { throw 'ACLs changed despite the hard-link preflight rejection.' }
    if ((Get-Acl -LiteralPath $outsideFile).AreAccessRulesProtected) { throw 'The outside hard-link target ACL changed during preflight.' }
    Remove-Item -LiteralPath $hardlinkRoot -Recurse -Force
    Remove-Item -LiteralPath $outsideFile -Force
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
        if ($acl.Access.Count -ne $expected.Count) { throw ('Unexpected access-rule count on ' + $item.FullName) }
        $expectedInheritance = if ($item.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        } else {
            [Security.AccessControl.InheritanceFlags]::None
        }
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.InheritanceFlags -ne $expectedInheritance -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                throw ('Unexpected access-rule semantics on ' + $item.FullName)
            }
        }
    }
    # A separately configured backup directory must be securable without changing its parent or the data sibling.
    $separateData = Join-Path $separateRoot 'data'
    $separateBackups = Join-Path $separateRoot 'backups'
    New-Item -ItemType Directory -Path $separateRoot | Out-Null
    New-Item -ItemType Directory -Path $separateData,$separateBackups | Out-Null
    Set-Content -LiteralPath (Join-Path $separateData 'live.sqlite') -Value 'separate-disposable-data'
    Set-Content -LiteralPath (Join-Path $separateBackups 'backup.sqlite') -Value 'separate-disposable-backup'
    $parentBefore = (Get-Acl -LiteralPath $separateRoot).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $dataBefore = (Get-Acl -LiteralPath $separateData).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    & $scriptPath -Path $separateBackups -Confirm:$false | Out-Null
    $parentAfter = (Get-Acl -LiteralPath $separateRoot).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $dataAfter = (Get-Acl -LiteralPath $separateData).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if ($parentBefore -ne $parentAfter) { throw 'Securing a separate backup directory changed its parent ACL.' }
    if ($dataBefore -ne $dataAfter) { throw 'Securing a separate backup directory changed the sibling data directory ACL.' }
    foreach ($pathToVerify in @($separateBackups,(Join-Path $separateBackups 'backup.sqlite'))) {
        $acl = Get-Acl -LiteralPath $pathToVerify
        if (-not $acl.AreAccessRulesProtected) { throw ('Separate backup ACL inheritance was not disabled: ' + $pathToVerify) }
        $actual = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
        if (Compare-Object -ReferenceObject $expected -DifferenceObject $actual) { throw ('Unexpected principals on separate backup item ' + $pathToVerify) }
        if ($acl.Access.Count -ne $expected.Count) { throw ('Unexpected access-rule count on separate backup item ' + $pathToVerify) }
        $separateItem = Get-Item -LiteralPath $pathToVerify
        $expectedInheritance = if ($separateItem.PSIsContainer) {
            [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        } else {
            [Security.AccessControl.InheritanceFlags]::None
        }
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.InheritanceFlags -ne $expectedInheritance -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                throw ('Unexpected access-rule semantics on separate backup item ' + $pathToVerify)
            }
        }
    }
    Write-Output 'PASS: locked files, external hard links, WhatIf, and isolated separate-backup ACL scope are safe; only current user, SYSTEM, and local Administrators have access on secured trees.'
    Write-Output 'Verified separate backup directory and file; parent and sibling data ACLs remained unchanged.'
    Write-Output ('Verified items: ' + $items.Count)
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $separateRoot -Recurse -Force -ErrorAction SilentlyContinue
}
