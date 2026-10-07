!define LEGACY_NAME "JetCrab Desktop"
!define LEGACY_BINARY "jetcrab-desktop.exe"
!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_NAME}"
!define LEGACY_PRODUCTKEY "Software\jetcrab\${LEGACY_NAME}"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "${LEGACY_UNINSTKEY}" "DisplayName"
  ReadRegStr $R1 HKCU "${LEGACY_UNINSTKEY}" "UninstallString"
  ${If} $R0 == ""
  ${AndIf} $R1 == ""
    Goto legacy_done
  ${EndIf}

  ReadRegStr $R2 HKCU "${LEGACY_UNINSTKEY}" "Publisher"
  ReadRegStr $R3 HKCU "${LEGACY_UNINSTKEY}" "MainBinaryName"
  ReadRegStr $R8 HKCU "${LEGACY_PRODUCTKEY}" ""
  ReadRegStr $R9 HKCU "${LEGACY_UNINSTKEY}" "InstallLocation"
  ${If} $R0 != "${LEGACY_NAME}"
  ${OrIf} $R2 != "jetcrab"
  ${OrIf} $R3 != "${LEGACY_BINARY}"
  ${OrIf} $R8 == ""
    Goto legacy_error
  ${EndIf}
  StrCmp $R9 '"$R8"' 0 legacy_error
  StrCmp $R1 '"$R8\uninstall.exe"' 0 legacy_error
  IfFileExists "$R8\uninstall.exe" 0 legacy_error

  !insertmacro CheckIfAppIsRunning "${LEGACY_BINARY}" "${LEGACY_NAME}"

  ; /UPDATE 保留共用应用数据；检查进程的宏会覆盖 $R1，命令须从已校验的目录重建。
  ClearErrors
  ExecWait '"$R8\uninstall.exe" /UPDATE /S _?=$R8' $R0
  IfErrors legacy_error
  StrCmp $R0 0 0 legacy_error
  ReadRegStr $R0 HKCU "${LEGACY_UNINSTKEY}" "UninstallString"
  StrCmp $R0 "" 0 legacy_error
  IfFileExists "$R8\${LEGACY_BINARY}" legacy_error
  Delete "$R8\uninstall.exe"
  RMDir "$R8"

  ; /UPDATE 保留安装位置注册值，只清理旧安装拥有的已知值。
  DeleteRegValue HKCU "${LEGACY_PRODUCTKEY}" ""
  DeleteRegValue HKCU "${LEGACY_PRODUCTKEY}" "Installer Language"
  DeleteRegKey /ifempty HKCU "${LEGACY_PRODUCTKEY}"
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${LEGACY_NAME}"
  StrCmp $R0 '"$R8\${LEGACY_BINARY}"' 0 +2
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${LEGACY_NAME}"

  ; /UPDATE 保留快捷方式，只删除仍指向旧程序的入口。
  !insertmacro IsShortcutTarget "$DESKTOP\${LEGACY_NAME}.lnk" "$R8\${LEGACY_BINARY}"
  Pop $R0
  ${If} $R0 = 1
    !insertmacro UnpinShortcut "$DESKTOP\${LEGACY_NAME}.lnk"
    Delete "$DESKTOP\${LEGACY_NAME}.lnk"
    IfFileExists "$DESKTOP\${LEGACY_NAME}.lnk" legacy_error
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${LEGACY_NAME}\${LEGACY_NAME}.lnk" "$R8\${LEGACY_BINARY}"
  Pop $R0
  ${If} $R0 = 1
    !insertmacro UnpinShortcut "$SMPROGRAMS\${LEGACY_NAME}\${LEGACY_NAME}.lnk"
    Delete "$SMPROGRAMS\${LEGACY_NAME}\${LEGACY_NAME}.lnk"
    IfFileExists "$SMPROGRAMS\${LEGACY_NAME}\${LEGACY_NAME}.lnk" legacy_error
    RMDir "$SMPROGRAMS\${LEGACY_NAME}"
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${LEGACY_NAME}.lnk" "$R8\${LEGACY_BINARY}"
  Pop $R0
  ${If} $R0 = 1
    !insertmacro UnpinShortcut "$SMPROGRAMS\${LEGACY_NAME}.lnk"
    Delete "$SMPROGRAMS\${LEGACY_NAME}.lnk"
    IfFileExists "$SMPROGRAMS\${LEGACY_NAME}.lnk" legacy_error
  ${EndIf}
  Goto legacy_done

  legacy_error:
    Abort "无法安全迁移 JetCrab Desktop，请检查旧安装后重试。"
  legacy_done:
!macroend
