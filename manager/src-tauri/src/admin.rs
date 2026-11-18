//! 서버 관리 API 호출. 제한 시간 2초이며 호출하는 쪽이 별도 스레드에서 부른다.
use serde_json::{json, Value};
use std::time::Duration;

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(2))).build().into()
}

fn get(port: u16, token: &str, path: &str) -> Result<Value, String> {
    let mut r = agent()
        .get(format!("http://127.0.0.1:{port}/api/admin/{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

pub fn get_screens(port: u16, token: &str) -> Result<Vec<Value>, String> {
    Ok(get(port, token, "screens")?["screens"].as_array().cloned().unwrap_or_default())
}

pub fn put_screens(port: u16, token: &str, screens: Vec<Value>) -> Result<(), String> {
    agent()
        .put(format!("http://127.0.0.1:{port}/api/admin/screens"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .send(json!({ "screens": screens }).to_string())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn running_sessions(port: u16, token: &str) -> Result<u64, String> {
    get(port, token, "status")?["runningSessions"].as_u64().ok_or_else(|| "형식 오류".into())
}
