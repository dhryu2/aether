/** 사용 조건 판. 첫 설정 화면이 보여 주는 판과 config.json에 기록하는 판이 같은 값을 쓴다. 조건을 고치면 날짜를 올린다. */
export const TERMS_VERSION = "2026-11-02";

/** 지금 판의 사용 조건 주소. 다운로드 사이트의 terms/ 폴더에 있다. 배포 주소 없이 만든 빌드(개발, 시험)는 빈 문자열이다. */
export const termsUrl = (site: string | undefined): string =>
  site?.trim() ? `${site.trim().replace(/\/+$/, "")}/terms/${TERMS_VERSION}.html` : "";
