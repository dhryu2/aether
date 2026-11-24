//! 묶음 안의 Node 서버를 자식 프로세스로 띄우고 감시한다.
//! 서버와의 약속: stdin 파이프를 닫으면 서버가 스스로 끝난다. stdout 한 줄로 포트를 알린다.
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum State {
    Starting,
    Running(u16),
    Setup(u16),
    Stopped,
    Error,
}

pub enum Cmd {
    Start,
    Stop,
    Restart,
    Quit,
    /// 읽기 스레드가 보낸다: (자식 pid, 포트, 첫 설정 서버인지)
    Announced(u32, u16, bool),
}

#[derive(Debug, PartialEq)]
pub enum Next {
    Restart,
    Stopped,
    Error,
}

const STABLE: Duration = Duration::from_secs(10);
const MAX_FAILS: u32 = 3;

/// 자식이 사용자 요청 없이 끝났을 때 다음 행동. fails는 연속 실패 수다.
pub fn next_action(uptime: Duration, code: Option<i32>, fails: &mut u32) -> Next {
    if code == Some(0) {
        return Next::Stopped; // launchd의 SuccessfulExit false와 같은 규칙
    }
    *fails = if uptime >= STABLE { 0 } else { *fails + 1 };
    if *fails >= MAX_FAILS { Next::Error } else { Next::Restart }
}

/// `aether-listening <port>` 또는 `aether-listening <port> setup`
pub fn parse_announce(line: &str) -> Option<(u16, bool)> {
    let mut it = line.split_whitespace();
    if it.next()? != "aether-listening" {
        return None;
    }
    let port = it.next()?.parse().ok()?;
    match (it.next(), it.next()) {
        (None, _) => Some((port, false)),
        (Some("setup"), None) => Some((port, true)),
        _ => None,
    }
}

/// 설정 폴더: AETHER_APP_BASE가 있으면 그 폴더, 없으면 ~/Library/Application Support/Aether
pub fn config_dir() -> PathBuf {
    match std::env::var_os("AETHER_APP_BASE") {
        Some(b) => PathBuf::from(b),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Application Support/Aether"),
    }
}

/// 묶음의 core 폴더. 개발 시험용으로 환경 변수만 허용한다.
pub fn core_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("AETHER_MANAGER_CORE_DIR") {
        return PathBuf::from(d);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|p| p.join("../Resources/core")).unwrap_or_default()
}

/// 사용자의 로그인 셸이 쓰는 PATH. Finder가 띄운 앱은 PATH가 최소라서, 셸 설정으로 잡히는 도구
/// (nvm의 node, 에이전트 CLI)를 서버와 그 아래 세션이 찾지 못한다. 앱이 뜰 때 한 번만 묻는다.
fn login_shell_path() -> &'static str {
    static PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let Ok(mut child) = Command::new(shell)
            .args(["-ilc", "echo __AETHER_PATH__${PATH}__AETHER_PATH__"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return String::new();
        };
        // 셸 설정이 입력을 기다리며 멈출 수 있다. 5초 뒤에는 포기하고 고정 목록만 쓴다.
        let (tx, rx) = std::sync::mpsc::channel();
        let mut out = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            let _ = tx.send(s);
        });
        let got = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
        let _ = child.kill();
        let _ = child.wait();
        got.split("__AETHER_PATH__").nth(1).unwrap_or("").to_string()
    })
}

fn new_token() -> String {
    let mut buf = [0u8; 32];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    started: Instant,
}

struct Worker {
    tx: Sender<Cmd>,
    shared: Arc<Mutex<(State, String)>>,
    on_change: Box<dyn Fn(State) + Send>,
    run: Option<Running>,
    fails: u32,
    restart_at: Option<Instant>,
}

impl Worker {
    fn set(&self, s: State) {
        self.shared.lock().unwrap().0 = s;
        (self.on_change)(s);
    }

