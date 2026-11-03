; Aether 윈도우 설치·제거 프로그램. 관리자 권한 없이 사용자 영역(%LOCALAPPDATA%\Programs\Aether)에 설치한다.
; 컴파일: makensis -DVERSION=0.0.1 -DSRC=<묶음 폴더> -DOUTFILE=<설치 exe> aether.nsi
;   묶음 폴더에는 bin(AetherHost.exe 포함), node, server, web이 있어야 한다.
; 실행: Aether-<버전>-win-x64.exe [/S] [/TEST] [/UPDATE] [/D=<설치 폴더>]   (/D는 맨 끝)
;   /UPDATE: 앱 안 업데이트(감시 프로그램이 실행). 이전 파일을 .old로 옮겨 두고, 새 서버가 뜨지 않거나 설치가 실패하면 되돌린다.
;   /TEST: 자동 실행 등록, 바탕화면 바로가기, 제거 등록, 프로세스 종료, 서버 시작을 모두 건너뛴다(시험용).
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!ifndef VERSION | SRC | OUTFILE
  !error "VERSION, SRC, OUTFILE을 -D...로 지정하세요."
!endif

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Aether"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
; 앱 안 업데이트의 약속(server/update/install.ts): 새 서버는 뜨면 ok-<버전>을 쓰고, 되돌렸으면 rolled-back에 실패한 버전을 적는다.
!define UPDATES_DIR "$APPDATA\Aether\updates"
!define HEALTHY_WAIT_SECONDS 180

Name "Aether"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Aether"
; 재설치는 등록된 위치를 따른다(/D가 있으면 /D가 이긴다). 시험 설치(/TEST)는 등록하지 않으므로 이 값을 바꾸지 않는다.
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
AllowSkipFiles off
SetCompressor /SOLID lzma
ManifestDPIAware true
BrandingText "Aether ${VERSION}"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "English"

LangString MSG_BAD_DIR ${LANG_KOREAN} "설치 폴더가 올바르지 않습니다. 드라이브 최상위나 빈 경로에는 설치할 수 없습니다."
LangString MSG_BAD_DIR ${LANG_ENGLISH} "Invalid install folder. Aether cannot be installed to an empty path or a drive root."
LangString MSG_STOPPING ${LANG_KOREAN} "실행 중인 Aether를 끕니다..."
LangString MSG_STOPPING ${LANG_ENGLISH} "Stopping running Aether..."
LangString MSG_REMOVING ${LANG_KOREAN} "이전 프로그램 파일을 지웁니다..."
LangString MSG_REMOVING ${LANG_ENGLISH} "Removing previous program files..."
LangString MSG_COPYING ${LANG_KOREAN} "프로그램 파일을 복사합니다..."
LangString MSG_COPYING ${LANG_ENGLISH} "Copying program files..."
LangString MSG_ASK_DATA ${LANG_KOREAN} "설정과 기본 데이터도 지울까요?$\r$\n대화 기록과 작업 중인 코드 복사본(worktrees)도 함께 지워지며 되돌릴 수 없습니다.$\r$\n직접 지정한 다른 위치의 데이터 폴더는 지우지 않습니다."
LangString MSG_ASK_DATA ${LANG_ENGLISH} "Also delete settings and default data?$\r$\nConversation history and working copies of your code (worktrees) are deleted too, and this cannot be undone.$\r$\nData folders you placed elsewhere are not deleted."
LangString MSG_NOT_AETHER ${LANG_KOREAN} "이 폴더는 Aether 설치 폴더가 아니어서 아무것도 지우지 않았습니다."
LangString MSG_NOT_AETHER ${LANG_ENGLISH} "This folder is not an Aether installation, so nothing was deleted."
LangString MSG_FOREIGN ${LANG_KOREAN} "설치 폴더에 Aether가 아닌 bin, node, server 또는 web 폴더가 이미 있어 설치를 중단했습니다. 다른 폴더를 고르거나 그 폴더를 직접 정리해 주세요."
LangString MSG_FOREIGN ${LANG_ENGLISH} "The install folder already contains a bin, node, server or web folder that is not from Aether. Installation was stopped. Choose another folder or clean it up yourself."
LangString MSG_RUNNING ${LANG_KOREAN} "Aether가 실행 중입니다. 계속하면 Aether를 끄고 진행 중인 AI 세션이 끊깁니다. 계속할까요?"
LangString MSG_RUNNING ${LANG_ENGLISH} "Aether is running. Continuing will stop it and interrupt any running AI sessions. Continue?"
LangString MSG_COPY_FAIL ${LANG_KOREAN} "파일을 복사하지 못했습니다. 다른 프로그램이 파일을 쓰고 있는지 확인한 뒤 다시 실행해 주세요. 자동 실행 등록과 시작은 하지 않았습니다."
LangString MSG_COPY_FAIL ${LANG_ENGLISH} "Could not copy files. Check whether another program is using them and run the installer again. Auto-start was not set up and Aether was not started."

