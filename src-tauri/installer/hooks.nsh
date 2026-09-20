    Var DeleteUserData

    !macro NSIS_HOOK_PREUNINSTALL

    ; 移除「开机自动启动」计划任务。
    ; 任务名必须与 src-tauri/src/config.rs 中的 AUTOSTART_TASK_NAME 保持一致。
    ; 这里不依赖用户对下面「是否删除数据」的选择：任务若残留，会指向已被删除的 exe。
    DetailPrint "正在移除开机自启计划任务..."
    ExecWait '"$SYSDIR\schtasks.exe" /Delete /TN "SillyTavern Launcher GUI" /F'

    !ifdef LANG_SIMPCHINESE
        !define DeleteDataQuestion_CN "是否同时删除所有用户数据？$\n$\n包括：SillyTavern 版本、配置文件、日志等$\n$\n选择【是】将永久删除所有数据（不可恢复）$\n选择【否】将保留数据以便重新安装"
    !endif
    !ifdef LANG_ENGLISH
        !define DeleteDataQuestion_EN "Do you want to delete all user data?$\n$\nIncluding: SillyTavern versions, configs, logs, etc.$\n$\nYes = Delete all data (cannot be undone)$\nNo = Keep data for reinstallation"
    !endif

    !ifdef LANG_SIMPCHINESE
        MessageBox MB_YESNO|MB_ICONQUESTION "${DeleteDataQuestion_CN}" /SD IDNO IDYES pre_yes IDNO pre_no
    !else
        MessageBox MB_YESNO|MB_ICONQUESTION "${DeleteDataQuestion_EN}" /SD IDNO IDYES pre_yes IDNO pre_no
    !endif

    pre_yes:
        StrCpy $DeleteUserData "1"
        Goto pre_done

    pre_no:
        StrCpy $DeleteUserData "0"

    pre_done:

    !macroend



    !macro NSIS_HOOK_POSTUNINSTALL

    StrCmp $DeleteUserData "1" post_delete post_skip

    post_delete:
        DetailPrint "正在删除用户数据..."
        ; Remove junctions before recursive delete to prevent wiping linked standalone instances
        RMDir "$INSTDIR\data\sillytavern\*"
        RMDir /r "$INSTDIR\data\st_data"
        RMDir /r "$INSTDIR\data\node"
        RMDir /r "$INSTDIR\data\git"
        RMDir /r "$INSTDIR\data\logs"
        RMDir /r "$INSTDIR\data\sillytavern"
        Delete "$INSTDIR\data\config.json"
        RMDir "$INSTDIR\data"
        DetailPrint "用户数据已删除"
        Goto post_done

    post_skip:
        DetailPrint "已保留用户数据"

    post_done:

    !macroend