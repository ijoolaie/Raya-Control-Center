param([string]$OutputDirectory = $env:TEMP)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'experiments\windows-ntstatus-completion-model.cpp'
$exe = Join-Path $OutputDirectory ("raya-ntstatus-model-" + [guid]::NewGuid().ToString('N') + '.exe')
$obj = Join-Path $OutputDirectory ("raya-ntstatus-model-" + [guid]::NewGuid().ToString('N') + '.obj')
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $source)) { throw "Missing source: $source" }
if (-not (Test-Path $vcvars)) { throw "Missing MSVC environment: $vcvars" }
try {
    $build = 'call "' + $vcvars + '" >nul && cl.exe /nologo /W4 /WX /EHsc /std:c++17 /Fo:"' + $obj + '" "' + $source + '" /Fe:"' + $exe + '"'
    & cmd.exe /d /s /c $build
    if ($LASTEXITCODE -ne 0) { throw "MSVC build failed: $LASTEXITCODE" }
    & $exe
    if ($LASTEXITCODE -ne 0) { throw "NTSTATUS completion model failed: $LASTEXITCODE" }
}
finally { Remove-Item -LiteralPath $exe,$obj -Force -ErrorAction SilentlyContinue }
