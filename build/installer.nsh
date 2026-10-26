; Extra installer steps (electron-builder picks up build/installer.nsh on its own).
;
; Windows drops a desktop app's notifications until it knows the app id. A Start
; Menu shortcut carrying the id is the usual way in, but Windows can take until
; the next sign-in to list a new shortcut, and until then it drops every
; notification silently (seen 2026-10-21). Registering the id under the user's
; own classes key is read at once, so notifications work right after install.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\AppUserModelId\com.squad.desktop" "DisplayName" "Squad"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\com.squad.desktop" "IconUri" "$INSTDIR\resources\icon.png"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.squad.desktop"
!macroend
