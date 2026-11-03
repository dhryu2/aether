/**
 * 설정 서버의 데스크톱 연동: 브라우저 열기와 바로가기 파일(.url, .webloc). OS별 분기는 이 파일에만 둔다.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** 셸 없이 기본 브라우저를 연다. 실패해도 서버는 계속 돈다(주소는 start.log에 남는다). */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] =
    platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] as const
    : platform === "darwin" ? ["open", [url]] as const
    : ["xdg-open", [url]] as const;
  try {
    spawn(cmd, [...args], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // 브라우저를 못 열어도 첫 설정은 주소로 직접 들어가 진행할 수 있다.
  }
}

// 윈도우: Windows PowerShell 5.1의 FolderBrowserDialog는 옛날 작은 트리 창이라, 탐색기 모양 창(IFileOpenDialog)을 직접 부른다.
// 숨은 창을 주인으로 삼아야 폴더 창이 브라우저 뒤에 숨지 않는다. 취소는 종료 코드 2, 실패는 Stop으로 그 밖의 코드가 된다.
const WIN_PICK_SCRIPT = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AetherFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr a, IntPtr b, IntPtr c, out IntPtr d);
    void GetParent(out IShellItem p);
    void GetDisplayName(uint sigdn, out IntPtr name);
  }
  // 메서드 순서가 COM 표 순서다. 쓰지 않는 것도 GetResult까지는 지우면 안 된다.
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint n, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint o);
    void GetOptions(out uint o);
    void SetDefaultFolder(IShellItem s);
    void SetFolder(IShellItem s);
    void GetFolder(out IShellItem s);
    void GetCurrentSelection(out IShellItem s);
    void SetFileName(IntPtr n);
    void GetFileName(out IntPtr n);
    void SetTitle(IntPtr t);
    void SetOkButtonLabel(IntPtr t);
    void SetFileNameLabel(IntPtr t);
    void GetResult(out IShellItem s);
  }
  public static string Pick(IntPtr owner) {
    var d = (IFileOpenDialog)new FileOpenDialog();
    uint o; d.GetOptions(out o);
    d.SetOptions(o | 0x20 | 0x40); // 폴더 고르기 + 실제 파일 시스템 경로만
    int hr = d.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null; // 사용자가 취소
    Marshal.ThrowExceptionForHR(hr);
    IShellItem item; d.GetResult(out item);
    IntPtr name; item.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
    try { return Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }
  }
}
'@
$o=New-Object Windows.Forms.Form -Property @{TopMost=$true}
$p=[AetherFolderPicker]::Pick($o.Handle)
if($p){$p}else{exit 2}`;

type PickRun = (cmd: string, args: string[], options: { signal?: AbortSignal; windowsHide: boolean; encoding: "utf8" }) => Promise<{ stdout: string }>;

/** 이 컴퓨터의 기본 폴더 창을 띄운다. 고른 경로를 돌려주고, 취소면 null, 창을 못 띄우면 throw한다. */
export async function pickFolder(signal?: AbortSignal, platform: NodeJS.Platform = process.platform, run: PickRun = promisify(execFile)): Promise<string | null> {
  const options = { signal, windowsHide: true, encoding: "utf8" } as const;
  if (platform !== "darwin" && platform !== "win32") throw new Error("unsupported platform");
  try {
    const { stdout } = platform === "darwin"
      ? await run("osascript", ["-e", "activate", "-e", "POSIX path of (choose folder)"], options)
      : await run("powershell.exe", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(WIN_PICK_SCRIPT, "utf16le").toString("base64")], options);
    const picked = stdout.trim();
    return picked.length > 1 && /[\\/]$/.test(picked) && !/^[A-Za-z]:\\$/.test(picked) ? picked.slice(0, -1) : picked;
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown };
    if (platform === "darwin" ? String(e.stderr ?? "").includes("-128") : e.code === 2) return null;
    throw err;
  }
}

/** <설정 폴더>/Aether.url(맥은 Aether.webloc)을 현재 포트로 다시 쓴다. 실패는 삼킨다. */
export function writeShortcut(configDir: string, port: number, platform: NodeJS.Platform = process.platform): string | undefined {
  const url = `http://127.0.0.1:${port}/`;
  const mac = platform === "darwin";
  const file = path.join(configDir, mac ? "Aether.webloc" : "Aether.url");
  const body = mac
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${url}</string></dict></plist>\n`
    : `[InternetShortcut]\r\nURL=${url}\r\n`;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  } catch {
    return undefined;
  }
}
