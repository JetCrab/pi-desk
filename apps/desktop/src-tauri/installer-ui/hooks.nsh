!ifndef PI_DESK_INSTALLER_UI_HOOKS
!define PI_DESK_INSTALLER_UI_HOOKS

!ifndef MAINBINARYSRCPATH
  !error "必须在定义 MAINBINARYSRCPATH 后加载安装界面钩子。"
!endif

!system 'node "${__FILEDIR__}\..\..\scripts\build-installer-ui.mjs" "${MAINBINARYSRCPATH}.installer-ui"' = 0
!addplugindir /x86-unicode "${MAINBINARYSRCPATH}.installer-ui"

!endif
