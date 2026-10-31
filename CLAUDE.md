# Chimpanzé Player — guia para o Claude Code

App pessoal do John (Electron 44, Windows). Leia também o `README.md`.

## Como o John trabalha
- Não é programador experiente: explique em português simples e faça as mudanças por ele.
- Entrega desejada: instalador `.exe` completo (nunca scripts de atualização), app pronto após instalar.
- PC: RTX 5070 (12 GB), monitores 1080p 300 Hz e 120 Hz. Vídeos típicos: HEVC 10 bits 1080p.

## Arquitetura
- Interface Electron = overlay transparente; o vídeo roda numa janela própria do **mpv** (IPC por named pipe). (Embutir com `--wid` dava tela preta.)
- As duas janelas são ligadas pelo Windows (`win32.js`, via `koffi`): a do mpv é "dona" da dos controles, então se comportam como uma janela só (um botão na barra de tarefas, um item no Alt+Tab, movem/minimizam juntas). Antes de o mpv fechar é obrigatório desligar (`unlink`), senão o Windows destrói os controles junto.
- Auto-ajuste da IA conta só quadros **perdidos**: "quadros atrasados" ficam em ~10/s com a IA a 60 FPS num monitor de alta taxa mesmo com folga, e antes faziam a IA desligar em ~40 s.
- Fluidez: filtro `vapoursynth` do mpv → `video-profile.js` gera o `.vpy` → RIFE v4.25 lite via **vs-mlrt TensorRT** (`Backend.TRT`, fp16, `output_format=1`, `_implementation=2`, `video_player=True`). VapourSynth **R79** (R80+ quebra a API3).
- Só existem os modos "60 FPS (IA RTX)" (padrão) e "Original". Acima de 60 FPS não acompanhou na RTX 5070.
- TensorRT (~2,5 GB) é baixado e preparado sozinho na primeira execução (`rtx.js` com download retomável); motores ficam em `%APPDATA%\ChimpanzePlayer\runtime\rtx\`.
- Metadados: IMDb GraphQL (`caching.graphql.imdb.com`, cabeçalhos pt-BR) como principal; AniList, TVmaze e iTunes de apoio (`metadata.js`).
- qBittorrent: WebUI configurada sozinha (senha PBKDF2-SHA512); o instalador instala o qBittorrent via winget (`build/installer.nsh`).

## Pendências / ideias
- Upscaling 1080p → 4K (adiado pelo John).
- Build no Windows com `npm run dist` testado em 31/10/2026 e funcionando (antes copie os binários da instalação para `resources/`, ver README).
