#requires -Version 5.1
[CmdletBinding()]
param(
    [string] $LanIp,
    [ValidateRange(1024, 65535)]
    [int] $Port = 3443,
    [ValidateRange(1024, 65535)]
    [int] $ProxyPort = 7443,
    [switch] $Stop
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-PrivateIPv4 {
    param([string] $Address)
    $parsedAddress = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref] $parsedAddress)) { return $false }
    if ($parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $octets = $parsedAddress.GetAddressBytes()
    return ($octets[0] -eq 10) -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
}

$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$composeFiles = @('-f', (Join-Path $projectDirectory 'compose.yaml'), '-f', (Join-Path $projectDirectory 'compose.https.yaml'))
$dockerCommand = Get-Command docker -ErrorAction Stop
$certificateDirectory = Join-Path $projectDirectory '.local-https'
$forwarderScript = Join-Path $PSScriptRoot 'mobile-https-forwarder.ps1'
$forwarderStatePath = Join-Path $certificateDirectory 'forwarder.json'

function Get-OwnedForwarder {
    if (-not (Test-Path -LiteralPath $forwarderStatePath)) { return $null }
    $state = Get-Content -Raw -LiteralPath $forwarderStatePath | ConvertFrom-Json
    $process = Get-Process -Id ([int] $state.Pid) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.StartTime.ToUniversalTime().Ticks -ne ([datetime] $state.StartTimeUtc).ToUniversalTime().Ticks) { return $null }
    $processDetails = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
    if (-not $processDetails -or
        -not $processDetails.CommandLine.Contains($forwarderScript) -or
        -not $processDetails.CommandLine.Contains([string] $state.Marker)) {
        throw 'El PID guardado no corresponde al puente de este proyecto. No se detuvo ningun proceso; revisa .local-https/forwarder.json.'
    }
    return [pscustomobject] @{ Process = $process; State = $state }
}

# Read adapters without changing network settings or requiring administrator rights.
if (-not $Stop) {
$localAddresses = @()
$gatewayAddresses = @()
foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($adapter.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
    $properties = $adapter.GetIPProperties()
    $hasGateway = @($properties.GatewayAddresses | Where-Object {
        $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
        $_.Address.ToString() -ne '0.0.0.0'
    }).Count -gt 0
    foreach ($unicast in $properties.UnicastAddresses) {
        $candidate = $unicast.Address.ToString()
        if (-not (Test-PrivateIPv4 $candidate)) { continue }
        $localAddresses += $candidate
        if ($hasGateway) { $gatewayAddresses += $candidate }
    }
}
$localAddresses = @($localAddresses | Sort-Object -Unique)
$gatewayAddresses = @($gatewayAddresses | Sort-Object -Unique)

if ([string]::IsNullOrWhiteSpace($LanIp)) {
    if ($gatewayAddresses.Count -ne 1) {
        throw "No se pudo elegir una unica IP privada con puerta de enlace. Ejecuta de nuevo con -LanIp IP_DE_TU_WIFI. Candidatas: $($gatewayAddresses -join ', ')"
    }
    $LanIp = $gatewayAddresses[0]
}
if (-not (Test-PrivateIPv4 $LanIp) -or $LanIp -notin $localAddresses) {
    throw 'LanIp debe ser una IPv4 privada asignada actualmente a este PC; no se permiten direcciones publicas, loopback ni 0.0.0.0.'
}
} else {
    # compose stop does not apply config; a placeholder lets it work even off Wi-Fi.
    $LanIp = '127.0.0.1'
}

