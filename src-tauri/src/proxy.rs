//! Outgoing TCP through a SOCKS5 or HTTP CONNECT proxy (`socks5://[user:pass@]host:port`,
//! `http://[user:pass@]host:port`), for SSH hosts behind one.
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct Proxy {
    kind: String,
    host: String,
    port: u16,
    auth: Option<(String, String)>,
}

fn parse(url: &str) -> Result<Proxy, String> {
    let (kind, rest) = url.trim().split_once("://").ok_or("Proxy must look like socks5://host:port or http://host:port")?;
    let kind = kind.to_ascii_lowercase();
    if !matches!(kind.as_str(), "socks5" | "socks5h" | "http") {
        return Err(format!("Unsupported proxy type {kind} (use socks5 or http)"));
    }
    let rest = rest.trim_end_matches('/');
    let (auth, addr) = match rest.rsplit_once('@') {
        Some((a, h)) => {
            let (u, p) = a.split_once(':').unwrap_or((a, ""));
            (Some((u.to_string(), p.to_string())), h)
        }
        None => (None, rest),
    };
    let (host, port) = addr.rsplit_once(':').ok_or("Proxy needs a port")?;
    let port = port.parse().map_err(|_| "Invalid proxy port")?;
    Ok(Proxy { kind, host: host.trim_matches(['[', ']']).to_string(), port, auth })
}

/// A TCP stream to `host:port` through the proxy at `url`.
pub async fn connect(url: &str, host: &str, port: u16) -> Result<TcpStream, String> {
    let p = parse(url)?;
    let mut s = TcpStream::connect((p.host.as_str(), p.port)).await.map_err(|e| format!("Proxy {}:{}: {e}", p.host, p.port))?;
    let _ = s.set_nodelay(true);
    let io = |e: std::io::Error| format!("Proxy: {e}");
    if p.kind == "http" {
        let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
        if let Some((u, pw)) = &p.auth {
            req += &format!("Proxy-Authorization: Basic {}\r\n", base64::engine::general_purpose::STANDARD.encode(format!("{u}:{pw}")));
        }
        s.write_all(format!("{req}\r\n").as_bytes()).await.map_err(io)?;
        // Read the response head byte by byte so nothing after it is consumed.
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() > 8192 {
                return Err("Proxy: response too long".into());
            }
            head.push(s.read_u8().await.map_err(io)?);
        }
        let status = String::from_utf8_lossy(&head);
        let line = status.lines().next().unwrap_or("");
        if line.split_whitespace().nth(1) != Some("200") {
            return Err(format!("Proxy refused: {line}"));
        }
        return Ok(s);
    }
    // SOCKS5 (RFC 1928/1929); the proxy resolves the host name.
    let methods: &[u8] = if p.auth.is_some() { &[0, 2] } else { &[0] };
    s.write_all(&[&[5, methods.len() as u8][..], methods].concat()).await.map_err(io)?;
    let mut r = [0u8; 2];
    s.read_exact(&mut r).await.map_err(io)?;
    match (r[1], &p.auth) {
        (0, _) => {}
        (2, Some((u, pw))) => {
            s.write_all(&[&[1, u.len() as u8][..], u.as_bytes(), &[pw.len() as u8], pw.as_bytes()].concat()).await.map_err(io)?;
            s.read_exact(&mut r).await.map_err(io)?;
            if r[1] != 0 {
                return Err("SOCKS5 proxy rejected the user name or password".into());
            }
        }
        _ => return Err("SOCKS5 proxy accepts none of our authentication methods".into()),
    }
    let mut req = vec![5, 1, 0, 3, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await.map_err(io)?;
    let mut h = [0u8; 4];
    s.read_exact(&mut h).await.map_err(io)?;
    if h[1] != 0 {
        return Err(format!("SOCKS5 proxy could not reach {host}:{port} (code {})", h[1]));
    }
    // Skip the bound address and port.
    let len = match h[3] {
        1 => 4,
        4 => 16,
        3 => s.read_u8().await.map_err(io)? as usize,
        _ => return Err("SOCKS5: bad reply".into()),
    };
    let mut skip = vec![0u8; len + 2];
    s.read_exact(&mut skip).await.map_err(io)?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_urls() {
        let p = super::parse("socks5://alice:secret@10.0.0.1:1080").unwrap();
        assert_eq!((p.kind.as_str(), p.host.as_str(), p.port, p.auth.unwrap().1.as_str()), ("socks5", "10.0.0.1", 1080, "secret"));
        let p = super::parse("http://proxy.lan:3128/").unwrap();
        assert_eq!((p.host.as_str(), p.port, p.auth.is_none()), ("proxy.lan", 3128, true));
        assert!(super::parse("ftp://x:1").is_err());
        assert!(super::parse("socks5://host").is_err());
    }
}
