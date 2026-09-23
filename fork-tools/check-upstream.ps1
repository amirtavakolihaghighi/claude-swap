<#
.SYNOPSIS
  Tells you whether the original claude-swap repository has new commits.

.DESCRIPTION
  Fetches the upstream repository (read-only - it never changes your files or
  your branch) and reports what has landed there since your fork last merged.

  Writes a report to fork-tools/.upstream-report.md, which is the file the
  merge prompt in fork-tools/UPSTREAM-MERGE-PROMPT.md refers to.

  It also reports whether upstream touched any file YOU have changed, which is
  what actually decides whether a merge is trivial or needs thought.

.PARAMETER Quiet
  Print nothing when you are already up to date. Use this for scheduled runs.

.PARAMETER NoFetch
  Skip the network fetch and report on whatever was last fetched. Useful offline.

.OUTPUTS
  Exit code 0  = up to date
  Exit code 10 = updates are available
  Exit code 1  = something went wrong (not a git repo, no upstream remote, ...)

.EXAMPLE
  .\fork-tools\check-upstream.ps1
  .\fork-tools\check-upstream.ps1 -Quiet    # for Task Scheduler
#>

[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$NoFetch
)

$ErrorActionPreference = 'Stop'

# Always operate on the repository this script lives in, not the caller's cwd.
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

function Fail($message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

# --- sanity checks --------------------------------------------------------

try { $null = git rev-parse --git-dir 2>$null } catch { Fail "Not a git repository: $repoRoot" }
if ($LASTEXITCODE -ne 0) { Fail "Not a git repository: $repoRoot" }

$remotes = git remote
if ($remotes -notcontains 'upstream') {
    Fail "No 'upstream' remote. Add it with:`n  git remote add upstream https://github.com/realiti4/claude-swap.git"
}

# --- fetch ----------------------------------------------------------------

if (-not $NoFetch) {
    if (-not $Quiet) { Write-Host "Checking the original repository for updates..." -ForegroundColor Cyan }
    git fetch upstream --tags --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        if ($Quiet) { exit 1 }
        Fail "Could not reach the original repository. Are you online?"
    }
}

# --- compare --------------------------------------------------------------

$behind = [int](git rev-list --count HEAD..upstream/main)
$ahead  = [int](git rev-list --count upstream/main..HEAD)
$localBranch = git rev-parse --abbrev-ref HEAD

if ($behind -eq 0) {
    if (-not $Quiet) {
        Write-Host ""
        Write-Host "  Up to date." -ForegroundColor Green
        Write-Host "  Nothing new in the original repository." -ForegroundColor DarkGray
        if ($ahead -gt 0) {
            Write-Host "  (You have $ahead commit(s) of your own on '$localBranch'.)" -ForegroundColor DarkGray
        }
        Write-Host ""
    }
    exit 0
}

# New upstream commits, oldest first so the story reads forwards.
$commits = git log HEAD..upstream/main --reverse --format="%h|%ad|%an|%s" --date=short

# Files upstream changed.
$upstreamFiles = @(git diff --name-only HEAD...upstream/main | Where-Object { $_ })

# Files YOU changed relative to the common ancestor - the overlap between these
# two lists is the only place a merge conflict can come from.
$mergeBase = git merge-base HEAD upstream/main
$myFiles = @(git diff --name-only $mergeBase HEAD | Where-Object { $_ })
$overlap = @($upstreamFiles | Where-Object { $myFiles -contains $_ })

$version = (git show upstream/main:pyproject.toml |
    Select-String -Pattern '^version\s*=' |
    Select-Object -First 1).Line -replace '.*"(.*)".*', '$1'

# --- report ---------------------------------------------------------------

$report = [System.Collections.Generic.List[string]]::new()
$report.Add("# Upstream update report")
$report.Add("")
$report.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
$report.Add("")
$report.Add("- Your branch: ``$localBranch``")
$report.Add("- New commits upstream: **$behind**")
$report.Add("- Your own commits not upstream: $ahead")
$report.Add("- Upstream version: ``$version``")
$report.Add("- Files upstream changed: $($upstreamFiles.Count)")
if ($overlap.Count -eq 0) {
    $report.Add("- Files that overlap with your changes: **none** (a clean merge is very likely)")
} else {
    $report.Add("- Files that overlap with your changes: **$($overlap.Count)** (review these first)")
    foreach ($f in $overlap) { $report.Add("  - ``$f``") }
}
$report.Add("")
$report.Add("## New commits (oldest first)")
$report.Add("")
foreach ($c in $commits) {
    $parts = $c -split '\|', 4
    $report.Add("- ``$($parts[0])`` $($parts[1]) - $($parts[3]) _($($parts[2]))_")
}
$report.Add("")
$report.Add("## Files upstream changed")
$report.Add("")
foreach ($f in $upstreamFiles) { $report.Add("- ``$f``") }
$report.Add("")

$reportPath = Join-Path $repoRoot 'fork-tools\.upstream-report.md'
$report -join "`n" | Set-Content -Path $reportPath -Encoding utf8

# --- console summary ------------------------------------------------------

Write-Host ""
Write-Host "  $behind new commit(s) in the original repository." -ForegroundColor Yellow
Write-Host ""
$shown = 0
foreach ($c in $commits) {
    if ($shown -ge 10) {
        Write-Host "    ... and $($behind - 10) more" -ForegroundColor DarkGray
        break
    }
    $parts = $c -split '\|', 4
    Write-Host "    $($parts[1])  $($parts[3])" -ForegroundColor Gray
    $shown++
}
Write-Host ""
if ($overlap.Count -eq 0) {
    Write-Host "  None of your own files were touched - a clean merge is very likely." -ForegroundColor Green
} else {
    Write-Host "  $($overlap.Count) file(s) you changed were also changed upstream:" -ForegroundColor Yellow
    foreach ($f in $overlap) { Write-Host "    $f" -ForegroundColor Yellow }
}
Write-Host ""
Write-Host "  Full report: fork-tools\.upstream-report.md" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  To review and merge: open a new Claude Code chat and paste the" -ForegroundColor Cyan
Write-Host "  prompt from fork-tools\UPSTREAM-MERGE-PROMPT.md" -ForegroundColor Cyan
Write-Host ""

exit 10
