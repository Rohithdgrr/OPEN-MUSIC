; windows-deeplink.nsh — NSIS installer hook (docs/share-deep-links.md §4).
; Registers the `openmusic` URL scheme so Windows Start-menu/Run/browser
; launches hand `openmusic://t/<id>` to the installed app. Per-user scope
; (SHCTX) — no admin needed. Mirrors tauri-plugin-deep-link's documented
; NSIS registration; MSI builds do not register the scheme (stated limit).
!macro NSIS_HOOK_PREINSTALL
  WriteRegStr SHCTX "Software\Classes\openmusic" "" "URL:OpenMusic deep link"
  WriteRegStr SHCTX "Software\Classes\openmusic" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\openmusic\DefaultIcon" "" "${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\openmusic\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend
