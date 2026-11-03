/**
 * 배경 작업 실행의 단일 입구.
 *
 * 호출처는 역할만 고른다. 후보를 만드는 일(검색 요약)은 candidate, 거르는 일은 verify다.
 * 쓸 모델은 여기서 정하지 않는다. 옵션 없이 부르면 어댑터가 운영자 지정, 저장값, 자동 선택 순으로 처리한다.
 * 이 파일은 provider 이름을 모른다.
 */
import type { ProviderServices } from "./types";

export type BackgroundRole = "candidate" | "verify";

export async function backgroundDistill(services: ProviderServices, _role: BackgroundRole, prompt: string, cwd: string): Promise<string> {
  return services.distill(prompt, cwd);
}
