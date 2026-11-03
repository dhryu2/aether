/**
 * 윈도우 이식용 가짜 입력 시험 — tailscale 실행 파일 찾기 순서, claude 실행 파일의 홈/확장자 처리.
 * 실제 윈도우 없이 임시 폴더·가짜 PATH로 확인한다. 모델 호출 0.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aether-winport-"));
process.env.AETHER_DATA_DIR = path.join(tmp, "data");
process.env.AETHER_CONFIG = "";
delete process.env.AETHER_TAILSCALE_CLI;
delete process.env.AETHER_CLAUDE_BIN;
let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, `FAIL: ${name}`); console.log(`  ✓ ${name}`); pass++; };
const touch = (f: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 }); return f; };

const { config } = await import("../config");
const { resolveTailscaleCli, resetTailscaleCliCache, tailscaleResolver } = await import("../auth/tailscale");

ok("tailscaleCli 기본값은 비어 있다", config.tailscaleCli === "");

// ③ 알려진 위치만 있을 때
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
process.env.PATH = binDir;
delete process.env.PATHEXT;
const known = touch(path.join(tmp, "known", "Tailscale"));
resetTailscaleCliCache();
ok("③ PATH에 없으면 알려진 위치의 파일을 고른다", resolveTailscaleCli([known]) === known);

// ② PATH가 알려진 위치보다 먼저
const onPath = touch(path.join(binDir, "tailscale"));
resetTailscaleCliCache();
ok("② PATH 검색이 알려진 위치보다 먼저다", resolveTailscaleCli([known]) === onPath);

// ① 설정 경로가 최우선
(config as { tailscaleCli: string }).tailscaleCli = "/explicit/ts";
ok("① 설정에 적힌 경로가 최우선이다", resolveTailscaleCli([known]) === "/explicit/ts");
(config as { tailscaleCli: string }).tailscaleCli = "";

// 못 찾을 때: null, 짧게 기억하고, 요청에서는 거절만 한다
fs.rmSync(onPath);
resetTailscaleCliCache();
ok("못 찾으면 null", resolveTailscaleCli([path.join(tmp, "none")]) === null);
touch(path.join(binDir, "tailscale"));
ok("못 찾은 직후에는 잠깐 기억해 다시 훑지 않는다", resolveTailscaleCli([path.join(tmp, "none")]) === null);
resetTailscaleCliCache();
ok("기억이 지나면(초기화) 설치 직후에도 잡힌다", resolveTailscaleCli([path.join(tmp, "none")]) !== null);

fs.rmSync(path.join(binDir, "tailscale"));
resetTailscaleCliCache();
// 못 찾음을 10초 기억시켜 두면 진짜 설치 위치가 있는 컴퓨터(맥 라이브)에서도 같은 시험이 돈다.
resolveTailscaleCli([path.join(tmp, "none")]);
const warns: string[] = [];
const origWarn = console.warn;
console.warn = (m: string) => { warns.push(String(m)); };
const r1 = await tailscaleResolver("100.64.0.1", 1);
const r2 = await tailscaleResolver("100.64.0.1", 1);
console.warn = origWarn;
ok("실행 파일이 없으면 신원 없음으로 답하고 경고는 한 번만 남는다", r1 === null && r2 === null && warns.length === 1);

// claude 실행 파일: HOME 대신 os.homedir, 윈도우 확장자
const home = path.join(tmp, "home");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PATH = path.join(tmp, "empty");
process.env.PATHEXT = ".EXE;.CMD";
const cmd = touch(path.join(home, ".local/bin/claude.CMD"));
const { resolveClaudeBin } = await import("../auth/claudeLogin");
ok("~/.local/bin의 claude.CMD를 PATHEXT로 찾는다", resolveClaudeBin() === cmd);

// 윈도우 .cmd 래퍼 풀기 — npm이 만드는 원문을 그대로 쓴다(platform을 win32로 주입)
const { resolveLaunch, resolveExecutablePath } = await import("../providers/installed");
const hdr = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n';
const nodeTail = (t: string) => `\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${t}" %*\n`;
const wrap = path.join(tmp, "npm");
const mk = (name: string, body: string, target?: string) => {
  fs.mkdirSync(wrap, { recursive: true });
  fs.writeFileSync(path.join(wrap, name), body);
  if (target) { const t = path.join(wrap, target.replace(/\\/g, "/")); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, ""); return t; }
  return "";
};
const exeT = mk("claude.cmd", hdr + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\n', "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
const jsT = mk("codex.cmd", hdr + nodeTail("node_modules\\@openai\\codex\\bin\\codex.js"), "node_modules\\@openai\\codex\\bin\\codex.js");
const noExtT = mk("grok.cmd", hdr + nodeTail("node_modules\\@xai-official\\grok\\bin\\grok"), "node_modules\\@xai-official\\grok\\bin\\grok");
const L = (n: string, p: NodeJS.Platform = "win32") => resolveLaunch(path.join(wrap, n), p);
ok("claude.cmd는 .exe 대상을 그대로 띄운다", L("claude.cmd").command === exeT && L("claude.cmd").args.length === 0);
ok("codex.cmd는 node로 .js 대상을 띄운다", L("codex.cmd").command === process.execPath && L("codex.cmd").args[0] === jsT);
ok("grok.cmd는 확장자 없는 JS 대상도 node로 띄운다", L("grok.cmd").command === process.execPath && L("grok.cmd").args[0] === noExtT);
ok("SDK용 단일 경로: .exe는 풀고 JS는 원래 값", resolveExecutablePath(path.join(wrap, "claude.cmd"), "win32") === exeT && resolveExecutablePath(path.join(wrap, "codex.cmd"), "win32") === path.join(wrap, "codex.cmd"));
fs.rmSync(jsT);
ok("대상 파일이 없으면 원래 경로를 유지한다", L("codex.cmd").command === path.join(wrap, "codex.cmd") && L("codex.cmd").args.length === 0);
ok("비윈도우는 그대로", L("claude.cmd", "darwin").command === path.join(wrap, "claude.cmd"));
const oldT = mk("old.cmd", '@IF EXIST "%~dp0\\node.exe" (\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\old\\cli.js" %*\n)\n', "node_modules\\old\\cli.js");
ok("옛 래퍼의 `%~dp0` 형식도 node로 대상을 띄운다", L("old.cmd").command === process.execPath && L("old.cmd").args[0] === oldT);
ok(".cmd가 아니면 윈도우에서도 그대로", L("nothing.exe").command === path.join(wrap, "nothing.exe"));

// 윈도우 경로 문자열 — 설정 키 비교, SQL 끝 구분자 제거
const { trustedProjectKey } = await import("../providers/codex/permissionPolicy");
const trusted = (key: string) => ({ projects: { [key]: { trust_level: "trusted" } } });
ok("codex 신뢰 키 `C:\\Users\\x\\proj\\`가 `c:/Users/x/proj`와 같은 폴더로 맞는다", trustedProjectKey(trusted("C:\\Users\\x\\proj\\"), "c:/Users/x/proj") === "C:\\Users\\x\\proj\\");
ok("codex 신뢰 키: 다른 폴더는 맞지 않는다", trustedProjectKey(trusted("C:\\Users\\x\\proj"), "C:/Users/x/other") === null);
ok("codex 신뢰 키: POSIX 끝 슬래시는 그대로 뗀다", trustedProjectKey(trusted("/a/b/"), "/a/b") === "/a/b/");

const { DatabaseSync } = await import("node:sqlite");
const mem = new DatabaseSync(":memory:");
const trimmed = (v: string) => (mem.prepare("SELECT rtrim(?, '/\\') AS v").get(v) as { v: string }).v;
ok("SQL rtrim이 윈도우 끝 `\\`와 `/`를 함께 뗀다", trimmed("C:\\Users\\x\\proj\\") === "C:\\Users\\x\\proj" && trimmed("/a/b/") === "/a/b");
mem.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n✅ windows_portability: ${pass}개 통과`);
