& node (Join-Path $PSScriptRoot 'src/install.mjs') --remove @args
if ($LASTEXITCODE -ne 0) { throw "Baa-ton skill removal failed: $LASTEXITCODE" }
