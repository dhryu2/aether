/**
 * provider 목록 라우트.
 *   GET /api/providers  → 등록된 provider의 식별자·표시 이름·원격 재인증 지원 여부
 *
 * 모델·effort의 정본은 세션이 실제로 뜬 뒤 provider가 주는 목록이다(`GET /api/sessions/:id/models`).
 * 세션 밖에서는 그 목록을 저장해 둔 것만 읽어 준다(`GET /remembered-models`). 없으면 비어 있다.
 *
 * 인증 게이트 뒤에 mount한다 — 목록 자체는 민감하지 않지만 다른 조회 API와 노출 정책을 맞춘다.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { listProviders, providerAvailability } from "../providers/registry";
import { mergeModelList } from "../providers/modelCatalogMemory";
import type { ProviderAvailabilityResponse, RememberedModelsResponse } from "../../shared/http";

export const providersRouter = Router();

providersRouter.get("/", (_req: Request, res: Response) => {
  res.json({
    // displayName(8d-3 ④): 설정 화면이 "Claude 재인증"처럼 이름을 문구에 박지 않고, provider 목록으로
    //   재인증 항목을 그릴 수 있게 한다. 이 값은 이미 ProviderServices에 있었는데 직렬화되지 않았다.
    providers: listProviders().map((entry) => ({
      id: entry.id,
      displayName: entry.services.displayName,
      authSupported: !!entry.services.auth,
      ...(entry.services.planReview ? { planReview: true } : {}),
    })),
    // 원격 재로그인 킬스위치(AETHER_ENABLE_PROVIDER_RELOGIN=0)의 현재 상태 — provider 공통이다.
    //   프론트가 이걸 몰라서 꺼져 있어도 버튼을 그리고 403을 받던 것을 없앤다.
    reloginEnabled: config.enableProviderRelogin,
  });
});

// 새 세션 창이 열릴 때 한 번 묻는다. 저장본만 읽으므로 provider 프로그램을 띄우지 않는다.
providersRouter.get("/remembered-models", (_req: Request, res: Response) => {
  const body: RememberedModelsResponse = { models: Object.fromEntries(listProviders().map((entry) => [entry.id, mergeModelList(entry.id, [])])) };
  res.json(body);
});

// 새 세션 창이 열릴 때 묻는다. 확인에 프로그램 실행이 들어가 느릴 수 있어 목록(`GET /`)과 나눴다.
providersRouter.get("/availability", async (_req: Request, res: Response) => {
  const entries = listProviders();
  const results = await Promise.all(entries.map((entry) => providerAvailability(entry)));
  const body: ProviderAvailabilityResponse = { availability: Object.fromEntries(entries.map((entry, i) => [entry.id, results[i]])) };
  res.json(body);
});
