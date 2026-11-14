$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'experiments\windows-directory-flush-contract-probe.cpp'
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vsRoot = Join-Path $programFilesX86 'Microsoft Visual Studio\18\BuildTools'
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "MSVC x64 environment not found: $vcvars" }
$tag = [Guid]::NewGuid().ToString('N')
$exe = Join-Path $env:TEMP "raya-directory-flush-contract-$tag.exe"
$obj = Join-Path $env:TEMP "raya-directory-flush-contract-$tag.obj"
try {
    $build = '"' + $vcvars + '" >nul && cl.exe /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE "' + $source + '" /Fo:"' + $obj + '" /Fe:"' + $exe + '"'
    & cmd.exe /d /s /c $build
    if ($LASTEXITCODE -ne 0) { throw "MSVC compilation failed: $LASTEXITCODE" }
    & $exe
    if ($LASTEXITCODE -ne 0) { throw "Probe failed: $LASTEXITCODE" }
}
finally {
    Remove-Item $exe, $obj -Force -ErrorAction SilentlyContinue
}