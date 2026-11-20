//! 한국어·영어 문구와 상태별 메뉴 활성 표.
use crate::supervisor::State;
use std::sync::OnceLock;

fn ko() -> bool {
    static KO: OnceLock<bool> = OnceLock::new();
    *KO.get_or_init(|| sys_locale::get_locale().is_some_and(|l| l.starts_with("ko")))
}

pub fn tr(k: &'static str, e: &'static str) -> &'static str {
    if ko() { k } else { e }
}

pub struct MenuModel {
    pub status: &'static str,
    pub open: bool,
    pub serve: bool,
    /// true면 "서버 시작", false면 "서버 중지…"
    pub start: bool,
    pub restart: bool,
}

/// serving: 웹 화면 제공이 켜져 있는지
pub fn menu_model(state: State, serving: bool) -> MenuModel {
    let (status, open, serve, start, restart) = match state {
        State::Starting => (tr("시작 중…", "Starting…"), false, false, false, false),
        State::Running(_) => (tr("실행 중", "Running"), serving, true, false, true),
        State::Stopped => (tr("중지됨", "Stopped"), false, false, true, false),
        State::Error => (tr("오류: 서버가 계속 종료됩니다", "Error: Server keeps exiting"), false, false, true, true),
        State::Setup(_) => (tr("첫 설정 필요", "Setup Required"), true, false, false, true),
    };
    MenuModel { status, open, serve, start, restart }
}

#[derive(Clone, Copy)]
pub enum Action {
    Stop,
    Restart,
    Quit,
    Update,
}

/// 확인 창 (제목, 본문, 확인 버튼, 취소 버튼). sessions가 None이면 세션 수를 모르는 경우다.
pub fn confirm(a: Action, sessions: Option<u64>) -> (String, String, String, String) {
    let (title, ok) = match a {
        Action::Stop => (tr("서버를 중지할까요?", "Stop the server?"), tr("중지", "Stop")),
        Action::Restart => (tr("서버를 재시작할까요?", "Restart the server?"), tr("재시작", "Restart")),
        Action::Quit => (tr("Aether를 종료할까요?", "Quit Aether?"), tr("종료", "Quit")),
        Action::Update => (tr("업데이트를 적용할까요?", "Apply the update?"), tr("적용", "Apply")),
    };
    let body = match sessions {
        Some(n) if ko() => format!("실행 중인 세션 {n}개가 끊깁니다. 진행 중인 작업은 저장되지 않을 수 있습니다."),
        Some(n) => format!("{n} running session(s) will be disconnected. Work in progress may not be saved."),
        None => tr("실행 중인 세션이 모두 끊길 수 있습니다.", "All running sessions may be disconnected.").into(),
    };
    (title.into(), body, ok.into(), tr("취소", "Cancel").into())
}

/// 적용할 업데이트가 없을 때의 안내 창 (제목, 본문)
pub fn no_update() -> (&'static str, &'static str) {
    (tr("적용할 업데이트가 없습니다", "No update to apply"), tr("준비된 새 버전이 없습니다.", "No new version is ready."))
}

/// 교체 스크립트를 시작하지 못했을 때의 안내 창 (제목, 본문)
pub fn update_failed() -> (&'static str, &'static str) {
    (tr("업데이트를 시작하지 못했습니다", "Could not start the update"), tr("교체 스크립트를 실행할 수 없습니다. 앱을 다시 설치해 보세요.", "The update script could not be run. Try reinstalling the app."))
}

/// 서버가 연달아 죽어 다시 띄우지 않을 때의 알림 (제목, 본문)
pub fn server_down() -> (&'static str, &'static str) {
    (tr("서버가 멈췄습니다", "Server Stopped"), tr("연달아 종료되어 다시 띄우지 않았습니다.", "It kept exiting and was not restarted."))
}

/// 맥 권한 안내 창 (제목, 본문, 전체 디스크 접근 단추, 화면 녹음 단추, 닫기 단추)
pub fn permissions() -> (&'static str, &'static str, &'static str, &'static str, &'static str) {
    (
        tr("맥 권한", "Mac Permissions"),
        tr(
            "메일, 메시지, Safari 같은 보호된 데이터를 에이전트가 읽으려면 전체 디스크 접근 권한이 필요합니다. 화면 캡처에는 화면 녹음 권한이 필요합니다. 시스템 설정에서 Aether를 켠 뒤 서버를 재시작하세요.",
            "To let agents read protected data such as Mail, Messages, and Safari, Aether needs Full Disk Access. Screen capture needs Screen Recording. Turn on Aether in System Settings, then restart the server.",
        ),
        tr("전체 디스크 접근 열기", "Open Full Disk Access"),
        tr("화면 녹음 열기", "Open Screen Recording"),
        tr("닫기", "Close"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    // (열기, 제공, 시작이면 true, 재시작) — 로그와 종료는 항상 활성이라 표에서 뺀다
    fn row(s: State, serving: bool) -> (bool, bool, bool, bool) {
        let m = menu_model(s, serving);
        (m.open, m.serve, m.start, m.restart)
    }
    #[test]
    fn 활성_표() {
        assert_eq!(row(State::Starting, true), (false, false, false, false));
        assert_eq!(row(State::Running(1), true), (true, true, false, true));
        assert_eq!(row(State::Running(1), false), (false, true, false, true));
        assert_eq!(row(State::Stopped, true), (false, false, true, false));
        assert_eq!(row(State::Error, true), (false, false, true, true));
        assert_eq!(row(State::Setup(1), false), (true, false, false, true));
    }
    #[test]
    fn 알림과_권한_문구는_비어_있지_않다() {
        let (t, b) = server_down();
        assert!(!t.is_empty() && !b.is_empty());
        let (t, b, a, c, d) = permissions();
        assert!([t, b, a, c, d].iter().all(|x| !x.is_empty()));
    }
}