Var TEST
Var UPDATE
Var OLDVER
Var MOVED
Var RESTORE_FAILED

Function .onInit
  ${GetParameters} $0
  StrCpy $TEST 0
  ClearErrors
  ${GetOptions} $0 "/TEST" $1
  ${IfNot} ${Errors}
    StrCpy $TEST 1
  ${EndIf}
  StrCpy $UPDATE 0
  StrCpy $MOVED 0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UPDATE 1
  ${EndIf}
FunctionEnd

; 설치·제거 모두 지우기 전에 폴더를 검사한다. "X:\폴더" 꼴이어야 하고(드라이브 최상위와 UNC 거절), ".." 또는 "." 구성요소가 없어야 한다.
; 경로를 글자로만 본다(GetFullPathName은 아직 없는 폴더에서 실패할 수 있다).
!macro CheckInstDir un
Function ${un}CheckInstDir
  StrLen $0 $INSTDIR
  StrCpy $1 $INSTDIR 1 1
  StrCpy $2 $INSTDIR 1 2
  ${If} $0 < 4
  ${OrIf} $1 != ":"
  ${OrIf} $2 != "\"
    Goto bad
  ${EndIf}
  ; 마지막이 "\." 인가
  IntOp $3 $0 - 2
  StrCpy $4 $INSTDIR 2 $3
  ${If} $4 == "\."
    Goto bad
  ${EndIf}
  ; ".." 또는 "\.\" 가 들어 있는가
  StrCpy $3 0
  scan:
    IntOp $5 $0 - 1
    ${If} $3 >= $5
      Goto good
    ${EndIf}
    StrCpy $4 $INSTDIR 2 $3
    ${If} $4 == ".."
      Goto bad
    ${EndIf}
    StrCpy $4 $INSTDIR 3 $3
    ${If} $4 == "\.\"
      Goto bad
    ${EndIf}
    IntOp $3 $3 + 1
    Goto scan
  bad:
    MessageBox MB_OK|MB_ICONSTOP "$(MSG_BAD_DIR)" /SD IDOK
    Abort
  good:
FunctionEnd
!macroend
!insertmacro CheckInstDir ""
!insertmacro CheckInstDir "un."

; 실행 중인 우리 프로세스가 있으면 $0=1, 없으면 $0=0. 플러그인 없이 tasklist 출력의 첫 글자가 "(CSV 줄)인지 본다.
!macro DetectRunning un
Function ${un}DetectRunning
  StrCpy $0 0
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq AetherNode.exe" /FO CSV /NH'
  Pop $1
  Pop $2
  StrCpy $2 $2 1
  ${If} $2 == '"'
    StrCpy $0 1
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq AetherHost.exe" /FO CSV /NH'
  Pop $1
  Pop $2
  StrCpy $2 $2 1
  ${If} $2 == '"'
    StrCpy $0 1
  ${EndIf}
FunctionEnd
!macroend
!insertmacro DetectRunning ""

; 감시자를 먼저 끈다(안 그러면 서버를 다시 띄운다). 그다음 서버를 자식 프로세스 트리째 끈다. 이름은 우리 것만, node.exe는 건드리지 않는다.
!macro StopAether un
Function ${un}StopAether
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM AetherHost.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM AetherNode.exe'
  Pop $0
  Sleep 1500
FunctionEnd
!macroend
!insertmacro StopAether ""
!insertmacro StopAether "un."

; 스택 맨 위 이름의 폴더를 .old로 옮긴다. 프로세스가 막 끝나 파일이 잠겨 있을 수 있어 10초까지 다시 해 본다.
Function MoveAside
  Pop $R0
  StrCpy $R1 0
  retry:
    ClearErrors
    Rename "$INSTDIR\$R0" "$INSTDIR\.old\$R0"
    ${IfNot} ${Errors}
      Return
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 20
      Abort
    ${EndIf}
    Sleep 500
    Goto retry
FunctionEnd

