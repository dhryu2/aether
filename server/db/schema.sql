-- Aether SQLite 스키마. 파일을 열 때마다 IF NOT EXISTS로 적용한다. DROP과 장부 표는 없다.
-- 시각은 밀리초 정수다. 오류 표만 ISO 문자열이다(공통 계약 형식).

CREATE TABLE IF NOT EXISTS search_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  query TEXT NOT NULL,
  filters TEXT NOT NULL,
  hit_count INTEGER NOT NULL,
  hit_keys TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_audit_at_idx ON search_audit (at DESC);

-- 세션 일기. 화면 복원과 재연결이 읽는 정본이다.
-- 여기 행은 뒤에 붙이기만 한다. 세션을 지울 때만 그 세션의 행을 지운다.
-- 한 행은 예전 일기 파일의 한 줄과 같다. 순번이 같아도 위치가 다르면 둘 다 남긴다.
CREATE TABLE IF NOT EXISTS session_event (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  line_text TEXT NOT NULL,
  PRIMARY KEY (session_id, byte_offset),
  CHECK (session_id <> '' AND line_text <> ''),
  CHECK (seq > 0 AND ts >= 0 AND byte_offset >= 0 AND byte_length > 0)
);
CREATE INDEX IF NOT EXISTS session_event_seq_idx ON session_event (session_id, seq);

CREATE TABLE IF NOT EXISTS session_event_cursor (
  session_id TEXT PRIMARY KEY,
  consumed_byte INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  CHECK (session_id <> ''),
  CHECK (consumed_byte >= 0),
  CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*')
);

-- 세션 글자 색인. 사람 찾기와 세션 검색이 이 표를 읽는다.
-- 글은 위 사건 표에서만 다시 만든다. (session_id, seq, part)가 순서다.
-- content_fold는 찾기용 소문자 사본이다. 낱말 포함 여부는 이 칸에서 instr로 본다.
-- id는 아래 FTS 색인이 가리키는 고정 행 번호다. VACUUM이 바꾸지 않게 명시한다.
CREATE TABLE IF NOT EXISTS session_letter (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  part INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_fold TEXT NOT NULL,
  UNIQUE (session_id, seq, part),
  CHECK (session_id <> '' AND content <> ''),
  CHECK (role IN ('user','assistant','assistant_interim','tool')),
  CHECK (seq > 0 AND part >= 0 AND ts >= 0)
);
-- 점수 계산(bm25)만 쓴다. 맞음 여부는 content_fold가 정한다.
CREATE VIRTUAL TABLE IF NOT EXISTS session_letter_fts USING fts5(
  content, content='session_letter', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS session_letter_fts_ai AFTER INSERT ON session_letter BEGIN
  INSERT INTO session_letter_fts (rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS session_letter_fts_ad AFTER DELETE ON session_letter BEGIN
  INSERT INTO session_letter_fts (session_letter_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS session_letter_fts_au AFTER UPDATE OF content ON session_letter BEGIN
  INSERT INTO session_letter_fts (session_letter_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO session_letter_fts (rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS session_letter_session (
  session_id TEXT PRIMARY KEY,
  display_name TEXT,
  cwd TEXT,
  model TEXT,
  created_at INTEGER,
  lineage_id TEXT,
  CHECK (session_id <> '')
);

-- 글자 색인을 통째로 다시 만든 세션의 기록. 부팅 때 최대 순번과 규칙 버전이 같으면 그 세션은 건너뛴다.
-- 실시간 색인이 그 세션에 쓰면 이 행을 지워, 다음 부팅이 빈틈을 메운다.
CREATE TABLE IF NOT EXISTS session_letter_progress (
  session_id TEXT PRIMARY KEY,
  high_seq INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  CHECK (session_id <> '')
);

-- 공통 오류 기록. 운영 오류 파일에서 옮겨 담는다. 3개월이 지난 행은 정리한다.
CREATE TABLE IF NOT EXISTS error_event (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'fatal')),
  source TEXT NOT NULL,
  component TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  fingerprint TEXT NOT NULL,
  request_id TEXT,
  session_id TEXT,
  session_seq INTEGER CHECK (session_seq IS NULL OR typeof(session_seq) = 'integer'),
  environment TEXT NOT NULL,
  release TEXT,
  instance_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  context TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context))
);
CREATE INDEX IF NOT EXISTS error_event_received_idx ON error_event (received_at DESC, id);
CREATE INDEX IF NOT EXISTS error_event_fingerprint_idx ON error_event (fingerprint, occurred_at DESC);
CREATE INDEX IF NOT EXISTS error_event_session_idx ON error_event (session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS error_event_request_idx ON error_event (request_id);
