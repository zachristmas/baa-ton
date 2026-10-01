# Run from the reviewed checkout. Preview by default; --apply installs skills.
& node (Join-Path $PSScriptRoot 'src/install.mjs') @args
if ($LASTEXITCODE -ne 0) { throw "Baa-ton installer failed: $LASTEXITCODE" }