; 스택 맨 위 이름의 폴더가 .old에 있으면 새 파일을 지우고 되돌린다. 잠겨 있으면 10초까지 다시 해 보고, 그래도 안 되면 표시만 남긴다.
Function RestoreOne
  Pop $R0
  ${IfNot} ${FileExists} "$INSTDIR\.old\$R0\*.*"
    Return
  ${EndIf}
  StrCpy $R1 0
  retry:
    RMDir /r "$INSTDIR\$R0"
    ClearErrors
    Rename "$INSTDIR\.old\$R0" "$INSTDIR\$R0"
    ${IfNot} ${Errors}
      Return
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 20
      StrCpy $RESTORE_FAILED 1
      Return
    ${EndIf}
    Sleep 500
    Goto retry
FunctionEnd

; 앱 안 업데이트가 실패했을 때: 이전 파일과 표시 버전을 되돌리고 실패 표시를 남긴 뒤 이전 버전을 다시 띄운다.
; 이번 실행에서 옮긴 적이 있을 때만 되돌린다. 하나라도 되돌리지 못하면 이전 파일을 잃지 않게 .old를 남긴다.
Function RollBack
  ; File 명령이 작업 폴더를 설치 폴더 안으로 옮겨 두었을 수 있다. 작업 폴더는 지울 수 없으므로 밖으로 나간다.
  SetOutPath "$TEMP"
  ${If} $MOVED = 1
    StrCpy $RESTORE_FAILED 0
    Push "bin"
    Call RestoreOne
    Push "node"
    Call RestoreOne
    Push "server"
    Call RestoreOne
    Push "web"
    Call RestoreOne
    ${If} $RESTORE_FAILED = 0
      RMDir /r "$INSTDIR\.old"
    ${EndIf}
    ${If} $OLDVER != ""
      WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "$OLDVER"
    ${EndIf}
  ${EndIf}
  CreateDirectory "${UPDATES_DIR}"
  FileOpen $R0 "${UPDATES_DIR}\rolled-back" w
  FileWrite $R0 "${VERSION}"
  FileClose $R0
  Exec '"$INSTDIR\bin\AetherHost.exe"'
FunctionEnd

; 파일 복사 실패와 Abort는 모두 여기로 온다. 화면 없는 실행에서도 불린다.
Function .onInstFailed
  ${If} $UPDATE = 1
    Call RollBack
  ${EndIf}
FunctionEnd

