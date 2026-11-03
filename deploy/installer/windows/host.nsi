; AetherHost.exe: 창 없는 감시자. 서버(AetherNode.exe)를 숨겨진 콘솔에서 띄우고, 죽으면 다시 띄운다.
; 컴파일: makensis -DOUTFILE=<AetherHost.exe 경로> host.nsi
; 위치: <프로그램 폴더>\bin\AetherHost.exe (프로그램 폴더 = 이 파일 폴더의 부모)
Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
!ifndef OUTFILE
  !error "OUTFILE을 -DOUTFILE=...로 지정하세요."
!endif

Name "AetherHost"
OutFile "${OUTFILE}"
SilentInstall silent
RequestExecutionLevel user
AutoCloseWindow true
ShowInstDetails nevershow
CRCCheck off

; 이름 있는 뮤텍스로 한 로그인 세션에 하나만 뜬다. 이미 있으면(오류 183) 조용히 끝낸다.
Function .onInit
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "Local\AetherHostMutex") p .r1 ?e'
  Pop $0
  ${If} $0 = 183
    Quit
  ${EndIf}
FunctionEnd

Section
  ${GetParent} $EXEDIR $0
  ; 작업 폴더를 server로 둔다(자식 프로세스가 물려받는다).
  SetOutPath "$0\server"
  System::Call 'kernel32::SetEnvironmentVariable(t "NODE_ENV", t "production") i .r9'
  ; 자동 실행 장치 아래에서 도는 설치본에서만 앱 안 업데이트를 켠다.
  System::Call 'kernel32::SetEnvironmentVariable(t "AETHER_SUPERVISED", t "1") i .r9'

  loop:
    System::Call 'kernel32::GetTickCount() i .r2'
    ; nsExec는 숨겨진 콘솔에서 실행하고 끝날 때까지 기다린다. 자식이 그 콘솔을 물려받아 창이 번쩍이지 않는다.
    nsExec::Exec '"$0\node\AetherNode.exe" "$0\server\index.mjs"'
    Pop $1
    ; 종료 코드 0은 사용자가 의도한 정상 종료다. 그 밖(재시작 API의 코드 1, 충돌, 실행 실패 "error")은 다시 띄운다.
    StrCmp $1 "0" done
    ; 코드 75는 서버가 서명을 확인한 설치 파일을 받아 두었다는 뜻이다(server/update/install.ts).
    ; 서버의 자식으로 실행하면 설치 프로그램의 프로세스 트리 종료에 함께 꺼지므로 감시 프로그램이 실행하고 먼저 끝난다.
    StrCmp $1 "75" 0 keepgoing
    IfFileExists "$APPDATA\Aether\updates\Aether-update.exe" 0 loop
    ; Exec는 지금 출력 폴더를 작업 폴더로 물려주므로, server 폴더가 잠기지 않게 밖으로 옮긴다.
    SetOutPath "$APPDATA\Aether\updates"
    ClearErrors
    Exec '"$APPDATA\Aether\updates\Aether-update.exe" /S /UPDATE /D=$0'
    IfErrors 0 done
    SetOutPath "$0\server"
    Goto loop
    keepgoing:
    System::Call 'kernel32::GetTickCount() i .r3'
    IntOp $3 $3 - $2
    ; 10초 안에 죽었으면 계속 죽는 것일 수 있으니 10초 쉰다. 오래 돌다 죽었으면 1초 뒤 다시 띄운다.
    ; IntCmpU 값1 값2 같으면 값1이작으면 값1이크면
    IntCmpU $3 10000 long short long
    short:
      Sleep 10000
      Goto loop
    long:
      Sleep 1000
      Goto loop
  done:
SectionEnd
