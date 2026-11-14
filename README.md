<div align="center">

<img src="src/renderer/assets/icon.png" width="140" alt="Chimpanzé Player">

# Chimpanzé Player

**Your own Netflix, with your own files.**
**Sua própria Netflix, com os seus arquivos.**

![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?style=for-the-badge&logo=windows)
![60 FPS](https://img.shields.io/badge/60%20FPS-NVIDIA%20RTX-76B900?style=for-the-badge&logo=nvidia&logoColor=white)
[![Pix](https://img.shields.io/badge/apoie-Pix-32BCAD?style=for-the-badge&logo=pix&logoColor=white)](#-apoie--support)

[English](#english) · [Português](#português)

</div>

---

## English

Point Chimpanzé Player at your movie, series and anime folders and it becomes a streaming service on your PC: posters, synopses, ratings, seasons and episodes, "continue watching", and a player with smooth 60 FPS motion on NVIDIA RTX cards. Everything stays on your computer.

### Highlights
- **Streaming-style library:** Home, Movies, Series and Anime, with "Continue watching", "Recently added", "Top rated", genres and search.
- **Automatic covers and info** from IMDb, AniList, TVmaze and Apple TV (TMDB key optional). Fix a title, change the cover or register it by hand when needed.
- **Episodes and resume:** seasons, specials, next episode countdown and resume from where you stopped.
- **Smooth 60 FPS** on NVIDIA RTX: frame interpolation (RIFE) accelerated with TensorRT, with automatic adjustment against stutters.
- **Image and sound controls** in the player: color and light, sharpness, debanding, audio and subtitle tracks, speed, statistics and keyboard shortcuts.
- **Integrated downloads:** add `.torrent` files or magnet links, watch while it downloads (sequential mode), all through qBittorrent configured for you.
- **Your sources, without ads:** keep the sites you trust in one place with a built-in ad and pop-up blocker; optional indexer search via Prowlarr.

### Requirements

| | Minimum | Recommended |
|---|---|---|
| System | Windows 10 or 11, 64-bit | Windows 11 |
| Graphics card | any with DirectX 11 | NVIDIA RTX (for 60 FPS) |
| Memory | 8 GB RAM | 16 GB RAM |
| Disk | ~1 GB | ~4 GB with the 60 FPS engine |

- **60 FPS engine:** NVIDIA RTX card; about 2.5 GB is downloaded and prepared automatically on first run.
- **Downloads:** qBittorrent (the installer installs it for you).
- **Optional:** Prowlarr (indexer search) and a TMDB API key (more covers).

---

## Português

Aponte o Chimpanzé Player para as suas pastas de filmes, séries e animes e ele vira um serviço de streaming no seu PC: capas, sinopses, notas, temporadas e episódios, "continuar assistindo" e um player com movimento suave a 60 FPS nas placas NVIDIA RTX. Tudo fica no seu computador.

### Destaques
- **Biblioteca estilo streaming:** Início, Filmes, Séries e Animes, com "Continuar assistindo", "Adicionados recentemente", "Mais bem avaliados", gêneros e busca.
- **Capas e informações automáticas** do IMDb, AniList, TVmaze e Apple TV (chave do TMDB opcional). Corrija um título, troque a capa ou cadastre à mão quando precisar.
- **Episódios e retomada:** temporadas, especiais, contagem para o próximo episódio e volta de onde parou.
- **60 FPS suaves** na NVIDIA RTX: interpolação de quadros (RIFE) acelerada por TensorRT, com auto-ajuste contra travadas.
- **Controles de imagem e som** no player: cor e luz, nitidez, remoção de faixas (debanding), faixas de áudio e legenda, velocidade, estatísticas e atalhos de teclado.
- **Downloads integrados:** abra `.torrent` ou cole um magnet link e assista enquanto baixa (modo sequencial), tudo pelo qBittorrent configurado sozinho.
- **Suas fontes, sem anúncios:** guarde os sites em que você confia num lugar só, com bloqueador de anúncios e pop-ups; busca em indexadores pelo Prowlarr (opcional).

### Requisitos

| | Mínimo | Recomendado |
|---|---|---|
| Sistema | Windows 10 ou 11, 64 bits | Windows 11 |
| Placa de vídeo | qualquer uma com DirectX 11 | NVIDIA RTX (para 60 FPS) |
| Memória | 8 GB de RAM | 16 GB de RAM |
| Disco | ~1 GB | ~4 GB com o motor de 60 FPS |

- **Motor de 60 FPS:** placa NVIDIA RTX; cerca de 2,5 GB são baixados e preparados sozinhos na primeira vez.
- **Downloads:** qBittorrent (o instalador já instala).
- **Opcional:** Prowlarr (busca em indexadores) e uma chave da API do TMDB (mais capas).

**Dica de organização:** `Filmes/Nome (Ano).mkv` · `Séries/Nome da Série/Temporada 1/` · `Animes/Nome/`

---

## 💚 Apoie / Support

O Chimpanzé Player é gratuito. Se ele te ajudou e você quiser apoiar o desenvolvimento, qualquer valor é bem-vindo.
Chimpanzé Player is free. If you enjoy it and want to support its development, any amount helps.

**Chave Pix / Pix key (aleatória / random):**

```
89209399-d0a0-44ba-98ce-794483f4f853
```

---

<details>
<summary><sub>Para desenvolvedores / For developers</sub></summary>

Electron 44 (Windows). Ponto de entrada: `src/main/main.js`.

- `src/main/`: biblioteca (`library.js`), metadados (`metadata.js`), player mpv via IPC (`player.js`, `mpv-ipc.js`), perfil de vídeo e RIFE (`video-profile.js`), motor RTX/TensorRT (`rtx.js`), qBittorrent (`qbit.js`), fontes e bloqueador (`sources.js`), Prowlarr, configurações.
- `src/preload/`: pontes seguras para a interface. `src/renderer/`: interface.
- `build/`: ícone e `installer.nsh` (instala o qBittorrent via winget).

Binários grandes que não estão no repositório (copie de `%LOCALAPPDATA%\Programs\ChimpanzePlayer\resources\` para `resources/`): `mpv/`, `vs/python/`, `vs/rife/`, `vs/rtx/` (`vstrt.dll`, `trtexec.exe`, `7zr.exe`, `models/rife_v2/*.onnx`) e `elevate.exe`.

```
npm install
npm start          # desenvolvimento
npm run dist       # instalador NSIS em dist/
```
</details>
