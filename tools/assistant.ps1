#Requires -Version 7.0
<#
.SYNOPSIS
    The owner's side of the unattended build: tells him when something needs him, and does
    the bookkeeping when he answers.

.DESCRIPTION
    phasekit runs the tasks. This script watches the run from the outside and turns its
    state into one page, "TabDeclutter - cosa fare.html" on the Desktop, that says in plain
    Italian what the owner has to do now, if anything:

      - the sequence stopped and needs an answer (the agent's own last words included);
      - a phase finished and has manual checks, with a fresh test build to run them on;
      - the runner died, the sequence finished, or nothing has started yet.

    A scheduled task runs -Once every ten minutes. When something new needs him it plays a
    sound, shows a notification and opens the page. Anything still pending is announced
    again (a stop every 3 hours, checks once a day, daytime only), so nothing depends on
    him remembering.

    The other modes exist for an interactive Claude session acting on his behalf. CLAUDE.md
    says when to use each one.

.EXAMPLE
    tools/assistant.ps1 -Install          # register everything once (this, watchdog, logon resume)
    tools/assistant.ps1 -Report           # what the owner has to do now, as text
    tools/assistant.ps1 -Open             # rebuild the page and open it
    tools/assistant.ps1 -Start            # start (or resume) the sequence, detached
    tools/assistant.ps1 -Answer M1.6 -File answer.txt
                                          # answer a stopped task, then carry on with the sequence
    tools/assistant.ps1 -BeginEdit        # pause safely and get a checkout of main to edit
    tools/assistant.ps1 -EndEdit -Message "docs: ..."
                                          # commit that edit to main and resume
    tools/assistant.ps1 -Build            # rebuild the test build from main now
#>
[CmdletBinding()]
param(
    [switch] $Install,
    [switch] $Uninstall,
    [switch] $Once,
    [switch] $Quiet,
    [switch] $Report,
    [switch] $Open,
    [switch] $Start,
    [string] $Answer,
    [string] $File,
    [switch] $RunAnswer,
    [switch] $BeginEdit,
    [switch] $EndEdit,
    [string] $Message,
    [switch] $Build
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$Repo = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Repo 'phasekit.json'
$PhasekitHome = if ($env:PHASEKIT_HOME) { $env:PHASEKIT_HOME } else { Join-Path (Split-Path -Parent $Repo) 'phasekit' }
$Phasekit = Join-Path $PhasekitHome 'bin' 'phasekit.ps1'
if (-not (Test-Path -LiteralPath $Phasekit)) {
    throw "phasekit not found at $Phasekit. Clone it next to this repository or set PHASEKIT_HOME."
}
. (Join-Path $PhasekitHome 'lib' 'PhaseKit.ps1')
$Cfg = Get-PhaseKitConfig -Path $ConfigPath

$StateDir = Join-Path $Repo '.phasekit'
$StateFile = Join-Path $StateDir 'assistant-state.json'
$LogFile = Join-Path $StateDir 'assistant.log'
$AnsweringFile = Join-Path $StateDir 'answering.json'
$EditFile = Join-Path $StateDir 'edit-main.json'
$Page = Join-Path ([Environment]::GetFolderPath('Desktop')) 'TabDeclutter - cosa fare.html'
$TestBuild = Join-Path $HOME 'TabDeclutter-prova'
$WorkRoot = Join-Path $env:LOCALAPPDATA 'TabDeclutter'
$TaskName = 'tabdeclutter-assistant'
$AnswerTaskName = 'tabdeclutter-answer'
$StopFile = Join-Path $Cfg.logDir 'auto-stopped.txt'
$DoneFile = Join-Path $Cfg.logDir 'auto-finished.txt'
$GaveUpFile = Join-Path $Cfg.logDir 'watchdog-gave-up.txt'

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Write-Log([string] $Text) {
    Add-Content -LiteralPath $LogFile -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $Text)
}

function Invoke-Git {
    <#
        git with its output decoded as UTF-8 whatever the console says. A scheduled task has
        no console of its own, and decoding with the OEM code page turns every accented
        letter in the plan into two wrong ones.
    #>
    param([Parameter(ValueFromRemainingArguments)] [string[]] $GitArgs)

    $psi = [System.Diagnostics.ProcessStartInfo]::new('git')
    $psi.ArgumentList.Add('-C')
    $psi.ArgumentList.Add($Repo)
    foreach ($a in $GitArgs) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return [pscustomobject]@{ code = $p.ExitCode; out = $out; err = $err }
}

function Get-MainText([string] $Path) {
    $r = Invoke-Git show "main:$Path"
    if ($r.code -ne 0) { return '' }
    return $r.out
}

function ConvertTo-Html([string] $Text) { return [System.Net.WebUtility]::HtmlEncode($Text) }

function Read-State {
    if (Test-Path -LiteralPath $StateFile) {
        try { return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json -AsHashtable) } catch { }
    }
    return @{}
}

function Save-State($State) {
    Set-Content -LiteralPath $StateFile -Value ($State | ConvertTo-Json -Depth 5)
}

