//! Wake on LAN: a magic packet (six 0xFF bytes, then the MAC address 16 times) sent as UDP broadcast.

use crate::foldersync;
use crate::model::{Host, WolDevice};
use crate::ssh;
use crate::store::Store;
use std::net::{IpAddr, UdpSocket};
use std::sync::Arc;

/// Parses "AA:BB:CC:DD:EE:FF", "AA-BB-…" or "AABBCCDDEEFF".
pub fn parse_mac(mac: &str) -> Result<[u8; 6], String> {
    let valid = mac.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '-');
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if !valid || hex.len() != 12 {
        return Err(format!("Not a MAC address: {mac}"));
    }
    let mut out = [0u8; 6];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub fn magic_packet(mac: &[u8; 6]) -> Vec<u8> {
    let mut packet = vec![0xff; 6];
    for _ in 0..16 {
        packet.extend_from_slice(mac);
    }
    packet
}

fn destination(dev: &WolDevice) -> Result<(IpAddr, u16), String> {
    let ip = if dev.broadcast.trim().is_empty() { "255.255.255.255".to_string() } else { dev.broadcast.trim().to_string() };
    let ip: IpAddr = ip.parse().map_err(|_| format!("Not an IP address: {ip}"))?;
    Ok((ip, if dev.port == 0 { 9 } else { dev.port }))
}

/// Sends the packet from this computer (it must be on the target's LAN).
pub fn send_direct(dev: &WolDevice) -> Result<(), String> {
    let packet = magic_packet(&parse_mac(&dev.mac)?);
    let dest = destination(dev)?;
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    sock.send_to(&packet, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Sends the packet from an SSH host on the target's LAN (reachable over a VPN).
pub async fn send_via(store: Arc<Store>, relay: &Host, dev: &WolDevice) -> Result<(), String> {
    use russh::ChannelMsg;
    let mac = parse_mac(&dev.mac)?;
    let (ip, port) = destination(dev)?;
    let hex: String = mac.iter().map(|b| format!("{b:02X}")).collect();
    let script = format!(
        "use IO::Socket::INET; my $s = IO::Socket::INET->new(Proto => 'udp', PeerAddr => '{ip}:{port}', Broadcast => 1) or die 'socket'; \
         $s->send(\"\\xff\" x 6 . (pack('H12', '{hex}') x 16)) or die 'send'; print \"sent\\n\";"
    );
    let cmd = format!("perl -MIO::Socket::INET -e {}", foldersync::sh(&script));
    let handle = ssh::connect(store, relay, ssh::no_log()).await?;
    let mut ch = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.exec(true, cmd).await.map_err(|e| e.to_string())?;
    let (mut code, mut err) = (0, Vec::new());
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::ExitStatus { exit_status } => code = exit_status,
            ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
            _ => {}
        }
    }
    if code != 0 {
        return Err(format!("{} could not send the packet: {}", relay.name, String::from_utf8_lossy(&err).trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_packet_layout() {
        let mac = parse_mac("aa:BB-cc:00:11:22").unwrap();
        let p = magic_packet(&mac);
        assert_eq!(p.len(), 102);
        assert_eq!(&p[..6], &[0xff; 6]);
        assert_eq!(&p[6..12], &[0xaa, 0xbb, 0xcc, 0x00, 0x11, 0x22]);
        assert_eq!(&p[96..102], &[0xaa, 0xbb, 0xcc, 0x00, 0x11, 0x22]);
        assert!(parse_mac("aa:bb:cc").is_err());
        assert!(parse_mac("zz:bb:cc:00:11:22").is_err());
    }
}
