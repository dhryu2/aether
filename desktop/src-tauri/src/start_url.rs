//! 시작 URL 선택·허용 판정. I/O·창 API 없음.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartUrlError {
    Empty,
    Rejected,
}

/// env → file → 기본값. 공백 env/file은 없는 것과 같다.
pub fn choose_start_raw(env: Option<&str>, file: Option<&str>) -> String {
    if let Some(e) = env {
        let t = e.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Some(f) = file {
        let t = f.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    "http://127.0.0.1:8787".into()
}

/// 주어진 문자열만 판정. 허용이면 trim 한 문자열을 그대로 반환.
pub fn prepare_start_url(raw: &str) -> Result<String, StartUrlError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(StartUrlError::Empty);
    }

    let Some((scheme_raw, after_scheme)) = s.split_once("://") else {
        return Err(StartUrlError::Rejected);
    };
    let scheme = scheme_raw.to_ascii_lowercase();

    // 권한(host[:port]) — path/query/fragment 앞까지
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if authority.is_empty() {
        return Err(StartUrlError::Rejected);
    }
    // userinfo 금지
    if authority.contains('@') {
        return Err(StartUrlError::Rejected);
    }

    let (host_raw, port_ok) = split_host_port(authority)?;
    if !port_ok {
        return Err(StartUrlError::Rejected);
    }
    let host = host_raw.to_ascii_lowercase();

    match scheme.as_str() {
        "http" => {
            if host == "127.0.0.1" {
                Ok(s.to_string())
            } else {
                Err(StartUrlError::Rejected)
            }
        }
        "https" => {
            if is_ts_net_subdomain(&host) {
                Ok(s.to_string())
            } else {
                Err(StartUrlError::Rejected)
            }
        }
        _ => Err(StartUrlError::Rejected),
    }
}

fn is_dotted_ipv4(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        // 앞자리 0 허용(127.0.0.1). 값만 0..=255.
        p.parse::<u32>().map(|n| n <= 255).unwrap_or(false)
    })
}

fn split_host_port(authority: &str) -> Result<(&str, bool), StartUrlError> {
    // IPv6 없음. `127.0.0.1`을 `127.0.0`+포트`1`로 쪼개지 않는다.
    if is_dotted_ipv4(authority) {
        return Ok((authority, true));
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        if host.is_empty() {
            return Err(StartUrlError::Rejected);
        }
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return Ok((authority, false));
        }
        Ok((host, true))
    } else {
        Ok((authority, true))
    }
}

fn is_ts_net_subdomain(host: &str) -> bool {
    match host.strip_suffix(".ts.net") {
        Some(prefix) => {
            !prefix.is_empty() && !prefix.starts_with('.') && !prefix.ends_with('.')
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choose_start_raw_table() {
        assert_eq!(
            choose_start_raw(Some("http://127.0.0.1:8901"), Some("https://foo.ts.net")),
            "http://127.0.0.1:8901"
        );
        assert_eq!(
            choose_start_raw(None, Some("http://127.0.0.1:8901")),
            "http://127.0.0.1:8901"
        );
        assert_eq!(choose_start_raw(None, None), "http://127.0.0.1:8787");
        assert_eq!(
            choose_start_raw(Some("http://localhost:8901"), Some("http://127.0.0.1:8901")),
            "http://localhost:8901"
        );
        assert_eq!(
            choose_start_raw(Some("  "), Some("http://127.0.0.1:8901")),
            "http://127.0.0.1:8901"
        );
    }

    #[test]
    fn prepare_allows() {
        let allowed = [
            "http://127.0.0.1",
            "http://127.0.0.1:8901",
            "http://127.0.0.1:8787",
            "https://aether.example.ts.net:8787",
            "https://foo.ts.net",
        ];
        for input in allowed {
            assert_eq!(prepare_start_url(input).as_deref(), Ok(input), "allow {input}");
        }
    }

    #[test]
    fn prepare_rejects() {
        // ws scheme 거절 행은 리터럴 연속 문자열을 피하려고 조립한다.
        let ws_reject = format!("{}://127.0.0.1:8901", "ws");
        let rejected = [
            "http://localhost:8787",
            "https://localhost",
            "http://localhost:8901",
            " ",
            "https://ts.net",
            "https://ts.net:8787",
            concat!("https://user", "@foo.ts.net"),
            "https://example.com",
            "http://foo.ts.net:8787",
            "https://evil.ts.net.attacker.com",
            "file:///tmp",
            "https://127.0.0.1:8787",
        ];
        for input in rejected {
            assert!(prepare_start_url(input).is_err(), "reject {input:?}");
        }
        assert!(prepare_start_url(&ws_reject).is_err(), "reject {ws_reject}");
    }

    #[test]
    fn choose_then_prepare_rejects_localhost_env() {
        let raw = choose_start_raw(Some("http://localhost:8901"), Some("http://127.0.0.1:8901"));
        assert_eq!(raw, "http://localhost:8901");
        assert!(prepare_start_url(&raw).is_err());
    }
}
