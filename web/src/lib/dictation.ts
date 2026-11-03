// 브라우저 음성 인식. 없으면 버튼을 숨긴다. 오디오를 우리 서버로 보내지 않는다.

export type SpeechResultRow = { isFinal: boolean; 0?: { transcript?: string } };

export type SpeechSession = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { resultIndex?: number; results: ArrayLike<SpeechResultRow> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

export type SpeechCtor = new () => SpeechSession;

export function dictationLang(locale: string): string {
  return locale.toLowerCase().startsWith("ko") ? "ko-KR" : "en-US";
}

export function findSpeechCtor(host: { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }): SpeechCtor | null {
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

/** 확정된 조각만 이어 붙인다. 아직 확정되지 않은 마지막 조각은 다음 이벤트에 맡긴다. */
export function finalTranscript(results: ArrayLike<SpeechResultRow>, fromIndex: number): { text: string; next: number } {
  let text = "";
  let index = Math.max(0, fromIndex);
  for (; index < results.length; index++) {
    const row = results[index];
    if (!row?.isFinal) break;
    text += row[0]?.transcript ?? "";
  }
  return { text, next: index };
}