    fn spawn(&mut self) {
        let core = core_dir();
        let token = new_token();
        let tmp = config_dir().join("tmp");
        let _ = std::fs::create_dir_all(&tmp);
        let _ = std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o700));
        let home = std::env::var("HOME").unwrap_or_default();
        let spawned = Command::new(core.join("node/bin/node"))
            .arg(core.join("server/index.mjs"))
            .current_dir(core.join("server"))
            .env("PATH", format!("{}:{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", login_shell_path()).trim_start_matches(':'))
            .env("NODE_ENV", "production")
            .env("TMPDIR", &tmp)
            .env("AETHER_PARENT_WATCH", "1")
            .env("AETHER_ADMIN_TOKEN", &token)
            .env("AETHER_SUPERVISED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(_) => return self.failed(Duration::ZERO, None),
        };
        let pid = child.id();
        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        let tx = self.tx.clone();
        // stdout을 끝까지 읽어 버려야 서버가 막히지 않는다
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some((port, setup)) = parse_announce(&line) {
                    let _ = tx.send(Cmd::Announced(pid, port, setup));
                }
            }
        });
        self.shared.lock().unwrap().1 = token;
        self.run = Some(Running { child, stdin, started: Instant::now() });
        self.set(State::Starting);
    }

    /// stdin을 닫고 10초 안에 끝나기를 기다린다. 안 끝나면 kill한다.
    fn stop(&mut self) {
        let Some(Running { mut child, stdin, .. }) = self.run.take() else { return };
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    fn failed(&mut self, uptime: Duration, code: Option<i32>) {
        self.run = None;
        match next_action(uptime, code, &mut self.fails) {
            Next::Restart => {
                self.restart_at = Some(Instant::now() + Duration::from_secs(1));
                self.set(State::Starting);
            }
            Next::Stopped => self.set(State::Stopped),
            Next::Error => self.set(State::Error),
        }
    }
}

#[derive(Clone)]
pub struct Supervisor {
    tx: Sender<Cmd>,
    shared: Arc<Mutex<(State, String)>>,
}

impl Supervisor {
    pub fn send(&self, c: Cmd) {
        let _ = self.tx.send(c);
    }
    /// 현재 상태와 관리 토큰
    pub fn info(&self) -> (State, String) {
        self.shared.lock().unwrap().clone()
    }
}

/// 감시 스레드를 시작한다. 시작 명령은 바로 처리된다. on_quit은 자식을 끈 뒤 불린다.
pub fn start(on_change: impl Fn(State) + Send + 'static, on_quit: impl FnOnce() + Send + 'static) -> Supervisor {
    let (tx, rx) = channel();
    let shared = Arc::new(Mutex::new((State::Starting, String::new())));
    let mut w = Worker { tx: tx.clone(), shared: shared.clone(), on_change: Box::new(on_change), run: None, fails: 0, restart_at: None };
    let _ = tx.send(Cmd::Start);
    std::thread::spawn(move || loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Cmd::Start) => {
                if w.run.is_none() && w.restart_at.is_none() {
                    w.fails = 0;
                    w.spawn();
                }
            }
            Ok(Cmd::Stop) => {
                w.restart_at = None;
                w.stop();
                w.set(State::Stopped);
            }
            Ok(Cmd::Restart) => {
                w.restart_at = None;
                w.stop();
                w.fails = 0;
                w.spawn();
            }
            Ok(Cmd::Quit) => {
                w.stop();
                on_quit();
                return;
            }
            Ok(Cmd::Announced(pid, port, setup)) => {
                if w.run.as_ref().is_some_and(|r| r.child.id() == pid) {
                    w.set(if setup { State::Setup(port) } else { State::Running(port) });
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if let Some(r) = w.run.as_mut() {
            if let Ok(Some(status)) = r.child.try_wait() {
                let up = r.started.elapsed();
                w.failed(up, status.code());
            }
        }
        if w.restart_at.is_some_and(|t| Instant::now() >= t) {
            w.restart_at = None;
            w.spawn();
        }
    });
    Supervisor { tx, shared }
}

#[cfg(test)]
mod tests {
    use super::*;
    const S: Duration = Duration::from_secs(1);

    #[test]
    fn 짧게_죽으면_세_번째에_오류() {
        let mut f = 0;
        assert_eq!(next_action(S, Some(1), &mut f), Next::Restart);
        assert_eq!(next_action(S, Some(1), &mut f), Next::Restart);
        assert_eq!(next_action(S, None, &mut f), Next::Error);
    }
    #[test]
    fn 오래_살았으면_실패_수를_되돌린다() {
        let mut f = 2;
        assert_eq!(next_action(Duration::from_secs(11), Some(1), &mut f), Next::Restart);
        assert_eq!(f, 0);
    }
    #[test]
    fn 코드_0은_중지됨() {
        let mut f = 0;
        assert_eq!(next_action(S, Some(0), &mut f), Next::Stopped);
    }
    #[test]
    fn 알림_줄_해석() {
        assert_eq!(parse_announce("aether-listening 8787"), Some((8787, false)));
        assert_eq!(parse_announce("aether-listening 18990 setup"), Some((18990, true)));
        assert_eq!(parse_announce("aether-listening x"), None);
        assert_eq!(parse_announce("aether-listening 1 other"), None);
        assert_eq!(parse_announce("hello"), None);
    }
}
