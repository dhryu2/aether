/**
 * 응답 스트림을 **끊지 않고** 읽으면서 턴 경계마다 텍스트를 넘겨주는 읽기 장치 — provider 중립.
 *
 * ⚠️ 왜 `for await` 루프를 하나만 두고 절대 `break`하지 않나 — 실측(2026-07-30,
 * 내부 실측): 첫 턴의 끝에서 `break`하면 그 자리에서 보조 프로세스가
 * 내려간다. 그 뒤 두 번째 턴을 보내면 매달리지도 않고 **빈 문자열**이 돌아온다. 배경 작업이 조용히 아무
 * 성과 없이 끝나는 결함이므로, 루프는 하나만 돌리고 턴 경계는 약속(Promise)으로 넘긴다.
 *
 * 메시지의 생김새(어떤 필드가 텍스트이고 무엇이 턴의 끝인지)는 provider마다 다르므로 `inspect`로 받는다.
 * 여기에는 어느 provider의 지식도 두지 않는다(D2.6).
 */

/**
 * 메시지 하나를 본 결과 — 이어붙일 텍스트와, 이 메시지로 턴이 끝났는지.
 * `error`가 있으면 그 턴은 실패로 끝난 것이다(예: 사용 한도로 거부돼 답 대신 안내문이 온 경우). 그 턴을 기다리던 쪽은
 * `TurnFailedError`를 받는다 — 안내문을 모델의 답으로 넘기면 호출자가 그것을 해석하려다 엉뚱한 이유로 실패한다.
 */
export type TurnInspection = { text?: string; turnEnded?: boolean; error?: string };

export type TurnReader = {
  /**
   * 다음 턴이 끝날 때까지 기다린다.
   *
   * ★ 보내기 **전에** 불러 둬야 응답을 놓치지 않는다. 먼저 부르고, 반환된 약속을 들고 있다가,
   *   프롬프트를 밀어 넣은 뒤에 기다린다.
   *
   * ★★ 턴이 제대로 끝나지 않으면(끝 신호 없이 스트림이 닫히거나, 이미 닫힌 뒤에 묻거나) **예외를 던진다.**
   *   여기서 "지금까지 모은 것"을 조용히 돌려주면 안 된다 — 시간 제한에 걸려 중간에 끊긴 것과 "이번엔
   *   배울 게 없었다"를 호출자가 구별할 수 없게 되고, 그러면 그 대화 구간을 정상 처리된 것으로 넘겨
   *   **영영 다시 안 본다**. 실패는 실패로 알려야 다음 기회에 같은 구간을 다시 시도한다.
   */
  nextTurn(): Promise<string>;
  /**
   * 아직 아무도 가져가지 않은 완료 턴을 버린다. 몇 개를 버렸는지 돌려준다.
   *
   * 왜 필요한가: 한 번 보낸 프롬프트에 턴 종료 신호가 두 번 올 수 있다(예: 시간 제한으로 중단시켰을 때
   * 중단 결과와 본 결과가 둘 다 오는 경우). 그 찌꺼기가 남아 있으면 **다음 프롬프트를 보내기도 전에**
   * 그것이 다음 턴의 답인 양 반환된다. 새 프롬프트를 보내기 직전에 비운다.
   */
  drain(): number;
  /** 소비 루프가 끝났음을 알리는 약속. 절대 거절되지 않는다(오류는 안에서 갈무리한다). */
  readonly done: Promise<void>;
};

/** 턴이 끝 신호 없이 잘렸다 — 시간 제한·프로세스 종료·연결 끊김. 호출자는 이걸 실패로 다뤄야 한다. */
export class TurnIncompleteError extends Error {
  /** 잘리기 전까지 모은 텍스트(진단용). 성공한 응답으로 쓰면 안 된다. */
  readonly partial: string;
  constructor(partial: string) {
    super("응답이 끝나기 전에 스트림이 닫혔다");
    this.name = "TurnIncompleteError";
    this.partial = partial;
  }
}

/** 턴이 끝났지만 실패로 끝났다. 메시지는 provider가 준 오류 글이다. */
export class TurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnFailedError";
  }
}

type Ended = { text: string } | { error: string };

export function readTurns(source: AsyncIterable<unknown>, inspect: (msg: unknown) => TurnInspection): TurnReader {
  let buf = "";
  let ended = false;
  let failure: unknown = null;
  const pending: Ended[] = [];
  // 기다리는 쪽은 **줄**로 관리한다. 한 칸짜리 변수로 두면 `nextTurn()`을 연달아 두 번 부를 때
  //   앞의 약속이 아무 말 없이 버려지고, 그걸 기다리던 쪽이 영원히 매달린다.
  const waiters: Array<{ resolve(text: string): void; reject(err: unknown): void }> = [];

  const settle = (w: (typeof waiters)[number], e: Ended) => ("error" in e ? w.reject(new TurnFailedError(e.error)) : w.resolve(e.text));

  const done = (async () => {
    try {
      for await (const msg of source) {
        const seen = inspect(msg);
        if (seen.text) buf += seen.text;
        if (seen.turnEnded) {
          const ended: Ended = seen.error !== undefined ? { error: seen.error } : { text: buf };
          buf = "";
          const w = waiters.shift();
          if (w) settle(w, ended);
          else pending.push(ended);
        }
      }
    } catch (e) {
      failure = e;
    } finally {
      // 스트림이 끝났는데 기다리는 쪽이 남아 있으면 전부 깨운다 — 안 깨우면 호출자가 영원히 매달린다.
      //   깨우되 **실패로** 깨운다. 끝 신호를 못 받은 응답은 완성본이 아니다.
      ended = true;
      const last = buf;
      buf = "";
      let first = true;
      while (waiters.length) {
        const w = waiters.shift()!;
        w.reject(failure ?? new TurnIncompleteError(first ? last : ""));
        first = false;
      }
    }
  })();

  return {
    nextTurn(): Promise<string> {
      if (pending.length) {
        const e = pending.shift()!;
        return "error" in e ? Promise.reject(new TurnFailedError(e.error)) : Promise.resolve(e.text);
      }
      // 이미 닫힌 뒤에 묻는 것도 실패다 — 올 리 없는 답을 빈 문자열로 주면 위와 같은 착각이 생긴다.
      if (ended) return Promise.reject(failure ?? new TurnIncompleteError(""));
      return new Promise<string>((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
    drain(): number {
      const n = pending.length;
      pending.length = 0;
      return n;
    },
    done,
  };
}
