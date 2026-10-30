'use strict';
/* Configurações */
(function (App) {
  const { h, icon } = App;
  App.views = App.views || {};

  const SECTIONS = [
    ['library', 'Biblioteca'],
    ['metadata', 'Capas e informações'],
    ['player', 'Reprodução'],
    ['video', 'Imagem e IA'],
    ['torrent', 'qBittorrent'],
    ['prowlarr', 'Prowlarr'],
    ['sources', 'Fontes'],
    ['about', 'Sobre'],
  ];

  async function save(patch, msg) {
    App.state.settings = await window.chimp.setSettings(patch);
    if (msg) App.toast(msg, 'ok');
  }

  function field(label, input, hint) {
    return h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  }

  function textInput(value, onsave, opts = {}) {
    const i = h('input', { class: 'input', value: value || '', type: opts.type || 'text', placeholder: opts.placeholder || '', spellcheck: 'false' });
    i.addEventListener('change', () => onsave(i.value.trim()));
    return i;
  }

  function select(options, value, onchange) {
    const s = h('select', { class: 'select', style: { height: '40px', width: '100%' } }, options.map(([v, l]) => { const o = h('option', { value: v }, l); if (String(v) === String(value)) o.selected = true; return o; }));
    s.addEventListener('change', () => onchange(s.value));
    return s;
  }

  // Painel do motor RTX (TensorRT para RTX).
  function rtxPanel() {
    const statusEl = h('span', { class: 'status-pill' }, 'Verificando…');
    const body = h('div');
    const bar = h('div', { class: 'dl-bar', style: { margin: '14px 0 8px' }, hidden: true }, h('i', { style: { width: '0%' } }));
    const progText = h('div', { class: 'hint', hidden: true });
    const MODEL_LABEL = { fast: 'Rápido', balanced: 'Equilibrado', quality: 'Qualidade' };

    async function refresh() {
      let st;
      try { st = await window.chimp.rtx.status(); } catch (e) { st = { supported: false, lastError: e.message }; }
      statusEl.className = `status-pill ${st.installed ? 'ok' : st.busy ? '' : 'err'}`;
      statusEl.textContent = st.installed ? 'Instalado' : st.busy ? 'Preparando…' : 'Não instalado';
      const rows = [];
      if (!st.supported) {
        rows.push(h('p', { class: 'sub' }, 'O motor RTX está disponível apenas no Windows com placa NVIDIA RTX.'));
      } else if (!st.nvidia) {
        rows.push(h('p', { class: 'sub' }, 'Nenhuma placa NVIDIA foi detectada. Use o motor Vulkan.'));
      } else if (st.installed) {
        rows.push(h('p', { class: 'sub' }, `TensorRT ativo${st.device ? ' na ' + st.device : ''}. Cada modelo é otimizado para a sua placa uma única vez.`));
        const kv = h('div', { class: 'kv' });
        for (const k of ['fast', 'balanced', 'quality']) {
          const e = st.engines[k];
          const txt = e && e.ok
            ? `Pronto${e.fps && e.fps['1920x1080'] ? ` · ~${Math.round(e.fps['1920x1080'])} quadros/s em 1080p` : ''}${e.fp16 === false ? ' · FP32' : ' · FP16'}`
            : e && e.error ? 'Falhou: ' + e.error : 'Ainda não otimizado';
          kv.append(h('div', { class: 'k' }, `Modelo ${MODEL_LABEL[k]}`), h('div', null, txt,
            !(e && e.ok) ? h('button', { class: 'btn btn-xs btn-ghost', style: { marginLeft: '8px' }, disabled: !!st.busy, onclick: () => { window.chimp.rtx.build(k); App.toast('Otimizando… acompanhe o progresso aqui.', 'info'); } }, 'Otimizar agora') : null));
        }
        rows.push(kv);
        rows.push(h('div', { class: 'hero-actions', style: { marginTop: '14px' } },
          h('button', { class: 'btn btn-sm btn-outline', onclick: () => window.chimp.rtx.openLog() }, 'Ver registro técnico'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
            if (!(await App.confirm('Remover motor RTX', 'Remover o TensorRT e os motores otimizados? Você pode instalar de novo depois.', { okLabel: 'Remover', danger: true }))) return;
            await window.chimp.rtx.uninstall(); refresh();
          } }, icon('trash'), 'Remover')));
      } else {
        rows.push(h('p', { class: 'sub' }, 'Gera os quadros extras (RIFE) nos Tensor Cores da sua RTX para os vídeos rodarem a 60 FPS. Na primeira vez que o app abre, ele prepara tudo sozinho: baixa o TensorRT da NVIDIA (≈2,5 GB) e otimiza a IA para a sua placa. Você pode usar o app enquanto isso; os botões abaixo só são necessários se algo falhar.'));
        if (st.lastError) rows.push(h('div', { class: 'status-note' }, icon('info'), st.lastError));
        rows.push(h('div', { class: 'hero-actions' },
          h('button', { class: 'btn btn-sm btn-accent', disabled: !!st.busy, onclick: () => { window.chimp.rtx.install(); bar.hidden = false; progText.hidden = false; progText.textContent = 'Iniciando…'; } }, icon('download'), 'Instalar motor RTX'),
          h('button', { class: 'btn btn-sm btn-outline', disabled: !!st.busy, onclick: async () => {
            const f = await window.chimp.shell.pickFile([{ name: 'vsmlrt-cuda (7z)', extensions: ['7z', '001'] }]);
            if (f) { window.chimp.rtx.install(f); bar.hidden = false; progText.hidden = false; progText.textContent = 'Iniciando…'; }
          } }, 'Já baixei o arquivo (.7z)'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => window.chimp.shell.open('https://github.com/AmusementClub/vs-mlrt/releases/tag/v15.16') }, 'Página do download')));
      }
      body.replaceChildren(...rows);
    }

    const off1 = window.chimp.on('rtx:progress', (p) => {
      if (!document.body.contains(panel)) { off1(); off2(); return; }
      bar.hidden = false;
      progText.hidden = false;
      progText.textContent = p.text;
      if (p.pct >= 0) bar.firstChild.style.width = `${Math.min(100, p.pct)}%`;
      if (p.done) {
        setTimeout(() => { bar.hidden = true; }, 1500);
        App.toast(p.pct < 0 ? p.text : 'Motor RTX pronto para usar!', p.pct < 0 ? 'error' : 'ok', { duration: 9000 });
        refresh();
      }
    });
    const off2 = window.chimp.on('rtx:build', (b) => {
      if (!document.body.contains(panel)) return;
      if (b.phase !== 'start') { refresh(); progText.hidden = b.phase === 'done'; bar.hidden = true; }
      else { progText.hidden = false; progText.textContent = 'Otimizando a IA para a sua placa (3 a 8 minutos)…'; bar.hidden = false; bar.firstChild.style.width = '92%'; }
    });

    const panel = h('div', { class: 'panel' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' } }, h('h3', { style: { margin: 0, flex: 1 } }, 'Motor RTX para fluidez (TensorRT)'), statusEl),
      body, bar, progText);
    refresh();
    return panel;
  }

  const builders = {
    library() {
      const s = App.state;
      const list = h('div', { class: 'folder-list' }, s.library.folders.map((f) => h('div', { class: 'folder-item' }, icon('folder'), h('div', { class: 'p', title: f }, f),
        h('button', { class: 'btn btn-xs btn-ghost', onclick: () => window.chimp.shell.open(f) }, 'Abrir'),
        h('button', { class: 'btn btn-xs btn-danger', onclick: async () => {
          if (!(await App.confirm('Remover pasta', `Remover “${f}” da biblioteca? Os arquivos não serão apagados.`, { okLabel: 'Remover', danger: true }))) return;
          await window.chimp.library.removeFolder(f);
        } }, 'Remover'))));
      if (!s.library.folders.length) list.append(h('div', { class: 'panel-empty' }, 'Nenhuma pasta adicionada.'));
      const items = App.allItems();
      const count = (k) => items.filter((i) => i.kind === k).length;
      const cacheEl = h('span', null, '…');
      window.chimp.library.cacheSize().then((b) => { cacheEl.textContent = App.fmtBytes(b); }).catch(() => {});
      return [
        h('div', { class: 'panel' }, h('h3', null, 'Pastas da biblioteca'),
          h('p', { class: 'sub' }, 'O Chimpanzé Player procura vídeos em todas as subpastas. Novos arquivos são detectados automaticamente.'),
          list,
          h('div', { class: 'hero-actions' },
            h('button', { class: 'btn btn-sm btn-accent', onclick: () => App.pickFolder() }, icon('plus'), 'Adicionar pasta'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: () => { window.chimp.library.scan(); App.toast('Procurando novos vídeos…'); } }, icon('refresh'), 'Procurar novos vídeos'))),
        h('div', { class: 'panel' }, h('h3', null, 'Resumo'),
          h('div', { class: 'kv' },
            h('div', { class: 'k' }, 'Séries'), h('div', null, String(count('series'))),
            h('div', { class: 'k' }, 'Animes'), h('div', null, String(count('anime'))),
            h('div', { class: 'k' }, 'Filmes'), h('div', null, String(count('movie'))),
            h('div', { class: 'k' }, 'Sem identificação'), h('div', null, String(items.filter((i) => i.metaStatus !== 'ok').length)),
            h('div', { class: 'k' }, 'Cache de imagens'), cacheEl),
          h('div', { class: 'hero-actions', style: { marginTop: '16px' } },
            h('button', { class: 'btn btn-sm btn-outline', onclick: () => { window.chimp.library.retryAll(); App.toast('Buscando novamente as informações que faltam…'); } }, icon('refresh'), 'Buscar informações que faltam'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await window.chimp.library.clearCache(); cacheEl.textContent = '0 B'; App.toast('Cache limpo. As imagens serão baixadas de novo quando necessário.', 'ok'); } }, icon('trash'), 'Limpar cache de imagens'))),
      ];
    },

    metadata() {
      const m = App.state.settings.metadata;
      return [h('div', { class: 'panel' }, h('h3', null, 'Fontes de capas e informações'),
        h('p', { class: 'sub' }, 'Sem configurar nada, uso AniList (animes), TVmaze (séries) e Apple TV/iTunes (filmes). Com uma chave gratuita do TMDB você ganha sinopses em português, fundos em alta resolução, logos dos títulos e fotos de cada episódio — o mesmo visual dos serviços de streaming.'),
        field('Chave da API do TMDB (opcional)', textInput(m.tmdbKey, (v) => save({ metadata: { tmdbKey: v } }, 'Chave salva. Use “Buscar informações que faltam” ou “Atualizar informações” para aplicar.'), { placeholder: 'Cole aqui a chave (v3) ou o token de leitura (v4)' }),
          h('span', null, 'Crie uma conta grátis em ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.chimp.shell.open('https://www.themoviedb.org/settings/api'); } }, 'themoviedb.org/settings/api'), '.')),
        field('Idioma das informações (TMDB)', select([['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'], ['en-US', 'Inglês'], ['es-ES', 'Espanhol']], m.language, (v) => save({ metadata: { language: v } }, 'Idioma salvo.'))),
        h('button', { class: 'btn btn-sm btn-outline', onclick: async () => {
          for (const it of App.allItems()) await window.chimp.library.refreshMeta(it.id);
          App.toast('Atualizando as informações de toda a biblioteca…');
        } }, icon('refresh'), 'Atualizar informações de toda a biblioteca'))];
    },

    player() {
      const p = App.state.settings.player;
      const set = (patch, msg) => save({ player: patch }, msg || 'Salvo.');
      return [
        h('div', { class: 'panel' }, h('h3', null, 'Reprodução'),
          App.toggleRow('Abrir o player em tela cheia', null, p.fullscreen, (v) => set({ fullscreen: v })),
          App.toggleRow('Reproduzir o próximo episódio automaticamente', 'Mostra uma contagem regressiva ao final de cada episódio.', p.autoNext, (v) => set({ autoNext: v })),
          h('div', { style: { height: '14px' } }),
          field('Pular (segundos) ao avançar/retroceder', select([[5, '5 segundos'], [10, '10 segundos'], [15, '15 segundos'], [30, '30 segundos']], p.skipSeconds, (v) => set({ skipSeconds: Number(v) }))),
          field('Idioma de áudio preferido', select([['', 'Original (padrão do arquivo)'], ['pt-BR,pt,por,pob', 'Português'], ['ja,jpn', 'Japonês'], ['en,eng', 'Inglês'], ['es,spa', 'Espanhol']], p.audioLang, (v) => set({ audioLang: v }))),
          field('Idioma de legendas preferido', select([['pt-BR,pt,por,pob,ptb', 'Português'], ['en,eng', 'Inglês'], ['es,spa', 'Espanhol'], ['no', 'Sem legendas']], p.subLang, (v) => set({ subLang: v })))),
        h('div', { class: 'panel' }, h('h3', null, 'Placa de vídeo'),
          h('p', { class: 'sub' }, App.state.gpu.name ? `GPU detectada: ${App.state.gpu.name}` : 'GPU não identificada.'),
          App.toggleRow('Forçar o uso da placa NVIDIA', 'Importante em notebooks com duas GPUs. Em desktops com uma só placa não faz diferença.', p.forceNvidia, (v) => set({ forceNvidia: v })),
          h('div', { style: { height: '14px' } }),
          field('API gráfica', select([['d3d11', 'Direct3D 11 (recomendado, ativa RTX Video Super Resolution e HDR)'], ['vulkan', 'Vulkan']], p.gpuApi, (v) => set({ gpuApi: v }))),
          field('Escalonador de imagem', select([['ewa_lanczossharp', 'EWA Lanczos Sharp (máxima qualidade)'], ['ewa_lanczos', 'EWA Lanczos'], ['spline36', 'Spline36 (equilibrado)'], ['bilinear', 'Bilinear (mais leve)']], p.scaler, (v) => set({ scaler: v })))),
      ];
    },

    video() {
      const v = App.state.settings.video;
      const set = (patch) => save({ video: patch }, 'Padrão de imagem salvo.');
      return [rtxPanel(), h('div', { class: 'panel' }, h('h3', null, 'Padrão de imagem para todos os vídeos'),
        h('p', { class: 'sub' }, 'Estes são os valores iniciais. Durante a reprodução, abra o painel “Imagem” (tecla E) para ajustar tudo ao vivo — e salvar por série, se quiser.'),
        field('Upscale com IA', select([['none', 'Desligado'], ['rtx', 'NVIDIA RTX Video Super Resolution'], ['anime4k-a', 'Anime4K — Restaurar (fontes 1080p)'], ['anime4k-b', 'Anime4K — Suave (fontes 720p)'], ['anime4k-c', 'Anime4K — Limpar ruído (fontes SD)']], v.upscaler, (x) => set({ upscaler: x })),
          'RTX VSR só atua quando o vídeo tem resolução menor que a tela (ex.: 720p numa tela 1080p).'),
        field('Fluidez (FPS)', select([['rife', '60 FPS — IA gera os quadros na RTX (recomendado)'], ['off', 'Original (sem interpolação)']], v.motion, (x) => set({ motion: x }))),
        field('Motor da IA', select([['auto', 'Automático (RTX)'], ['rtx', 'RTX — TensorRT nos Tensor Cores'], ['vulkan', 'Vulkan — outras placas (pode travar)']], v.aiEngine, (x) => set({ aiEngine: x }))),
        field('Modelo RIFE', select([['fast', 'Rápido (RIFE 4.6)'], ['balanced', 'Equilibrado (RIFE 4.22 lite)'], ['quality', 'Qualidade (RIFE 4.26)']], v.rifeModel, (x) => set({ rifeModel: x }))),
        field('Resolução da IA', select([['auto', 'Automática (até 1080p)'], ['native', 'Nativa do vídeo'], ['1080', '1080p'], ['720', '720p (mais leve)']], v.aiRes, (x) => set({ aiRes: x })),
          'A IA cria os quadros nessa resolução; a imagem final continua sendo ampliada para a tela.'),
        App.toggleRow('Auto-ajuste contra travadas', 'Se o vídeo começar a perder quadros, reduz a carga da IA automaticamente (só na sessão atual).', v.aiAdaptive !== false, (x) => set({ aiAdaptive: x })),
        App.toggleRow('Remover faixas (debanding)', 'Suaviza degradês com “escadinhas”, comum em streaming e animes.', v.deband, (x) => set({ deband: x })),
        h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await save({ video: App.state.defaultVideo }, 'Imagem restaurada ao padrão.'); App.navigate('settings', { section: 'video' }); } }, icon('restart'), 'Restaurar padrão de fábrica')))];
    },

    torrent() {
      const t = App.state.settings.torrent;
      const statusEl = h('span', { class: 'status-pill' }, 'Verificando…');
      const statusMsg = h('div', { class: 'status-note', hidden: true });
      const urlInput = textInput(t.url, (v) => set({ url: v || 'http://127.0.0.1:8080' }, 'Endereço salvo.'), { placeholder: 'http://127.0.0.1:8080' });
      const check = async () => {
        statusEl.className = 'status-pill';
        statusEl.textContent = 'Verificando…';
        const st = await window.chimp.torrent.status().catch((e) => ({ ok: false, error: e.message }));
        statusEl.className = `status-pill ${st.ok ? 'ok' : 'err'}`;
        statusEl.textContent = st.ok ? `Conectado · qBittorrent ${st.version}` : 'Desconectado';
        statusMsg.hidden = st.ok;
        statusMsg.textContent = st.ok ? '' : st.error;
        if (st.ok && st.url && st.url !== urlInput.value) { urlInput.value = st.url; App.state.settings.torrent.url = st.url; }
      };
      check();
      const set = (patch, msg) => save({ torrent: patch }, msg).then(check);
      const dirEl = h('div', { class: 'folder-item' }, icon('folder'), h('div', { class: 'p' }, t.downloadDir || 'Primeira pasta da biblioteca (padrão)'),
        h('button', { class: 'btn btn-xs btn-ghost', onclick: async () => { const d = await window.chimp.shell.pickDir(); if (d) { await set({ downloadDir: d }, 'Pasta de downloads salva.'); dirEl.querySelector('.p').textContent = d; } } }, 'Alterar'),
        t.downloadDir ? h('button', { class: 'btn btn-xs btn-ghost', onclick: async () => { await set({ downloadDir: '' }, 'Usando a pasta padrão.'); App.navigate('settings', { section: 'torrent' }); } }, 'Padrão') : null);
      return [
        h('div', { class: 'panel' }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' } }, h('h3', { style: { margin: 0, flex: 1 } }, 'Conexão com o qBittorrent'), statusEl),
          h('p', { class: 'sub' }, 'O Chimpanzé Player controla o qBittorrent pela interface Web dele. A configuração automática liga essa interface só para este computador (sem senha para acesso local).'),
          h('div', { class: 'hero-actions', style: { marginBottom: '18px' } },
            h('button', { class: 'btn btn-sm btn-accent', onclick: () => App.qbitAutoConfig().then(check) }, icon('sparkle'), 'Configurar automaticamente'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await window.chimp.torrent.ensure(); check(); } }, icon('play'), 'Iniciar qBittorrent'),
            h('button', { class: 'btn btn-sm btn-outline', onclick: check }, icon('refresh'), 'Testar conexão')),
          statusMsg,
          field('Endereço da interface Web', urlInput),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
            field('Usuário (se houver)', textInput(t.username, (v) => set({ username: v }, 'Usuário salvo.'))),
            field('Senha (se houver)', textInput(t.password, (v) => set({ password: v }, 'Senha salva.'), { type: 'password' }))),
          field('Executável do qBittorrent (opcional)', h('div', { class: 'input-row' }, textInput(t.exePath, (v) => set({ exePath: v }, 'Caminho salvo.'), { placeholder: 'Detectado automaticamente' }),
            h('button', { class: 'btn btn-sm btn-outline', onclick: async () => { const f = await window.chimp.shell.pickFile([{ name: 'qBittorrent', extensions: ['exe'] }]); if (f) { await set({ exePath: f }, 'Caminho salvo.'); App.navigate('settings', { section: 'torrent' }); } } }, 'Procurar'))),
          App.toggleRow('Abrir o qBittorrent junto com o Chimpanzé Player', null, t.autoStart, (v) => set({ autoStart: v })),
          App.toggleRow('Baixar em sequência por padrão', 'Permite assistir enquanto baixa.', t.sequential, (v) => set({ sequential: v })),
          App.toggleRow('Mostrar só os downloads feitos pelo Chimpanzé', null, t.onlyOurs, (v) => set({ onlyOurs: v }))),
        h('div', { class: 'panel' }, h('h3', null, 'Pasta de downloads'),
          h('p', { class: 'sub' }, 'Os downloads vão para subpastas Filmes, Séries e Animes dentro desta pasta, que fica incluída na biblioteca.'),
          dirEl),
      ];
    },

    prowlarr() {
      const p = App.state.settings.prowlarr;
      const set = (patch, msg) => save({ prowlarr: patch }, msg);
      return [h('div', { class: 'panel' }, h('h3', null, 'Prowlarr (opcional)'),
        h('p', { class: 'sub' }, 'O Prowlarr reúne vários sites de torrent numa busca só, sem abrir páginas (zero anúncios). Instale-o, adicione os indexadores e cole aqui a chave de API (Prowlarr › Settings › General › API Key).'),
        field('Endereço', textInput(p.url, (v) => set({ url: v || 'http://127.0.0.1:9696' }, 'Endereço salvo.'), { placeholder: 'http://127.0.0.1:9696' })),
        field('Chave de API', textInput(p.apiKey, (v) => set({ apiKey: v }, 'Chave salva.'))),
        h('div', { class: 'hero-actions' },
          h('button', { class: 'btn btn-sm btn-outline', onclick: async () => { try { const r = await window.chimp.prowlarr.test(); App.toast(`Prowlarr ${r.version} conectado.`, 'ok'); } catch (e) { App.toast(e.message, 'error'); } } }, icon('refresh'), 'Testar conexão'),
          h('button', { class: 'btn btn-sm btn-outline', onclick: () => window.chimp.shell.open('https://prowlarr.com/#downloads') }, icon('download'), 'Baixar Prowlarr')))];
    },

    sources() {
      const s = App.state.settings.sources;
      return [h('div', { class: 'panel' }, h('h3', null, 'Navegador das Fontes'),
        (() => {
          const row = App.toggleRow('Abrir links magnet do Chrome/Edge no Chimpanzé', 'Ao clicar num link magnet em qualquer navegador, o download abre aqui. Útil para sites com verificação que não funciona no navegador interno.', false, async (v) => {
            const ok = await window.chimp.magnet.setDefault(v);
            App.toast(ok ? 'Pronto: links magnet agora abrem no Chimpanzé.' : (v ? 'O Windows não permitiu. Abra Configurações do Windows › Aplicativos padrão › "MAGNET" e escolha o Chimpanzé Player.' : 'Links magnet não abrem mais no Chimpanzé.'), ok || !v ? 'ok' : 'warn', { duration: 9000 });
          });
          window.chimp.magnet.isDefault().then((on) => { const i = row.querySelector('input'); if (i) i.checked = !!on; }).catch(() => {});
          return row;
        })(),
        App.toggleRow('Bloquear anúncios e rastreadores', 'Usa as listas do uBlock Origin/EasyList (atualizadas automaticamente).', s.adblock !== false, async (v) => { await window.chimp.sources.setAdblock(v); App.state.settings.sources.adblock = v; }),
        h('div', { class: 'hero-actions', style: { marginTop: '16px' } },
          h('button', { class: 'btn btn-sm btn-outline', onclick: async () => { await window.chimp.sources.clearData(); App.toast('Cookies e dados dos sites apagados.', 'ok'); } }, icon('trash'), 'Apagar cookies e dados dos sites')))];
    },

    about() {
      return [h('div', { class: 'panel', style: { display: 'flex', gap: '22px', alignItems: 'center' } },
        h('img', { src: 'assets/logo.svg', alt: '', style: { width: '96px', height: '96px', borderRadius: '24px' } }),
        h('div', null, h('h3', { style: { fontSize: '24px' } }, 'Chimpanzé Player'), h('div', { style: { color: 'var(--text-2)', display: 'flex', gap: '10px', alignItems: 'center' } }, `Versão ${App.state.version}`, h('span', { class: 'alpha-tag' }, 'Alpha')),
          h('div', { style: { color: 'var(--text-3)', fontSize: '13px', marginTop: '6px' } }, App.state.gpu.name ? `GPU: ${App.state.gpu.name}` : ''))),
      h('div', { class: 'panel' }, h('h3', null, 'Atalhos do player'),
        h('div', { class: 'kv' }, ...[
          ['Espaço / K', 'Reproduzir / pausar'], ['← / →', 'Voltar / avançar'], ['↑ / ↓', 'Volume'], ['F ou duplo clique', 'Tela cheia'],
          ['M', 'Mudo'], ['E', 'Painel de imagem e IA'], ['S / A', 'Trocar legenda / áudio'], ['N', 'Próximo episódio'], ['I', 'Estatísticas (GPU, FPS)'],
          [', / .', 'Quadro anterior / próximo (pausado)'], ['[ / ]', 'Velocidade'], ['P', 'Captura de tela'], ['Esc', 'Sair da tela cheia / fechar'],
        ].flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v)]))),
      h('div', { class: 'panel' }, h('h3', null, 'Componentes de código aberto'),
        h('div', { class: 'licenses' },
          'mpv (GPL/LGPL) · libplacebo · FFmpeg · VapourSynth (LGPL) · RIFE ncnn Vulkan (MIT) · Anime4K (MIT) · AMD FidelityFX CAS (MIT) · Python (PSF) · Electron (MIT) · Ghostery Adblocker (MPL-2.0). ',
          'Metadados: TMDB, AniList, TVmaze e Apple iTunes Search. Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.')),
      h('div', { class: 'panel' }, h('h3', null, 'Uso responsável'),
        h('p', { class: 'sub', style: { margin: 0 } }, 'O BitTorrent é apenas um protocolo. Baixar conteúdo protegido por direitos autorais sem autorização pode ser ilegal no seu país; o uso é de responsabilidade do usuário.'))];
    },
  };

  App.views.settings = function (root, params = {}) {
    const section = params.section || App.state.settingsSection || 'library';
    App.state.settingsSection = section;
    const nav = h('nav', { class: 'settings-nav' }, SECTIONS.map(([k, l]) => h('button', { class: k === section ? 'on' : '', onclick: () => App.navigate('settings', { section: k }) }, l)));
    const content = h('div', null, h('h1', { class: 'page-title', style: { marginTop: 0 } }, SECTIONS.find(([k]) => k === section)[1]), builders[section]());
    root.append(h('div', { class: 'page' }, h('div', { class: 'settings' }, nav, content)));
  };
})(window.App);
