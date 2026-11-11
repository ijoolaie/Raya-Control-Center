[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Path
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This ACL helper is Windows-only.' }

$target = [IO.Path]::GetFullPath($Path)
$volumeRoot = [IO.Path]::GetPathRoot($target)
if ($target.TrimEnd('\') -eq $volumeRoot.TrimEnd('\')) {
    throw 'Refusing to change ACLs on a volume root.'
}
if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    throw 'Data directory does not exist. Create it first; this script never creates or guesses a data path.'
}

# Reject reparse points in the path itself and anywhere below it. Do not follow junctions or symlinks.
$ancestor = [IO.DirectoryInfo]$target
while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('Data path traverses a reparse point: ' + $ancestor.FullName)
    }
    $ancestor = $ancestor.Parent
}

$directories = [Collections.Generic.List[IO.DirectoryInfo]]::new()
$files = [Collections.Generic.List[IO.FileInfo]]::new()
$pending = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
$pending.Push([IO.DirectoryInfo]$target)
while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    $directories.Add($directory)
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory.FullName)) {
        $attributes = [IO.File]::GetAttributes($entry)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ('Data directory contains a reparse point; refusing partial ACL changes: ' + $entry)
        }
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
            $pending.Push([IO.DirectoryInfo]$entry)
        } else {
            $files.Add([IO.FileInfo]$entry)
        }
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RayaControlCenterDaclNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation {
        public uint FileAttributes;
        public uint CreationTimeLow;
        public uint CreationTimeHigh;
        public uint LastAccessTimeLow;
        public uint LastAccessTimeHigh;
        public uint LastWriteTimeLow;
        public uint LastWriteTimeHigh;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "SetFileSecurityW")]
    public static extern bool SetFileSecurity(string path, uint securityInformation, byte[] securityDescriptor);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetFileInformationByHandle")]
    public static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, out ByHandleFileInformation information);
}
'@
# An exclusive read open catches files currently held open by a process before changing any ACL.
foreach ($file in $files) {
    $stream = $null
    try {
        $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        $fileInformation = [RayaControlCenterDaclNative+ByHandleFileInformation]::new()
        if (-not [RayaControlCenterDaclNative]::GetFileInformationByHandle($stream.SafeFileHandle, [ref]$fileInformation)) {
            $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw (New-Object ComponentModel.Win32Exception($code))
        }
        if ($fileInformation.NumberOfLinks -ne 1) {
            throw ('Refusing a file with multiple hard links; remove the external link or choose a dedicated data directory: ' + $file.FullName)
        }
    } catch {
        if ($_.Exception.Message -match 'multiple hard links') { throw }
        throw ('Cannot obtain an exclusive read handle or inspect it safely; stop the server/workers and close this file first: ' + $file.FullName + '. ' + $_.Exception.Message)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

if (-not $PSCmdlet.ShouldProcess($target, 'Restrict data files to the current user, SYSTEM, and local Administrators')) {
    return
}

$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$principals = @($userSid, $systemSid, $administratorsSid)

function Set-DaclOnlySecurityDescriptor {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$Sddl,
        [Parameter(Mandatory = $true)][bool]$IsDirectory,
        [Parameter(Mandatory = $true)][bool]$IsProtected
    )
    $descriptor = if ($IsDirectory) {
        [Security.AccessControl.DirectorySecurity]::new()
    } else {
        [Security.AccessControl.FileSecurity]::new()
    }
    $descriptor.SetSecurityDescriptorSddlForm($Sddl, [Security.AccessControl.AccessControlSections]::Access)
    $securityInformation = [uint32]4 # DACL_SECURITY_INFORMATION
    if ($IsProtected) { $securityInformation = [uint32]2147483652 } # PROTECTED_DACL_SECURITY_INFORMATION | DACL
    else { $securityInformation = [uint32]536870916 } # UNPROTECTED_DACL_SECURITY_INFORMATION | DACL
    if (-not [RayaControlCenterDaclNative]::SetFileSecurity($LiteralPath, $securityInformation, $descriptor.GetSecurityDescriptorBinaryForm())) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw (New-Object ComponentModel.Win32Exception($code))
    }
}

function Get-DaclSnapshot {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $current = Get-Acl -LiteralPath $LiteralPath
    return [pscustomobject]@{
        Sddl = $current.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
        IsProtected = $current.AreAccessRulesProtected
    }
}

function Set-RestrictedAcl {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][bool]$IsDirectory
    )
    $current = Get-Acl -LiteralPath $LiteralPath
    $sddl = $current.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $acl = if ($IsDirectory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access)
    # Discard inherited and explicit access entries, then add only the three trusted principals.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
        [void]$acl.RemoveAccessRuleSpecific($existingRule)
    }
    $inheritance = if ($IsDirectory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($principal in $principals) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $principal,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    $restrictedSddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    Set-DaclOnlySecurityDescriptor -LiteralPath $LiteralPath -Sddl $restrictedSddl -IsDirectory $IsDirectory -IsProtected $true

    $verified = Get-Acl -LiteralPath $LiteralPath
    if (-not $verified.AreAccessRulesProtected) {
        throw ('ACL inheritance remained enabled: ' + $LiteralPath)
    }
    $actualSids = @($verified.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
    $expectedSids = @($principals | ForEach-Object { $_.Value } | Sort-Object -Unique)
    if (Compare-Object -ReferenceObject $expectedSids -DifferenceObject $actualSids) {
        throw ('Unexpected ACL principals remain on: ' + $LiteralPath)
    }
}

# Capture original descriptors before the first write so a failed application can be rolled back.
$targets = @()
foreach ($directory in $directories) { $targets += [pscustomobject]@{ Path = $directory.FullName; IsDirectory = $true } }
foreach ($file in $files) { $targets += [pscustomobject]@{ Path = $file.FullName; IsDirectory = $false } }
$originalAcls = @{}
$targetByPath = @{}
foreach ($item in $targets) {
    $originalAcls[$item.Path] = Get-DaclSnapshot -LiteralPath $item.Path
    $targetByPath[$item.Path] = $item
}
$changed = [Collections.Generic.List[string]]::new()
try {
    foreach ($item in $targets) {
        $changed.Add($item.Path)
        Set-RestrictedAcl -LiteralPath $item.Path -IsDirectory $item.IsDirectory
    }
} catch {
    $applyError = $_
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    for ($index = $changed.Count - 1; $index -ge 0; $index--) {
        $changedPath = $changed[$index]
        try {
            $item = $targetByPath[$changedPath]
            $snapshot = $originalAcls[$changedPath]
            Set-DaclOnlySecurityDescriptor -LiteralPath $changedPath -Sddl $snapshot.Sddl -IsDirectory $item.IsDirectory -IsProtected $snapshot.IsProtected
        } catch { $rollbackErrors.Add($changedPath + ': ' + $_.Exception.Message) }
    }
    if ($rollbackErrors.Count -gt 0) {
        throw ('ACL update failed and rollback was incomplete. Original error: ' + $applyError.Exception.Message + '. Rollback errors: ' + ($rollbackErrors -join ' | '))
    }
    throw ('ACL update failed; original ACLs were restored. ' + $applyError.Exception.Message)
}

[pscustomobject]@{
    DataDirectory = $target
    DirectoriesSecured = $directories.Count
    FilesSecured = $files.Count
    AllowedPrincipals = @($userSid.Value, $systemSid.Value, $administratorsSid.Value)
    Inheritance = 'Disabled on each secured item'
}