Section "Aether"
  Call CheckInstDir

  ; bin\AetherHost.exe가 있으면 이전 Aether 설치다. 표시가 없는데 우리가 쓸 이름의 폴더가 이미 있으면 남의 것이므로 중단한다.
  ${IfNot} ${FileExists} "$INSTDIR\bin\AetherHost.exe"
    ${If} ${FileExists} "$INSTDIR\bin\*.*"
    ${OrIf} ${FileExists} "$INSTDIR\node\*.*"
    ${OrIf} ${FileExists} "$INSTDIR\server\*.*"
    ${OrIf} ${FileExists} "$INSTDIR\web\*.*"
      MessageBox MB_OK|MB_ICONSTOP "$(MSG_FOREIGN)" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}

  ; 시험 설치는 이미 깔린 진짜 Aether를 건드리지 않는다.
  ${If} $TEST = 0
    Call DetectRunning
    ${If} $0 = 1
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(MSG_RUNNING)" /SD IDYES IDYES stopok
      Abort
      stopok:
    ${EndIf}
    DetailPrint "$(MSG_STOPPING)"
    Call StopAether
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\bin\AetherHost.exe"
    DetailPrint "$(MSG_REMOVING)"
    ${If} $UPDATE = 1
      ReadRegStr $OLDVER HKCU "${UNINST_KEY}" "DisplayVersion"
      ; 감시 프로그램이 물려준 작업 폴더가 설치 폴더 안이면 옮기기가 잠긴다.
      SetOutPath "$TEMP"
      ; shortcut: 전원이 꺼지는 등으로 설치가 중간에 끊긴 경우는 복구하지 않는다. 사용자가 설치 파일을 다시 실행하면 고쳐진다. 실제로 일어나면 시작 때 .old 복구를 더한다.
      RMDir /r "$INSTDIR\.old"
      ; 지난 .old가 일부라도 남아 있으면 되돌릴 때 정상 파일을 덮어쓰므로 옮기기 전에 멈춘다.
      ${If} ${FileExists} "$INSTDIR\.old"
        Abort
      ${EndIf}
      CreateDirectory "$INSTDIR\.old"
      StrCpy $MOVED 1
      Push "bin"
      Call MoveAside
      Push "node"
      Call MoveAside
      Push "server"
      Call MoveAside
      Push "web"
      Call MoveAside
    ${Else}
      RMDir /r "$INSTDIR\bin"
      RMDir /r "$INSTDIR\node"
      RMDir /r "$INSTDIR\server"
      RMDir /r "$INSTDIR\web"
    ${EndIf}
  ${EndIf}

  DetailPrint "$(MSG_COPYING)"
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r "${SRC}\bin"
  File /r "${SRC}\node"
  File /r "${SRC}\server"
  File /r "${SRC}\web"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "$(MSG_COPY_FAIL)" /SD IDOK
    Abort
  ${EndIf}

  ${If} $TEST = 0
    ; 로그인할 때 감시자가 서버를 띄운다.
    WriteRegStr HKCU "${RUN_KEY}" "Aether" '"$INSTDIR\bin\AetherHost.exe"'
    ; 바로가기는 설정 폴더의 Aether.url(서버가 현재 포트로 다시 씀)을 가리킨다.
    ; shortcut: 다른 프로그램이 만든 Aether.lnk도 덮어쓴다(대상 확인에 플러그인이 필요), 이름 충돌이 문제가 되면 대상 확인을 더한다.
    CreateShortCut "$DESKTOP\Aether.lnk" "$APPDATA\Aether\Aether.url"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Aether"
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Aether"
    WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
    Delete "${UPDATES_DIR}\ok-${VERSION}"
    ; 첫 설치면 서버가 설정 화면용 서버로 떠서 브라우저를 연다.
    Exec '"$INSTDIR\bin\AetherHost.exe"'
    ${If} $UPDATE = 1
      ; 새 서버가 정해진 시간 안에 뜨지 않으면 이전 버전으로 되돌린다.
      StrCpy $R2 0
      waitok:
        ${If} ${FileExists} "${UPDATES_DIR}\ok-${VERSION}"
          Delete "${UPDATES_DIR}\ok-${VERSION}"
          RMDir /r "$INSTDIR\.old"
          Goto waited
        ${EndIf}
        IntOp $R2 $R2 + 1
        Sleep 1000
        IntCmp $R2 ${HEALTHY_WAIT_SECONDS} 0 waitok
      Call StopAether
      Call RollBack
      waited:
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Uninstall"
  Call un.CheckInstDir
  ; Aether 설치 폴더가 맞을 때만 지운다(_?=가 엉뚱한 폴더를 가리키거나 복사본을 실행한 경우 방어).
  ${IfNot} ${FileExists} "$INSTDIR\bin\AetherHost.exe"
  ${OrIfNot} ${FileExists} "$INSTDIR\server\index.mjs"
    MessageBox MB_OK|MB_ICONSTOP "$(MSG_NOT_AETHER)" /SD IDOK
    Abort
  ${EndIf}

  ; 등록된 설치를 지울 때만 실행 중인 프로세스와 등록 항목을 정리한다. 시험 설치를 지우다 진짜 설치를 건드리지 않기 위해서다.
  ReadRegStr $1 HKCU "${UNINST_KEY}" "InstallLocation"
  ${If} $1 == $INSTDIR
    ; 폰 접속을 켜 둔 채 지우면 같은 포트의 다른 프로그램이 Tailscale 망에 열린다. 실패해도 제거는 계속한다.
    nsExec::Exec '"$INSTDIR\node\AetherNode.exe" "$INSTDIR\server\index.mjs" --remote-off'
    Pop $0
    Call un.StopAether
    DeleteRegValue HKCU "${RUN_KEY}" "Aether"
    Delete "$DESKTOP\Aether.lnk"
    DeleteRegKey HKCU "${UNINST_KEY}"
    RMDir /r "${UPDATES_DIR}"
  ${EndIf}

  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\web"
  RMDir /r "$INSTDIR\.old"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; 설정과 기본 데이터는 등록된 설치를 대화형으로 지울 때만, 사용자가 예를 고르면 지운다. /S에서는 항상 남긴다.
  ${If} $1 == $INSTDIR
  ${AndIf} $APPDATA != ""
  ${AndIf} $LOCALAPPDATA != ""
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(MSG_ASK_DATA)" /SD IDNO IDNO keepdata
    RMDir /r "$APPDATA\Aether"
    RMDir /r "$LOCALAPPDATA\Aether"
    keepdata:
  ${EndIf}
SectionEnd
