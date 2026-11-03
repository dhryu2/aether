// 설치 묶음 빌드 보조. 사용:
//   node bundle-tools.mjs notices <esbuild metafile> <out 파일>   번들로 합쳐진 패키지의 라이선스 고지를 모은다
//   node bundle-tools.mjs prune <server 폴더> <남길 패키지...>      남길 패키지와 그 의존성 외의 node_modules를 지운다
import fs from "node:fs";
import path from "node:path";

const [cmd, a, ...rest] = process.argv.slice(2);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

if (cmd === "notices") {
  const inputs = Object.keys(readJson(a).inputs).filter((p) => p.includes("node_modules/"));
  const pkgs = new Map(); // "이름@버전" -> 패키지 폴더
  for (const p of inputs) {
    let dir = path.resolve(path.dirname(p));
    // {"type":"module"}처럼 이름 없는 package.json은 건너뛴다.
    while (dir !== path.dirname(dir) && !(fs.existsSync(path.join(dir, "package.json")) && readJson(path.join(dir, "package.json")).name)) dir = path.dirname(dir);
    const j = readJson(path.join(dir, "package.json"));
    pkgs.set(`${j.name}@${j.version}`, dir);
  }
  let text = "Aether가 서버 번들에 합쳐 넣은 제3자 패키지의 라이선스 고지.\n(번들 밖 node_modules에 그대로 있는 패키지는 자기 폴더의 LICENSE를 따른다.)\n";
  const missing = [];
  for (const [id, dir] of [...pkgs].sort((x, y) => x[0].localeCompare(y[0]))) {
    const j = readJson(path.join(dir, "package.json"));
    const files = fs.readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
    text += `\n${"=".repeat(72)}\n${id}  (${typeof j.license === "string" ? j.license : JSON.stringify(j.license ?? j.licenses ?? "라이선스 필드 없음")})\n${"=".repeat(72)}\n`;
    if (j.repository) text += `소스: ${typeof j.repository === "string" ? j.repository : j.repository.url}\n`;
    if (!files.length) {
      missing.push(id);
      // LICENSE 파일이 없는 패키지는 Readme의 License 절에 저작권 문구가 있다.
      const readme = fs.readdirSync(dir).find((f) => /^readme/i.test(f));
      const m = readme && /^#+\s*licen[sc]e\b[^\n]*\n([\s\S]*?)(?=\n#+\s|$(?![\s\S]))/im.exec(fs.readFileSync(path.join(dir, readme), "utf8"));
      if (m) text += `\n${m[1].trim()}\n`;
    }
    for (const f of files) text += `\n${fs.readFileSync(path.join(dir, f), "utf8").trim()}\n`;
  }
  fs.writeFileSync(rest[0] ?? a + ".txt", text);
  console.log(`고지 ${pkgs.size}개 패키지${missing.length ? `, LICENSE 파일 없음(package.json 필드와 Readme의 License 절을 적음): ${missing.join(", ")}` : ""}`);
} else if (cmd === "prune") {
  const nm = path.join(a, "node_modules");
  const keep = new Set();
  const visit = (name) => {
    if (keep.has(name)) return;
    const f = path.join(nm, name, "package.json");
    if (!fs.existsSync(f)) return; // 선택 의존성이 이미 없는 경우(플랫폼 패키지 등)
    keep.add(name);
    const j = readJson(f);
    // peerDependencies는 따르지 않는다: SDK의 sdk.mjs는 Node 내장 모듈만 불러오는 단일 파일이다(zod 등은 안에 들어 있다).
    for (const d of [j.dependencies, j.optionalDependencies]) for (const n of Object.keys(d ?? {})) visit(n);
  };
  for (const n of rest) { if (!fs.existsSync(path.join(nm, n, "package.json"))) { console.error(`남길 패키지가 없다: ${n}`); process.exit(1); } visit(n); }
  for (const ent of fs.readdirSync(nm)) {
    const sub = ent.startsWith("@") ? fs.readdirSync(path.join(nm, ent)).map((s) => `${ent}/${s}`) : [ent];
    for (const n of sub) if (!keep.has(n)) fs.rmSync(path.join(nm, n), { recursive: true, force: true });
    if (ent.startsWith("@") && !fs.readdirSync(path.join(nm, ent)).length) fs.rmdirSync(path.join(nm, ent));
  }
  console.log(`남긴 패키지 ${keep.size}개: ${[...keep].join(", ")}`);
} else { console.error("알 수 없는 명령"); process.exit(2); }