function Get-FileKey([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return [string] (Get-Item -LiteralPath $Path).LastWriteTimeUtc.Ticks
}

function Test-Daytime { $h = (Get-Date).Hour; return ($h -ge 9 -and $h -lt 22) }

# ---------------------------------------------------------------------------
# Reading the state of the build
# ---------------------------------------------------------------------------

function Get-AgentLastWords([string] $Target) {
    <#
        The agent's own final message for a target, from its newest log. A stop note says
        that the branch has no commits; this says why, in the agent's words - usually the
        question it is waiting on.
    #>
    $safe = $Target -replace '[^\w.-]', '_'
    $log = Get-ChildItem -LiteralPath $Cfg.logDir -Filter "phase-$safe-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $log) { return '' }

    $result = ''
    $lastText = ''
    foreach ($line in (Get-Content -LiteralPath $log.FullName -Tail 400 -Encoding utf8)) {
        if (-not $line.StartsWith('{')) { continue }
        try { $e = $line | ConvertFrom-Json -Depth 20 } catch { continue }
        if ($e.type -eq 'result' -and $e.result) { $result = [string] $e.result }
        elseif ($e.type -eq 'assistant' -and $e.message.content) {
            $texts = @($e.message.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text })
            if ($texts.Count) { $lastText = ($texts -join "`n") }
        }
    }
    $words = if ($result) { $result } else { $lastText }
    if ($words.Length -gt 6000) { $words = $words.Substring($words.Length - 6000) }
    return $words.Trim()
}

function Get-BuildState {
    $tasksText = Get-MainText 'TASKS.md'
    $checksText = Get-MainText 'docs/MANUAL-CHECKS.md'

    # Ledger rows and phase titles, in the plan's own order.
    $rows = [System.Collections.Generic.List[object]]::new()
    $phaseTitles = @{}
    foreach ($line in ($tasksText -split "`r?`n")) {
        if ($line -match '^##\s+(?:\d+\.\s*)?PHASE\s+(?<key>\S+)\s+[—–-]+\s+(?<title>.+?)\s*$') {
            $phaseTitles[$Matches['key']] = $Matches['title']
        }
        elseif ($line -match '^\s*- \[(?<mark>[ x])\]\s+(?<id>[A-Za-z0-9]+\.\d+)\s+(?<label>.+?)\s*$') {
            $rows.Add([pscustomobject]@{
                id    = $Matches['id']
                done  = ($Matches['mark'] -eq 'x')
                label = $Matches['label']
                phase = ($Matches['id'] -replace '\.\d+$', '')
            })
        }
    }

    $phases = [System.Collections.Generic.List[object]]::new()
    foreach ($key in ($rows | ForEach-Object { $_.phase } | Select-Object -Unique)) {
        $own = @($rows | Where-Object { $_.phase -eq $key })
        $done = @($own | Where-Object { $_.done }).Count
        $phases.Add([pscustomobject]@{
            key      = $key
            title    = $(if ($phaseTitles.ContainsKey($key)) { $phaseTitles[$key] } else { $key })
            total    = $own.Count
            done     = $done
            complete = ($own.Count -gt 0 -and $done -eq $own.Count)
        })
    }

    # Manual checks: a "- [ ] (<task>) title" line plus the indented lines under it.
    $checks = [System.Collections.Generic.List[object]]::new()
    $current = $null
    foreach ($line in ($checksText -split "`r?`n")) {
        if ($line -match '^- \[(?<mark>[ xX])\]\s+\((?<id>[^)]+)\)\s*(?<title>.*)$') {
            # Captured before the next -match, which overwrites $Matches.
            $id = $Matches['id'].Trim()
            $done = ($Matches['mark'] -ne ' ')
            $title = $Matches['title'].Trim()
            $current = [pscustomobject]@{
                id    = $id
                phase = $(if ($id -match '^[A-Za-z0-9]+\.\d+$') { $id -replace '\.\d+$', '' } else { 'release' })
                done  = $done
                title = $title
                body  = [System.Collections.Generic.List[string]]::new()
            }
            $checks.Add($current)
        }
        elseif ($current -and $line -match '^\s{2,}\S') { $current.body.Add($line.Trim()) }
        else { $current = $null }
    }

    $runner = Get-RunnerState -Config $Cfg
    $pause = Get-PauseState -Config $Cfg

    $answering = $null
    if (Test-Path -LiteralPath $AnsweringFile) {
        try {
            $a = Get-Content -LiteralPath $AnsweringFile -Raw | ConvertFrom-Json
            if (Get-Process -Id ([int] $a.pid) -ErrorAction SilentlyContinue) { $answering = $a }
        } catch { }
    }

    $total = $rows.Count
    $doneCount = @($rows | Where-Object { $_.done }).Count
    $stopTarget = ''
    if (Test-Path -LiteralPath $StopFile) {
        $first = Get-Content -LiteralPath $StopFile -TotalCount 1
        if ($first -match 'stopped at (\S+)') { $stopTarget = $Matches[1] }
    }

    $status =
        if ($total -gt 0 -and $doneCount -eq $total) { 'finished' }
        elseif ($answering) { 'answering' }
        elseif ($runner -and $runner.alive) { 'running' }
        elseif ($pause) { 'paused' }
        elseif (Test-Path -LiteralPath $StopFile) { 'stopped' }
        elseif ($runner -and $runner.here -and -not $runner.alive) { 'dead' }
        elseif ($doneCount -eq 0 -and -not (Get-ChildItem -LiteralPath $Cfg.logDir -Filter 'phase-*.log' -ErrorAction SilentlyContinue)) { 'not-started' }
        else { 'idle' }

    $next = @($rows | Where-Object { -not $_.done } | Select-Object -First 1)
    $currentTarget = if ($runner -and $runner.alive) { $runner.target } elseif ($answering) { $answering.target } else { '' }

    return [pscustomobject]@{
        status        = $status
        rows          = $rows
        phases        = $phases
        checks        = $checks
        total         = $total
        doneCount     = $doneCount
        runner        = $runner
        pause         = $pause
        stopTarget    = $stopTarget
        stopNote      = $(if (Test-Path -LiteralPath $StopFile) { Get-Content -LiteralPath $StopFile -Raw -Encoding utf8 } else { '' })
        lastWords     = $(if ($stopTarget) { Get-AgentLastWords -Target $stopTarget } else { '' })
        currentTarget = $currentTarget
        next          = $(if ($next) { $next[0] } else { $null })
        gaveUp        = (Test-Path -LiteralPath $GaveUpFile)
    }
}

