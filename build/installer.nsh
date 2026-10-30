!macro customInstall
  ; Fecha versões antigas em execução e instala o qBittorrent se ele não existir.
  nsExec::Exec 'taskkill /f /im mpv.exe'
  IfFileExists "$PROGRAMFILES64\qBittorrent\qbittorrent.exe" qbok 0
  IfFileExists "$PROGRAMFILES32\qBittorrent\qbittorrent.exe" qbok 0
  IfFileExists "$LOCALAPPDATA\Programs\qBittorrent\qbittorrent.exe" qbok 0
  DetailPrint "Instalando o qBittorrent (necessário para downloads)..."
  nsExec::ExecToLog 'winget install -e --id qBittorrent.qBittorrent --silent --accept-package-agreements --accept-source-agreements'
  qbok:
!macroend