if (Test-Path -LiteralPath $certificateDirectory) {
    $certificateDirectoryItem = Get-Item -LiteralPath $certificateDirectory
    if (($certificateDirectoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw '.local-https no puede ser un enlace ni una union a otro directorio.'
    }
} elseif (-not $Stop) {
    New-Item -ItemType Directory -Path $certificateDirectory | Out-Null
}

$previousIp = [Environment]::GetEnvironmentVariable('PANINI_MOBILE_IP', 'Process')
$previousPort = [Environment]::GetEnvironmentVariable('PANINI_MOBILE_PROXY_PORT', 'Process')
try {
    $env:PANINI_MOBILE_IP = $LanIp
    $env:PANINI_MOBILE_PROXY_PORT = [string] $ProxyPort
    $ownedForwarder = Get-OwnedForwarder

    if ($Stop) {
        if ($ownedForwarder) { $ownedForwarder.Process | Stop-Process }
        & $dockerCommand.Source compose @composeFiles stop mobile-https
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo detener el proxy HTTPS.' }
        Write-Output 'Proxy HTTPS detenido. La app, PostgreSQL y sus datos no se modificaron.'
        return
    }

    if ($Port -eq $ProxyPort) { throw 'Port y ProxyPort deben ser diferentes.' }
    if ($ownedForwarder -and ($ownedForwarder.State.LanIp -ne $LanIp -or
        $ownedForwarder.State.Port -ne $Port -or $ownedForwarder.State.ProxyPort -ne $ProxyPort)) {
        $ownedForwarder.Process | Stop-Process
        $ownedForwarder = $null
    }

    $runningApp = @(& $dockerCommand.Source compose -f (Join-Path $projectDirectory 'compose.yaml') ps --status running -q app)
    if ($LASTEXITCODE -ne 0 -or $runningApp.Count -ne 1) {
        throw 'La app local debe estar ejecutandose primero. Revisa Rancher Desktop y ejecuta docker compose up -d desde el proyecto.'
    }

    # --quiet validates without printing the existing .env secrets.
    & $dockerCommand.Source compose @composeFiles config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'La configuracion HTTPS no es valida.' }

    # Do not rebuild or restart the app/database while enabling the proxy.
    & $dockerCommand.Source compose @composeFiles up -d --no-deps --wait --wait-timeout 45 mobile-https
    if ($LASTEXITCODE -ne 0) {
        throw 'No se pudo iniciar HTTPS. Revisa los logs de mobile-https; no se cambiaron certificados de confianza ni reglas de firewall.'
    }

    $publicCertificatePath = Join-Path $certificateDirectory 'album-panini-root.crt'
    # Export only the PUBLIC CA certificate; private keys stay in the Docker volume.
    & $dockerCommand.Source compose @composeFiles cp mobile-https:/data/caddy/pki/authorities/local/root.crt $publicCertificatePath
    if ($LASTEXITCODE -ne 0) { throw 'HTTPS esta activo pero no fue posible exportar el certificado publico.' }

    if (-not $ownedForwarder) {
        $marker = [guid]::NewGuid().ToString()
        $shellPath = (Get-Process -Id $PID).Path
        $forwarderArguments = @('-NoProfile', '-NonInteractive', '-File', ('"{0}"' -f $forwarderScript),
            '-LanIp', $LanIp, '-Port', [string] $Port, '-ProxyPort', [string] $ProxyPort, '-Marker', $marker)
        $forwarderProcess = Start-Process -FilePath $shellPath -ArgumentList $forwarderArguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $certificateDirectory 'forwarder.log') `
            -RedirectStandardError (Join-Path $certificateDirectory 'forwarder-error.log')
        $ready = $false
        try {
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                $forwarderProcess.Refresh()
                if ($forwarderProcess.HasExited) { throw 'El puente LAN no pudo arrancar; revisa .local-https/forwarder-error.log.' }
                $startupLog = Get-Content -Raw -LiteralPath (Join-Path $certificateDirectory 'forwarder.log') -ErrorAction SilentlyContinue
                if (-not $startupLog -or -not $startupLog.Contains("marker=$marker")) {
                    Start-Sleep -Milliseconds 200
                    continue
                }
                $probe = [System.Net.Sockets.TcpClient]::new()
                try { $ready = $probe.ConnectAsync($LanIp, $Port).Wait(200) -and $probe.Connected }
                catch { $ready = $false }
                finally { $probe.Dispose() }
                if ($ready) { break }
                Start-Sleep -Milliseconds 200
            }
            if (-not $ready) { throw 'El puente LAN no abrio el puerto a tiempo.' }
            $state = [ordered] @{
                Pid = $forwarderProcess.Id
                StartTimeUtc = $forwarderProcess.StartTime.ToUniversalTime().ToString('o')
                Marker = $marker
                LanIp = $LanIp
                Port = $Port
                ProxyPort = $ProxyPort
            }
            $state | ConvertTo-Json | Set-Content -LiteralPath $forwarderStatePath -Encoding UTF8
        } catch {
            $forwarderProcess.Refresh()
            if (-not $forwarderProcess.HasExited) { $forwarderProcess | Stop-Process }
            throw
        }
    }

    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($publicCertificatePath)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = [BitConverter]::ToString($hasher.ComputeHash($certificate.RawData)).Replace('-', ':')
    } finally {
        $hasher.Dispose()
        $certificate.Dispose()
    }

    Write-Output "App para el celular: https://${LanIp}:$Port/app"
    Write-Output "Certificado publico: $publicCertificatePath"
    Write-Output "Huella SHA-256 del certificado: $fingerprint"
    Write-Output 'Conecta el celular a la misma Wi-Fi y confia manualmente SOLO en esta CA de pruebas. Consulta docs/mobile-scanner-testing.md.'
    Write-Output 'No se abrio el firewall, no se instalaron certificados de raiz y no se expuso PostgreSQL.'
} finally {
    [Environment]::SetEnvironmentVariable('PANINI_MOBILE_IP', $previousIp, 'Process')
    [Environment]::SetEnvironmentVariable('PANINI_MOBILE_PROXY_PORT', $previousPort, 'Process')
}