function Get-PendingChecks($S) {
    # Due now: unticked checks of every phase that has finished. Checks of a phase still in
    # progress wait for the phase, and release checks wait for the end.
    $completeKeys = @($S.phases | Where-Object { $_.complete } | ForEach-Object { $_.key })
    return @($S.checks | Where-Object { -not $_.done -and $completeKeys -contains $_.phase })
}

function Get-RowLabel($S, [string] $Id) {
    $r = @($S.rows | Where-Object { $_.id -eq $Id })
    if ($r.Count) { return "$Id — $($r[0].label)" }
    return $Id
}

# ---------------------------------------------------------------------------
# What the owner has to do: one model, rendered as a page and as text
# ---------------------------------------------------------------------------

function Get-Todo($S) {
    <#
        The list of things to tell the owner, most urgent first. Each item has a headline,
        plain-Italian steps, and optionally a block of text (a stop note, the agent's words).
    #>
    $items = [System.Collections.Generic.List[object]]::new()
    $say = { param($kind, $title, [string[]] $steps, $detail = '', $detailTitle = '')
        $items.Add([pscustomobject]@{ kind = $kind; title = $title; steps = $steps; detail = $detail; detailTitle = $detailTitle })
    }

    switch ($S.status) {
        'stopped' {
            & $say 'urgent' ("La sequenza si è fermata su {0} e aspetta te" -f (Get-RowLabel $S $S.stopTarget)) @(
                'Apri Claude Code nella cartella TabDeclutter (in VS Code).',
                'Scrivi: «La sequenza si è fermata, cosa devo fare?»',
                'Claude legge il motivo e ti spiega la situazione con parole semplici. Ti propone una risposta per l''agente e, quando sei d''accordo, la invia e fa ripartire tutto da solo.'
            ) $(if ($S.lastWords) { $S.lastWords } else { $S.stopNote }) $(if ($S.lastWords) { 'L''ultimo messaggio dell''agente' } else { 'La nota di stop' })
        }
        'dead' {
            & $say 'urgent' 'Il processo della sequenza si è interrotto senza fermarsi' @(
                'Di solito il watchdog lo fa ripartire entro 15 minuti, e allora non devi fare niente.',
                'Se questo avviso è ancora qui fra mezz''ora, apri Claude Code nella cartella TabDeclutter e scrivi: «La sequenza non gira, falla ripartire».'
            ) $(if ($S.gaveUp) { Get-Content -LiteralPath $GaveUpFile -Raw } else { '' }) 'Nota del watchdog'
        }
        'idle' {
            & $say 'urgent' 'La sequenza non sta girando' @(
                'Apri Claude Code nella cartella TabDeclutter e scrivi: «Fai ripartire la sequenza».'
            )
        }
        'not-started' {
            & $say 'urgent' 'La sequenza non è ancora partita' @(
                'Apri Claude Code nella cartella TabDeclutter e scrivi: «Avvia la sequenza».'
            )
        }
        'paused' {
            & $say 'info' ("In pausa dal {0}" -f $(if ($S.pause.since) { $S.pause.since.ToString('dd/MM HH:mm') } else { '?' })) @(
                'Quando vuoi riprendere, apri Claude Code nella cartella TabDeclutter e scrivi: «Riprendi la sequenza».'
            )
        }
    }

    $pending = Get-PendingChecks $S
    foreach ($phase in ($pending | ForEach-Object { $_.phase } | Select-Object -Unique)) {
        $p = @($S.phases | Where-Object { $_.key -eq $phase })[0]
        $own = @($pending | Where-Object { $_.phase -eq $phase })
        $steps = [System.Collections.Generic.List[string]]::new()
        $steps.Add("Installa (o aggiorna) la build di prova: istruzioni in fondo alla pagina. La trovi in $TestBuild.")
        foreach ($c in $own) {
            $text = "[$($c.id)] $($c.title)"
            if ($c.body.Count) { $text += "`n" + ($c.body -join "`n") }
            $steps.Add($text)
        }
        $steps.Add("Quando hai finito, apri Claude Code nella cartella TabDeclutter e scrivi: «Ho fatto le verifiche della fase $phase» e racconta cosa non andava, anche a parole tue. Claude spunta le verifiche e, se serve, aggiunge un task di correzione che l'agente farà subito.")
        & $say 'checks' ("Fase {0} ({1}) completata: {2} verifiche da fare" -f $phase, $p.title, $own.Count) $steps.ToArray()
    }

    if ($S.status -eq 'finished') {
        $release = @($S.checks | Where-Object { -not $_.done -and $_.phase -eq 'release' })
        $steps = @('Tutti i task sono stati fatti, verificati e uniti a main.') +
                 @($release | ForEach-Object { "[$($_.id)] $($_.title)" + $(if ($_.body.Count) { "`n" + ($_.body -join "`n") } else { '' }) }) +
                 @('Per la pubblicazione apri Claude Code nella cartella TabDeclutter e scrivi: «Aiutami a pubblicare». Pacchetti e testi sono già pronti (docs/STORE_LISTING.md, docs/RELEASE-CHECKLIST.md).')
        & $say 'checks' 'TabDeclutter è finito: restano i passi della pubblicazione' $steps
    }

    return $items
}

function Get-StatusLine($S) {
    $progress = "{0}/{1} task" -f $S.doneCount, $S.total
    switch ($S.status) {
        'running'     { return "Sta lavorando su $(Get-RowLabel $S $S.currentTarget) · $progress" }
        'answering'   { return "Sta proseguendo $(Get-RowLabel $S $S.currentTarget) con la tua risposta · $progress" }
        'stopped'     { return "Fermo su $(Get-RowLabel $S $S.stopTarget) · $progress" }
        'paused'      { return "In pausa · $progress" }
        'dead'        { return "Interrotto · $progress" }
        'finished'    { return "Finito · $progress" }
        'not-started' { return "Non ancora avviato · $progress" }
        default       { return "Fermo · $progress" }
    }
}

function Format-TodoText($S, $Items) {
    $sb = [System.Text.StringBuilder]::new()
    [void] $sb.AppendLine("STATO: $(Get-StatusLine $S)")
    [void] $sb.AppendLine("status=$($S.status) stopTarget=$($S.stopTarget) current=$($S.currentTarget) next=$(if ($S.next) { $S.next.id })")
    [void] $sb.AppendLine('')
    if (-not $Items.Count) { [void] $sb.AppendLine('Niente da fare per il proprietario adesso.') }
    foreach ($i in $Items) {
        [void] $sb.AppendLine("## $($i.title)")
        $n = 1
        foreach ($s in $i.steps) { [void] $sb.AppendLine("$n. " + ($s -replace "`n", "`n     ")); $n++ }
        if ($i.detail) {
            [void] $sb.AppendLine('')
            [void] $sb.AppendLine("--- $($i.detailTitle) ---")
            [void] $sb.AppendLine($i.detail.Trim())
            [void] $sb.AppendLine('---')
        }
        [void] $sb.AppendLine('')
    }
    if ($S.stopNote -and $S.status -eq 'stopped') {
        [void] $sb.AppendLine('--- nota di stop di phasekit ---')
        [void] $sb.AppendLine($S.stopNote.Trim())
    }
    return $sb.ToString()
}

function Write-Page($S, $Items) {
    $h = { param($t) ConvertTo-Html $t }
    $cards = foreach ($i in $Items) {
        $steps = ($i.steps | ForEach-Object {
            $lines = $_ -split "`n"
            $first = & $h $lines[0]
            $rest = if ($lines.Count -gt 1) { '<div class="sub">' + (($lines[1..($lines.Count - 1)] | ForEach-Object { & $h $_ }) -join '<br>') + '</div>' } else { '' }
            "<li>$first$rest</li>"
        }) -join "`n"
        $detail = if ($i.detail) {
            "<details open><summary>$(& $h $i.detailTitle)</summary><pre>$(& $h $i.detail.Trim())</pre></details>"
        } else { '' }
        "<section class=`"card $($i.kind)`"><h2>$(& $h $i.title)</h2><ol>$steps</ol>$detail</section>"
    }
    if (-not $Items.Count) {
        $cards = '<section class="card ok"><h2>Niente da fare per te adesso</h2><p>L''agente lavora da solo. Quando servirà qualcosa sentirai un suono, vedrai una notifica e questa pagina si riaprirà.</p></section>'
    }

    $phaseRows = ($S.phases | ForEach-Object {
        $pct = if ($_.total) { [int] (100 * $_.done / $_.total) } else { 0 }
        "<tr><td>$(& $h $_.key)</td><td>$(& $h $_.title)</td><td class=`"num`">$($_.done)/$($_.total)</td><td><div class=`"bar`"><span style=`"width:$pct%`"></span></div></td></tr>"
    }) -join "`n"

    $html = @"
<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="300">
<title>TabDeclutter – cosa fare</title>
<style>
:root { --bg:#f7f7f8; --card:#fff; --text:#1f1f1f; --muted:#5f6368; --line:#e0e0e0; --accent:#1a73e8; --urgent:#c5221f; --checks:#b06000; --ok:#188038; }
@media (prefers-color-scheme: dark) { :root { --bg:#1e1f22; --card:#2a2b2f; --text:#e8eaed; --muted:#9aa0a6; --line:#3c4043; --accent:#8ab4f8; --urgent:#f28b82; --checks:#fdd663; --ok:#81c995; } }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.status { color: var(--muted); margin: 0 0 20px; }
.card { background: var(--card); border: 1px solid var(--line); border-left: 6px solid var(--accent); border-radius: 10px; padding: 14px 18px; margin: 0 0 16px; }
.card.urgent { border-left-color: var(--urgent); } .card.checks { border-left-color: var(--checks); } .card.ok { border-left-color: var(--ok); }
.card h2 { font-size: 17px; margin: 0 0 8px; }
ol { margin: 0; padding-left: 22px; } li { margin: 6px 0; }
.sub { color: var(--muted); margin-top: 2px; }
pre { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 13px; max-height: 420px; overflow: auto; }
summary { cursor: pointer; color: var(--muted); margin-top: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; } td { padding: 4px 6px; border-bottom: 1px solid var(--line); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar { background: var(--line); border-radius: 4px; height: 8px; min-width: 80px; } .bar span { display: block; height: 8px; border-radius: 4px; background: var(--accent); }
h3 { font-size: 15px; margin: 28px 0 8px; }
.foot { color: var(--muted); font-size: 13px; margin-top: 28px; }
code { font-size: 13px; }
</style>
</head>
<body><main>
<h1>TabDeclutter – cosa fare</h1>
<p class="status">$(& $h (Get-StatusLine $S))</p>
$($cards -join "`n")
<h3>Avanzamento</h3>
<table>$phaseRows</table>
<h3>Come installare la build di prova</h3>
<section class="card">
<p><b>Chrome</b> (consigliato: un profilo Chrome separato, così la protezione duplicati non tocca le tue schede di lavoro)</p>
<ol>
<li>Apri <code>chrome://extensions</code> e attiva <b>Modalità sviluppatore</b> in alto a destra.</li>
<li>La prima volta: <b>Carica estensione non pacchettizzata</b> → scegli la cartella <code>$(& $h (Join-Path $TestBuild 'chrome'))</code>.</li>
<li>Le volte successive: nella scheda di TabDeclutter clicca l'icona di ricarica ↻.</li>
</ol>
<p><b>Firefox</b></p>
<ol>
<li>Apri <code>about:debugging#/runtime/this-firefox</code>.</li>
<li><b>Carica componente aggiuntivo temporaneo…</b> → scegli il file <code>$(& $h (Join-Path $TestBuild 'firefox\manifest.json'))</code>.</li>
<li>Firefox lo toglie quando lo chiudi: va ricaricato a ogni avvio, salvo dove la verifica dice diversamente.</li>
</ol>
</section>
<p class="foot">Pagina aggiornata alle $(Get-Date -Format 'HH:mm') del $(Get-Date -Format 'dd/MM'), si ricarica da sola. Per chiedere qualsiasi cosa: apri Claude Code nella cartella TabDeclutter e scrivi «Cosa devo fare?».</p>
</main></body></html>
"@
    Set-Content -LiteralPath $Page -Value $html -Encoding utf8
}

# ---------------------------------------------------------------------------
# The test build: a stable copy of main for manual checks
# ---------------------------------------------------------------------------

function Remove-BuildWorktree([string] $Dir) {
    # Only ever this one directory: refuse anything that is not under our own work root.
    if (-not $Dir.StartsWith($WorkRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "refusing to remove $Dir" }
    if (Test-Path -LiteralPath $Dir) {
        $null = Invoke-Git worktree remove --force $Dir
        if (Test-Path -LiteralPath $Dir) { Remove-Item -LiteralPath $Dir -Recurse -Force }
    }
    $null = Invoke-Git worktree prune
}

function Update-TestBuild([hashtable] $State, [switch] $Force) {
    <#
        Builds main in a throwaway worktree and copies both outputs to a fixed folder. The
        working tree belongs to the runner and its .output changes with every task, so the
        owner must never be pointed at it.
    #>
    $sha = (Invoke-Git rev-parse main).out.Trim()
    if (-not $Force -and $State['buildFor'] -eq $sha -and (Test-Path -LiteralPath (Join-Path $TestBuild 'chrome'))) { return $true }
    if (-not (Get-MainText 'package.json')) { return $false }

    $wt = Join-Path $WorkRoot 'build-worktree'
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
    Remove-BuildWorktree $wt
    $add = Invoke-Git worktree add --detach $wt main
    if ($add.code -ne 0) { Write-Log "test build: worktree add failed: $($add.err.Trim())"; return $false }

    $buildLog = Join-Path $StateDir 'test-build.log'
    try {
        Push-Location -LiteralPath $wt
        $ok = $true
        foreach ($cmd in @('pnpm install --frozen-lockfile', 'pnpm build', 'pnpm build:firefox')) {
            $global:LASTEXITCODE = 0
            Invoke-Expression "$cmd 2>&1" | Out-File -LiteralPath $buildLog -Append -Encoding utf8
            if ($LASTEXITCODE -ne 0) { $ok = $false; Write-Log "test build: '$cmd' failed (exit $LASTEXITCODE), see $buildLog"; break }
        }
        Pop-Location
        if (-not $ok) { return $false }

        foreach ($b in @('chrome', 'firefox')) {
            $src = Join-Path $wt ".output\$b-mv3"
            if (-not (Test-Path -LiteralPath $src)) { Write-Log "test build: $src missing"; return $false }
            $null = & robocopy $src (Join-Path $TestBuild $b) /MIR /NFL /NDL /NJH /NJS /NP
            if ($LASTEXITCODE -ge 8) { Write-Log "test build: copy of $b failed (robocopy $LASTEXITCODE)"; return $false }
        }
        Set-Content -LiteralPath (Join-Path $TestBuild 'LEGGIMI.txt') -Encoding utf8 -Value @"
Build di prova di TabDeclutter, generata automaticamente da main.
Commit: $sha
Data:   $(Get-Date -Format 'yyyy-MM-dd HH:mm')

chrome\   da caricare in chrome://extensions (Carica estensione non pacchettizzata)
firefox\  da caricare in about:debugging (manifest.json)

Non modificare questi file: vengono sostituiti alla fine di ogni fase.
"@
        $State['buildFor'] = $sha
        Write-Log "test build: updated to $sha"
        return $true
    }
    finally {
        if ((Get-Location).Path -eq $wt) { Pop-Location }
        Remove-BuildWorktree $wt
    }
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

function Invoke-Check {
    $state = Read-State
    if (-not $state.ContainsKey('phasesAnnounced')) { $state['phasesAnnounced'] = @() }
    $s = Get-BuildState
    $events = [System.Collections.Generic.List[string]]::new()
    $now = Get-Date

    # A stop is new when its note is a file we have not announced yet.
    if ($s.status -eq 'stopped') {
        $key = Get-FileKey $StopFile
        if ($state['stopKey'] -ne $key) {
            $events.Add("Si è fermato su $($s.stopTarget) e aspetta una tua risposta.")
            $state['stopKey'] = $key
            $state['stopNoticeAt'] = $now.ToString('o')
        }
        elseif ((Test-Daytime) -and $state['stopNoticeAt'] -and ($now - [datetime] $state['stopNoticeAt']).TotalHours -ge 3) {
            $events.Add("Promemoria: è ancora fermo su $($s.stopTarget).")
            $state['stopNoticeAt'] = $now.ToString('o')
        }
    }

    # A phase that just finished: build main for the owner, then announce its checks.
    $pending = Get-PendingChecks $s
    $announced = [System.Collections.Generic.List[string]]::new([string[]] @($state['phasesAnnounced']))
    foreach ($p in ($s.phases | Where-Object { $_.complete })) {
        if ($announced.Contains($p.key)) { continue }
        $own = @($pending | Where-Object { $_.phase -eq $p.key })
        if ($own.Count) {
            $built = Update-TestBuild -State $state
            $events.Add($(if ($built) { "Fase $($p.key) completata: $($own.Count) verifiche per te, con la build di prova già pronta." }
                          else { "Fase $($p.key) completata: $($own.Count) verifiche per te (la build di prova non si è aggiornata: vedi la pagina)." }))
            $state['checksNoticeAt'] = $now.ToString('o')
        }
        $announced.Add($p.key)
    }
    $state['phasesAnnounced'] = $announced.ToArray()

    if ($pending.Count -and -not $events.Count -and (Test-Daytime) -and
        (-not $state['checksNoticeAt'] -or ($now - [datetime] $state['checksNoticeAt']).TotalHours -ge 24)) {
        $events.Add("Promemoria: hai $($pending.Count) verifiche manuali in attesa.")
        $state['checksNoticeAt'] = $now.ToString('o')
    }

    if ($s.status -eq 'finished' -and -not $state['finishedAnnounced']) {
        [void] (Update-TestBuild -State $state)
        $events.Add('Tutti i task sono finiti. Restano i passi della pubblicazione.')
        $state['finishedAnnounced'] = $true
    }

    # A runner that died: give the watchdog half an hour before bothering anyone.
    if ($s.status -eq 'dead') {
        $mark = Get-RunnerFile -Config $Cfg
        $key = Get-FileKey $mark
        $age = if (Test-Path -LiteralPath $mark) { ($now - (Get-Item -LiteralPath $mark).LastWriteTime).TotalMinutes } else { 0 }
        if ($age -ge 40 -and $state['deadKey'] -ne $key) {
            $events.Add('Il processo si è interrotto e non è ripartito da solo.')
            $state['deadKey'] = $key
        }
    }
    if ($s.gaveUp) {
        $key = Get-FileKey $GaveUpFile
        if ($state['gaveUpKey'] -ne $key) { $events.Add('Il watchdog ha smesso di riavviare la sequenza.'); $state['gaveUpKey'] = $key }
    }

    $items = Get-Todo $s
    Write-Page $s $items

    if ($events.Count) {
        Write-Log ("announced: " + ($events -join ' | '))
        if (-not $Quiet) {
            Start-Process -FilePath $Page
            $kind = if ($s.status -in @('stopped', 'dead', 'idle')) { 'attention' } else { 'done' }
            Send-PhaseKitNotice -Kind $kind -Title 'TabDeclutter: serve te' `
                -Message (($events -join "`n") + "`nTi ho aperto la pagina «cosa fare».")
        }
    }
    Save-State $state
}

function Invoke-Start {
    $runner = Get-RunnerState -Config $Cfg
    if ($runner -and $runner.alive) { Write-Host "Already running: process $($runner.pid) on $($runner.target)."; return 0 }
    if (Get-PauseState -Config $Cfg) { & $Phasekit resume -Config $ConfigPath; return $LASTEXITCODE }

    # Through the scheduler, so the runner belongs to Task Scheduler and not to whatever
    # terminal or editor asked for it.
    if (-not (Get-ScheduledTask -TaskName 'phasekit-resume' -ErrorAction SilentlyContinue)) {
        & (Join-Path $PhasekitHome 'tools' 'resume-at-logon.ps1') -Install -Config $ConfigPath | Out-Null
    }
    Start-ScheduledTask -TaskName 'phasekit-resume'
    $deadline = (Get-Date).AddSeconds(60)
    do { Start-Sleep -Seconds 3; $runner = Get-RunnerState -Config $Cfg }
    while (-not ($runner -and $runner.alive) -and (Get-Date) -lt $deadline)
    if ($runner -and $runner.alive) { Write-Host "Started: process $($runner.pid) on $($runner.target)."; return 0 }
    Write-Host 'Asked the scheduler to start it, but no runner has announced itself yet. Check again with -Report in a minute.'
    return 1
}

function Invoke-AnswerLaunch {
    if (-not $Answer) { throw 'Which task? -Answer M1.6 -File answer.txt' }
    if (-not $File -or -not (Test-Path -LiteralPath $File)) { throw "Answer file not found: $File" }
    $runner = Get-RunnerState -Config $Cfg
    if ($runner -and $runner.alive) { throw "The sequence is running ($($runner.target)); there is nothing to answer." }

    # A stable copy: the scheduled run reads it later, and the caller may delete the original.
    $dir = Join-Path $StateDir 'answers'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $copy = Join-Path $dir ("{0}-{1}.txt" -f ($Answer -replace '[^\w.-]', '_'), (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $File -Destination $copy

    $q = { param($s) '"' + $s + '"' }
    $action = New-ScheduledTaskAction -Execute (Get-Process -Id $PID).Path `
        -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File {0} -RunAnswer -Answer {1} -File {2}" -f
                   (& $q $PSCommandPath), $Answer, (& $q $copy)) `
        -WorkingDirectory $Repo
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    if (Get-ScheduledTask -TaskName $AnswerTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $AnswerTaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $AnswerTaskName -Action $action -Settings $settings `
        -Description 'TabDeclutter: delivers one answer to a stopped task, then restarts the sequence.' | Out-Null
    Start-ScheduledTask -TaskName $AnswerTaskName
    Write-Host "Answer for $Answer handed to the scheduler ($copy). The agent continues in the same conversation, then the sequence carries on."
    return 0
}

function Invoke-AnswerRun {
    Set-Content -LiteralPath $AnsweringFile -Value (@{ target = $Answer; pid = $PID; since = (Get-Date).ToString('o') } | ConvertTo-Json)
    try {
        # The stop has been answered: keep the note for the record, but it no longer describes now.
        if (Test-Path -LiteralPath $StopFile) {
            Move-Item -LiteralPath $StopFile -Destination (Join-Path $Cfg.logDir ("auto-stopped-answered-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) -Force
        }
        Write-Log "answer: replying to $Answer from $File"
        & $Phasekit reply $Answer -File $File -Config $ConfigPath
        Write-Log "answer: reply to $Answer ended with exit $LASTEXITCODE; restarting the sequence"
    }
    finally {
        Remove-Item -LiteralPath $AnsweringFile -ErrorAction SilentlyContinue
    }
    # The sequence verifies and merges the answered task like any other, or stops again
    # with a fresh note if the answer was not enough.
    & $Phasekit auto -Config $ConfigPath
    Write-Log "answer: sequence ended with exit $LASTEXITCODE"
}

function Invoke-BeginEdit {
    if (Test-Path -LiteralPath $EditFile) { throw "An edit is already open (see $EditFile). Finish it with -EndEdit first." }
    $runner = Get-RunnerState -Config $Cfg
    $wasRunning = [bool] ($runner -and $runner.alive)
    $wasPaused = [bool] (Get-PauseState -Config $Cfg)
    # Pause in every case: it stops a live runner, and it holds the watchdog and the logon
    # task off while main is being edited.
    if (-not $wasPaused) { & $Phasekit pause -Config $ConfigPath | Out-Null }

    $base = (Invoke-Git rev-parse main).out.Trim()
    $branch = (Invoke-Git branch --show-current).out.Trim()
    if ($branch -eq 'main') {
        if ((Invoke-Git status --porcelain).out.Trim()) { throw 'main is checked out with uncommitted changes; refusing to edit on top of them.' }
        $dir = $Repo
        $mode = 'inplace'
    }
    else {
        $dir = Join-Path $WorkRoot 'main-edit'
        New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
        Remove-BuildWorktree $dir
        $r = Invoke-Git worktree add --detach $dir main
        if ($r.code -ne 0) { throw "worktree add failed: $($r.err)" }
        $mode = 'worktree'
    }
    Set-Content -LiteralPath $EditFile -Value (@{ mode = $mode; dir = $dir; base = $base; wasRunning = $wasRunning; wasPaused = $wasPaused } | ConvertTo-Json)
    Write-Host "EDIT_DIR=$dir"
    Write-Host "Edit the files there (it is main at $($base.Substring(0, 8))), then run: tools/assistant.ps1 -EndEdit -Message '<conventional commit message>'"
}

function Invoke-EndEdit {
    if (-not (Test-Path -LiteralPath $EditFile)) { throw 'No edit is open. Start one with -BeginEdit.' }
    if (-not $Message) { throw 'Pass -Message with a Conventional Commit message.' }
    $e = Get-Content -LiteralPath $EditFile -Raw | ConvertFrom-Json

    & git -C $e.dir add -A
    $staged = & git -C $e.dir diff --cached --name-only
    if ($staged) {
        & git -C $e.dir commit -q -m $Message
        if ($LASTEXITCODE -ne 0) { throw 'commit failed; the edit is still open.' }
        if ($e.mode -eq 'worktree') {
            $new = (& git -C $e.dir rev-parse HEAD).Trim()
            # Moves main only if nobody moved it meanwhile; the runner is paused, so nobody did.
            & git -C $Repo update-ref refs/heads/main $new $e.base
            if ($LASTEXITCODE -ne 0) { throw "main moved during the edit; the commit is $new in $($e.dir). Nothing was lost." }
        }
        Write-Host "Committed to main: $((Invoke-Git log -1 --oneline main).out.Trim())"
    }
    else { Write-Host 'Nothing changed; no commit.' }

    if ($e.mode -eq 'worktree') { Remove-BuildWorktree $e.dir }
    Remove-Item -LiteralPath $EditFile

    if ($e.wasRunning) { & $Phasekit resume -Config $ConfigPath | Out-Host }
    elseif (-not $e.wasPaused) {
        # It was stopped or idle, not running: lift the pause this edit added and leave the
        # decision to start it to whoever asked for the edit.
        Remove-Item -LiteralPath (Get-PauseFile -Config $Cfg) -ErrorAction SilentlyContinue
        Write-Host 'The sequence was not running before the edit and has not been started. Use -Start (or -Answer) when ready.'
    }
    else { Write-Host 'The sequence was paused before the edit and stays paused.' }
}

function Install-Assistant {
    $pwsh = (Get-Process -Id $PID).Path
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    # conhost --headless gives the check a console without a window, so nothing flashes on
    # screen every ten minutes.
    $action = New-ScheduledTaskAction -Execute $conhost `
        -Argument ("--headless `"{0}`" -NoProfile -ExecutionPolicy Bypass -File `"{1}`" -Once" -f $pwsh, $PSCommandPath) `
        -WorkingDirectory $Repo
    $triggers = @(
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)),
        (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
    )
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
        -Description 'TabDeclutter: tells the owner when the unattended build needs him (page on the Desktop, sound, notification).' | Out-Null
    Write-Host "Registered $TaskName (every 10 min and at logon)."

    & (Join-Path $PhasekitHome 'tools' 'resume-at-logon.ps1') -Install -Config $ConfigPath | Out-Null
    Write-Host 'Registered phasekit-resume (resumes the sequence after a reboot).'
    & (Join-Path $PhasekitHome 'tools' 'watchdog.ps1') -Install -Config $ConfigPath | Out-Null
    Write-Host 'Registered phasekit-watchdog (restarts a runner that was killed).'

    $script:Quiet = $true
    Invoke-Check
    Write-Host "Page written: $Page"
}

function Uninstall-Assistant {
    foreach ($t in @($TaskName, $AnswerTaskName)) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Host "Removed $t." }
    }
    & (Join-Path $PhasekitHome 'tools' 'resume-at-logon.ps1') -Uninstall | Out-Host
    & (Join-Path $PhasekitHome 'tools' 'watchdog.ps1') -Uninstall | Out-Host
}

if ($Install) { Install-Assistant; exit 0 }
if ($Uninstall) { Uninstall-Assistant; exit 0 }
if ($Once) { Invoke-Check; exit 0 }
if ($Report) { $s = Get-BuildState; $i = Get-Todo $s; Write-Page $s $i; Write-Output (Format-TodoText $s $i); exit 0 }
if ($Open) { $s = Get-BuildState; Write-Page $s (Get-Todo $s); Start-Process -FilePath $Page; exit 0 }
if ($Start) { exit (Invoke-Start) }
if ($RunAnswer) { Invoke-AnswerRun; exit 0 }
if ($Answer) { exit (Invoke-AnswerLaunch) }
if ($BeginEdit) { Invoke-BeginEdit; exit 0 }
if ($EndEdit) { Invoke-EndEdit; exit 0 }
if ($Build) { $st = Read-State; $ok = Update-TestBuild -State $st -Force; Save-State $st; if ($ok) { Write-Host "Test build updated in $TestBuild" } else { Write-Host "Test build failed or main has nothing to build yet; see $LogFile" }; exit ([int] (-not $ok)) }
Get-Help $PSCommandPath -Detailed
