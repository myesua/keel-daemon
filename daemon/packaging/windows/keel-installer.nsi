; =============================================================================
; Keel — Windows installer (NSIS 3.x)
;
; Installs the tray build of keel.exe, adds Start Menu shortcuts,
; registers Keel to start at login (HKCU Run key — per-user, no admin-only
; service), and offers to launch it right away. Result: install, launch,
; tray icon appears, daemon is running. No terminal.
;
; Build (after build-windows.ps1 has produced keel.exe next to this
; script):   makensis keel-installer.nsi
; Output:    KeelSetup.exe
; =============================================================================

!include "MUI2.nsh"

Name "Keel"
OutFile "KeelSetup.exe"
Unicode True
; Per-user install: no UAC prompt, and the login autostart is per-user anyway.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Keel"

!define APP_EXE "keel.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Keel"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

; Optional branded icon: drop keel.ico next to this script before makensis.
!if /FileExists "keel.ico"
  !define MUI_ICON "keel.ico"
  !define MUI_UNICON "keel.ico"
!endif

!define MUI_WELCOMEPAGE_TITLE "Welcome to Keel"
!define MUI_WELCOMEPAGE_TEXT "Keel connects to YOUR Chrome — not a copy, not a sandbox — so its agent can work live pages while you watch.$\r$\n$\r$\nThis installs a small tray app. Launch it, the Keel icon appears next to your clock, and the web app connects automatically."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Keel now"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Keel" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File "${APP_EXE}"

  ; Start Menu shortcut
  CreateDirectory "$SMPROGRAMS\Keel"
  CreateShortcut "$SMPROGRAMS\Keel\Keel.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\Keel\Uninstall Keel.lnk" "$INSTDIR\Uninstall.exe"

  ; Start at login (per-user). Delete this key to opt out.
  WriteRegStr HKCU "${RUN_KEY}" "Keel" '"$INSTDIR\${APP_EXE}"'

  ; Uninstaller + Add/Remove Programs entry
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Keel"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "0.1.6"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Keel"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" '"$INSTDIR\${APP_EXE}"'
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Stop a running instance so the exe can be removed.
  ExecWait 'taskkill /F /IM ${APP_EXE}'
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Keel\Keel.lnk"
  Delete "$SMPROGRAMS\Keel\Uninstall Keel.lnk"
  RMDir "$SMPROGRAMS\Keel"
  DeleteRegValue HKCU "${RUN_KEY}" "Keel"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; Keel never touches the user's Chrome profile — nothing else to clean up.
SectionEnd
