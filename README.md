# Chimpanzé Player — código-fonte v1.5.0

App Electron 44 (Windows). Ponto de entrada: `src/main/main.js`.

## Estrutura
- `src/main/` — processo principal: biblioteca (`library.js`), metadados IMDb/AniList/TVmaze (`metadata.js`),
  player mpv via IPC (`player.js`, `mpv-ipc.js`), perfil de vídeo e script VapourSynth/RIFE (`video-profile.js`),
  motor RTX/TensorRT (`rtx.js`), qBittorrent (`qbit.js`), fontes/adblock (`sources.js`), Prowlarr, configurações.
- `src/preload/` — pontes seguras para a interface.
- `src/renderer/` — interface (biblioteca estilo streaming, overlay do player, configurações).
- `build/` — ícone e `installer.nsh` (instala o qBittorrent via winget durante a instalação).
- `resources/` — recursos extras copiados para a pasta do app (`extraResources`).

## Binários que NÃO estão neste pacote (são grandes)
Copie da instalação atual, em `%LOCALAPPDATA%\Programs\ChimpanzePlayer\resources\`, para `resources/` deste projeto:
- `mpv/` — mpv (build shinchiro) com vapoursynth
- `vs/python/` — Python 3.12 embutido + VapourSynth R79 + NumPy
- `vs/rife/` — librife (ncnn/Vulkan) e modelos
- `vs/rtx/` — `vstrt.dll`, `trtexec.exe`, `7zr.exe` e `models/rife_v2/*.onnx`
  (os `.py` já estão aqui)
- `elevate.exe`

O TensorRT (~2,5 GB, `vsmlrt-cuda.v15.16.7z.001/.002` do vs-mlrt v15.16) é baixado pelo próprio app
na primeira execução, em `%APPDATA%\ChimpanzePlayer\runtime\rtx\`.

## Rodar e compilar
```
npm install
npm start          # modo desenvolvimento
npm run dist       # gera o instalador NSIS em dist/
```

## Estado atual (1.5.0)
- Player numa janela só: vídeo (mpv) e controles ligados pelo Windows (`src/main/win32.js`, biblioteca `koffi`).
- IA de 60 FPS não desliga mais sozinha (auto-ajuste mede só quadros perdidos e ignora janela minimizada).
- Fluidez: só "60 FPS (IA RTX)" (padrão) e "Original". RIFE v4.25 lite via vs-mlrt TensorRT, fp16, `_implementation=2`.
- Metadados: IMDb (GraphQL `caching.graphql.imdb.com`, pt-BR) como principal; AniList/TVmaze/iTunes como apoio.
- Primeira execução: configura o qBittorrent e prepara o motor RTX sozinho.
- Pendente: upscaling 4K (adiado).
