//! 첫 실행 때 한 번 로그인 항목으로 등록한다(SMAppService). 실패해도 앱은 계속 돈다.
use crate::supervisor::config_dir;
use objc2_service_management::SMAppService;

pub fn register_once() {
    // 시험용 설정 폴더를 쓰는 동안은 이 맥의 로그인 항목을 건드리지 않는다
    if std::env::var_os("AETHER_APP_BASE").is_some() {
        return;
    }
    let dir = config_dir();
    let mark = dir.join("login-item-registered");
    if mark.exists() {
        return;
    }
    // SAFETY: 인자 없는 클래스 메서드와 등록 호출이다
    let ok = unsafe { SMAppService::mainAppService().registerAndReturnError().is_ok() };
    if ok {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(mark, "");
    }
}
