// 일회용 Web Push 테스트 전송. 실행: node --env-file=.env --import tsx scripts/test-push.ts
import { notifyPush, pushEnabled } from "../push";

if (!pushEnabled()) {
  console.error("VAPID 미설정 — push 비활성. .env 확인 필요.");
  process.exit(1);
}

notifyPush({
  title: "Aether 테스트 알림",
  body: "Web Push 정상 동작 확인 ✅ — 이 알림이 보이면 성공입니다.",
  tag: "aether-test",
});

console.log("푸시 전송 요청 완료(fire-and-forget). 폰/브라우저 확인하세요.");
// fire-and-forget이라 전송 완료까지 잠깐 대기
setTimeout(() => process.exit(0), 3000);
