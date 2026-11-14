param(
    [ValidateRange(1, 100)]
    [int]$Runs = 10
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'experiments\windows-native-handle-adapter.cpp'
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vsRoot = Join-Path $programFilesX86 'Microsoft Visual Studio\18\BuildTools'
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'

if (-not (Test-Path $source)) { throw "Probe source not found: $source" }
if (-not (Test-Path $vcvars)) {
    $candidate = Get-ChildItem (Join-Path $programFilesX86 'Microsoft Visual Studio') -Filter 'vcvars64.bat' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $candidate) { throw 'MSVC x64 build environment (vcvars64.bat) was not found.' }
    $vcvars = $candidate.FullName
}

$tag = [Guid]::NewGuid().ToString('N')
$exe = Join-Path $env:TEMP "raya-windows-native-adapter-$tag.exe"
$obj = Join-Path $env:TEMP "raya-windows-native-adapter-$tag.obj"

try {
    $build = [char]34 + $vcvars + [char]34 + ' >nul && cl.exe /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE ' + [char]34 + $source + [char]34 + ' /Fo:' + [char]34 + $obj + [char]34 + ' /Fe:' + [char]34 + $exe + [char]34 + ' /link bcrypt.lib'
    & cmd.exe /d /s /c $build
    if ($LASTEXITCODE -ne 0) { throw "MSVC compilation failed with exit code $LASTEXITCODE" }

    for ($i = 1; $i -le $Runs; $i++) {
        Write-Output "--- Native adapter prototype run $i/$Runs ---"
        & $exe
        if ($LASTEXITCODE -ne 0) { throw "Native adapter prototype failed on run $i (exit $LASTEXITCODE)" }
    }
    Write-Output "PASS: $Runs native probe runs completed."
}
finally {
    Remove-Item $exe, $obj -Force -ErrorAction SilentlyContinue
}
