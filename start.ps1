<#
    Звонилка — запуск одной командой.

    Поднимает сервер и пробует несколько способов выпустить его наружу:
    туннель Cloudflare (QUIC и http2), затем SSH-туннели Pinggy и
    localhost.run. Если провайдер режет всё — переходит на собственный
    HTTPS, и тогда звонить можно внутри локальной сети или VPN.

    Параметры:
        -Local        не пробовать туннели, сразу локальный HTTPS
        -Port 8080    другой порт
#>

[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$Local
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

function Line($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Head($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor White }

# Обычный Get-Content не читает файл, открытый другим процессом на запись.
function Read-Shared($path) {
    if (-not (Test-Path $path)) { return '' }
    try {
        $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $sr = New-Object IO.StreamReader($fs)
        $text = $sr.ReadToEnd()
        $sr.Dispose(); $fs.Dispose()
        return $text
    } catch { return '' }
}

function Stop-Quiet($proc) {
    if ($proc) {
        try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch {}
    }
}

$serverOut = Join-Path $root 'server.log'
$serverErr = Join-Path $root 'server.err.log'
$tunOut    = Join-Path $root 'tunnel.log'
$tunErr    = Join-Path $root 'tunnel.err.log'

$server = $null
$tunnel = $null

function Start-Server($useHttps, $nodePath) {
    Remove-Item $serverOut, $serverErr -ErrorAction SilentlyContinue
    $env:PORT  = $Port
    $env:HTTPS = if ($useHttps) { '1' } else { '' }

    $proc = Start-Process -FilePath $nodePath -ArgumentList 'server.js' `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 300
        if ((Read-Shared $serverOut) -match 'Звонилка запущена') { return $proc }
        if ($proc.HasExited) { break }
    }
    return $null
}

function Start-Tunnel($p) {
    Remove-Item $tunOut, $tunErr -ErrorAction SilentlyContinue

    $proc = Start-Process -FilePath $p.Exe -ArgumentList $p.Args `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $tunOut -RedirectStandardError $tunErr

    $link = $null
    $ready = -not $p.Ready   # если признака готовности нет, хватает самой ссылки

    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 400
        $text = (Read-Shared $tunErr) + (Read-Shared $tunOut)

        if (-not $link) {
            $m = [regex]::Match($text, $p.Pattern)
            if ($m.Success) { $link = $m.Value }
        }
        if ($p.Ready -and $text -match $p.Ready) { $ready = $true }

        if (($link -and $ready) -or $proc.HasExited) { break }
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ''
    return @{ Proc = $proc; Link = $link; Ready = $ready }
}

function Test-Public($url) {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    try {
        for ($i = 0; $i -lt 6; $i++) {
            try {
                $resp = $client.GetAsync("$url/api/health").GetAwaiter().GetResult()
                if ($resp.IsSuccessStatusCode) { return $true }
            } catch {}
            Start-Sleep -Milliseconds 900
        }
    }
    finally { $client.Dispose() }
    return $false
}

try {
    # ── Node.js ────────────────────────────────────────────────────────
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Line '  Не найден Node.js.' Red
        Line '  Скачайте LTS-версию с https://nodejs.org и запустите скрипт заново.' Gray
        Write-Host ''
        return
    }

    # ── Чем пробиваться наружу ─────────────────────────────────────────
    $providers = @()

    if (-not $Local) {
        $cf = $null
        $tools  = Join-Path $root 'tools'
        $cfPath = Join-Path $tools 'cloudflared.exe'

        if (Test-Path $cfPath) { $cf = $cfPath }
        else {
            $found = Get-Command cloudflared -ErrorAction SilentlyContinue
            if ($found) { $cf = $found.Source }
            else {
                $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
                    'ARM64' { 'arm64' }
                    'x86'   { '386' }
                    default { 'amd64' }
                }
                Head 'Скачиваю cloudflared (около 40 МБ, только в первый раз)…'
                try {
                    New-Item -ItemType Directory -Force -Path $tools | Out-Null
                    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                    Invoke-WebRequest -UseBasicParsing -OutFile $cfPath `
                        -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
                    $cf = $cfPath
                }
                catch { Line "  Не скачалось: $($_.Exception.Message)" DarkGray }
            }
        }

        if ($cf) {
            $providers += @{
                Name = 'Cloudflare'
                Exe = $cf
                Args = @('tunnel', '--no-autoupdate', '--url', "http://localhost:$Port")
                Pattern = 'https://[a-z0-9-]+\.trycloudflare\.com'
                Ready = 'Registered tunnel connection'
            }
            $providers += @{
                Name = 'Cloudflare через http2'
                Exe = $cf
                Args = @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', "http://localhost:$Port")
                Pattern = 'https://[a-z0-9-]+\.trycloudflare\.com'
                Ready = 'Registered tunnel connection'
            }
        }

        # SSH есть в Windows 10 и 11 из коробки. Эти туннели ходят по портам
        # 443 и 22 — их режут заметно реже, чем служебный порт Cloudflare.
        $ssh = Get-Command ssh -ErrorAction SilentlyContinue
        if ($ssh) {
            $sshCommon = @('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL',
                           '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=6',
                           '-o', 'TCPKeepAlive=yes', '-o', 'ExitOnForwardFailure=yes')

            # localhost.run привязывает постоянный адрес к SSH-ключу. Со своим
            # ключом ссылка переживает переподключения и не меняется.
            $keyPath = Join-Path $root 'tools\tunnel_key'
            if (-not (Test-Path $keyPath)) {
                try {
                    New-Item -ItemType Directory -Force -Path (Join-Path $root 'tools') | Out-Null
                    & ssh-keygen -t ed25519 -f $keyPath -N '""' -q -C 'zvonilka' 2>&1 | Out-Null
                } catch {}
            }
            $keyArgs = if (Test-Path $keyPath) { @('-i', $keyPath, '-o', 'IdentitiesOnly=yes') } else { @() }
            $lhrUser = if (Test-Path $keyPath) { 'localhost.run' } else { 'nokey@localhost.run' }
            $providers += @{
                Name = 'Pinggy (SSH через 443 порт)'
                Exe = $ssh.Source
                Args = @('-p', '443') + $sshCommon + @("-R0:localhost:$Port", 'a.pinggy.io')
                Pattern = 'https://[a-z0-9.-]+\.pinggy\.link'
                Ready = $null
            }
            $providers += @{
                Name = 'localhost.run'
                Exe = $ssh.Source
                Args = $sshCommon + $keyArgs + @('-R', "80:localhost:$Port", $lhrUser)
                Pattern = 'https://[a-z0-9-]+\.lhr\.life'
                Ready = $null
            }
        }
    }

    # ── Сервер ─────────────────────────────────────────────────────────
    $useHttps = ($providers.Count -eq 0)
    $server = Start-Server $useHttps $node.Source

    if (-not $server) {
        Line '  Сервер не запустился.' Red
        $why = (Read-Shared $serverErr) + (Read-Shared $serverOut)
        if ($why -match 'EADDRINUSE') {
            Line "  Порт $Port уже занят — возможно, сервер остался с прошлого раза." Yellow
            Line '  Завершите node.exe в диспетчере задач или укажите другой порт.' Gray
        }
        elseif ($why.Trim()) {
            $why.Trim() -split "`r?`n" | Select-Object -First 8 | ForEach-Object { Line "  $_" DarkGray }
        }
        Line '  Другой порт:  start.bat -Port 8080' Gray
        Write-Host ''
        return
    }
    Line '  Сервер запущен.' DarkGray

    # ── Туннели ────────────────────────────────────────────────────────
    # Возвращает первый заработавший туннель. Вызывается и при старте,
    # и при обрыве связи, чтобы поднять всё заново.
    # Провайдер, сработавший в прошлый раз, пробуется первым — не тратим
    # полминуты на заведомо заблокированный Cloudflare при каждом запуске.
    $memoPath = Join-Path $root 'tools\last-provider.txt'
    $memo = if (Test-Path $memoPath) { (Get-Content $memoPath -Raw -ErrorAction SilentlyContinue).Trim() } else { '' }

    function Connect-Tunnel($quiet) {
        $order = @($providers | Where-Object { $_.Name -eq $script:memo }) +
                 @($providers | Where-Object { $_.Name -ne $script:memo })

        foreach ($p in $order) {
            if (-not $quiet) { Head "Пробую: $($p.Name)…" }
            $t = Start-Tunnel $p

            if ($t.Link -and $t.Ready) {
                # Второй заход на случай, если адресу нужно чуть больше времени —
                # рабочий туннель дороже лишних десяти секунд ожидания.
                if ((Test-Public $t.Link) -or (Test-Public $t.Link)) {
                    $script:memo = $p.Name
                    try {
                        New-Item -ItemType Directory -Force -Path (Split-Path $script:memoPath) | Out-Null
                        Set-Content -Path $script:memoPath -Value $p.Name -Encoding UTF8
                    } catch {}
                    return @{ Proc = $t.Proc; Link = $t.Link; Name = $p.Name }
                }
                if (-not $quiet) { Line '  Адрес выдан, но снаружи не открывается.' Yellow }
            }
            elseif (-not $quiet) { Line '  Не удалось — соединение блокируется.' Yellow }

            Stop-Quiet $t.Proc
        }
        return $null
    }

    $link = $null
    $via = $null
    $got = Connect-Tunnel $false
    if ($got) {
        $tunnel = $got.Proc
        $link   = $got.Link
        $via    = $got.Name
    }

    # ── Если наружу не пробились — свой HTTPS ──────────────────────────
    if (-not $link -and -not $useHttps) {
        Head 'Все туннели заблокированы. Перехожу на собственный HTTPS.'
        Stop-Quiet $server
        Start-Sleep -Milliseconds 700
        $server = Start-Server $true $node.Source
        if (-not $server) {
            Line '  Не удалось перезапустить сервер.' Red
            return
        }
        $useHttps = $true
    }

    # ── Локальные адреса ───────────────────────────────────────────────
    $lan = @()
    try {
        $lan = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                 Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
                 Select-Object -ExpandProperty IPAddress)
    } catch {}

    $scheme = if ($useHttps) { 'https' } else { 'http' }

    # ── Итог ───────────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor DarkGray
    Write-Host '   Звонилка работает' -ForegroundColor White
    Write-Host '  ============================================================' -ForegroundColor DarkGray
    Write-Host ''

    if ($link) {
        Line "  Ссылка для собеседников — через $via, проверена:" Gray
        Write-Host "      $link" -ForegroundColor Green
        try { Set-Clipboard -Value $link; Line '      — уже скопирована в буфер обмена' DarkGray } catch {}
        Write-Host ''
        Line '  На этом компьютере:' Gray
        Write-Host "      http://localhost:$Port" -ForegroundColor White
        Write-Host ''
        Line '  НЕ ЗАКРЫВАЙТЕ ЭТО ОКНО — вместе с ним отключится и ссылка.' Yellow
    }
    else {
        Line '  Наружу пробиться не удалось, работает только своя сеть.' Yellow
        Write-Host ''
        Line '  На этом компьютере:' Gray
        Write-Host "      https://localhost:$Port" -ForegroundColor White

        if ($lan.Count) {
            Write-Host ''
            Line '  Для тех, кто в той же сети — Wi-Fi, кабель или VPN вроде Radmin:' Gray
            foreach ($ip in $lan) { Write-Host "      https://$ip`:$Port" -ForegroundColor Green }
            if ($lan.Count -eq 1) { try { Set-Clipboard -Value "https://$($lan[0]):$Port"; Line '      — скопировано в буфер обмена' DarkGray } catch {} }
        }

        Write-Host ''
        Line '  Сертификат самоподписанный, поэтому браузер один раз предупредит.' DarkYellow
        Line '  Надо нажать «Дополнительно» и «Перейти на сайт» — после этого' DarkYellow
        Line '  камера и микрофон заработают как обычно.' DarkYellow
    }

    Write-Host ''
    Line '  Остановить: Ctrl+C.' DarkGray
    Write-Host ''

    while (-not $server.HasExited) {
        Start-Sleep -Seconds 2
        if (-not ($link -and $tunnel -and $tunnel.HasExited)) { continue }

        # Бесплатные туннели периодически рвутся сами — молча поднимаем заново.
        Write-Host ''
        Line '  Туннель оборвался, восстанавливаю…' Yellow
        $again = Connect-Tunnel $true

        if (-not $again) {
            Line '  Восстановить не удалось. Перезапустите скрипт.' Red
            Write-Host ''
            break
        }

        $tunnel = $again.Proc
        if ($again.Link -eq $link) {
            Line "  Готово, ссылка прежняя: $link" Green
        }
        else {
            $link = $again.Link
            Line '  Готово, но адрес сменился. Новая ссылка:' Gray
            Write-Host "      $link" -ForegroundColor Green
            try { Set-Clipboard -Value $link } catch {}
        }
        Write-Host ''
    }
}
finally {
    Stop-Quiet $tunnel
    Stop-Quiet $server
    Write-Host ''
    Line '  Звонилка остановлена.' DarkGray
    Write-Host ''
}
