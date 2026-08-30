# Internal helper. Start/stop through setup-mobile-https.ps1, not directly.
# Rancher's Docker daemon is inside WSL and cannot bind the Windows Wi-Fi IP.
# This temporary Windows process forwards only that IP to a loopback TLS port.
#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $LanIp,
    [Parameter(Mandatory = $true)] [int] $Port,
    [Parameter(Mandatory = $true)] [int] $ProxyPort,
    [Parameter(Mandatory = $true)] [guid] $Marker
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

public static class AlbumPaniniLocalHttpsProxy
{
    private static int activeConnections;

    public static async Task RunAsync(string address, int port, int proxyPort, string marker)
    {
        IPAddress ip = IPAddress.Parse(address);
        byte[] octets = ip.GetAddressBytes();
        bool isPrivate = ip.AddressFamily == AddressFamily.InterNetwork &&
            (octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
             (octets[0] == 192 && octets[1] == 168));
        if (!isPrivate || port < 1024 || port > 65535 || proxyPort < 1024 || proxyPort > 65535)
            throw new ArgumentException("Only private IPv4 and unprivileged ports are allowed.");

        var listener = new TcpListener(ip, port);
        listener.Server.ExclusiveAddressUse = true;
        listener.Start(32);
        Console.WriteLine("HTTPS LAN bridge ready on " + address + ":" + port + " marker=" + marker);
        Console.Out.Flush();
        try
        {
            while (true)
            {
                TcpClient client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                if (Interlocked.Increment(ref activeConnections) > 32)
                {
                    Interlocked.Decrement(ref activeConnections);
                    client.Close();
                    continue;
                }
                Task relay = RelayAsync(client, proxyPort);
                // RelayAsync handles errors and closes both ends, including timed-out clients.
            }
        }
        finally { listener.Stop(); }
    }

    private static async Task RelayAsync(TcpClient client, int proxyPort)
    {
        using (client)
        using (var upstream = new TcpClient(AddressFamily.InterNetwork))
        {
            try
            {
                client.NoDelay = true;
                upstream.NoDelay = true;
                await upstream.ConnectAsync(IPAddress.Loopback, proxyPort).ConfigureAwait(false);
                Task incoming = client.GetStream().CopyToAsync(upstream.GetStream());
                Task outgoing = upstream.GetStream().CopyToAsync(client.GetStream());
                await Task.WhenAny(incoming, outgoing, Task.Delay(TimeSpan.FromMinutes(5))).ConfigureAwait(false);
                client.Close();
                upstream.Close();
                try { await Task.WhenAll(incoming, outgoing).ConfigureAwait(false); }
                catch (Exception) { /* Closing a socket cancels the opposite copy. */ }
            }
            catch (Exception) { /* No request payload, cookie or credentials are logged. */ }
            finally { Interlocked.Decrement(ref activeConnections); }
        }
    }
}
'@

[AlbumPaniniLocalHttpsProxy]::RunAsync($LanIp, $Port, $ProxyPort, $Marker.ToString()).GetAwaiter().GetResult()
