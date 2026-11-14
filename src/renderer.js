'use strict';

(function () {
  const STORAGE_KEY = 'binaural-player-settings-v1';
  const FILES_KEY = 'binaural-player-files-v1';
  const SIDES = ['L', 'R'];
  const engine = new window.BinauralEngine();
  window.engine = engine;
  const app = window.app; // Electron 上でのみ存在

  const $ = (id) => document.getElementById(id);

  // 設定の読み込み (壊れていたら既定値)
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    engine.setParams(saved);
  } catch (_) { /* 既定値のまま */ }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(engine.params));
    } catch (_) { /* 保存できなくても動作は続ける */ }
  }

  function fmt(n, digits) {
    return Number(n).toFixed(digits);
  }

  // 上段の表示: いま各耳で鳴っている音
  function renderEars(swapped) {
    const fileMode = engine.params.source === 'file';
    $('freqL').closest('.ears').classList.toggle('files', fileMode);
    let a;
    let b;
    if (fileMode) {
      a = engine.files.L ? engine.files.L.name : '—';
      b = engine.files.R ? engine.files.R.name : '—';
      $('beatLabel').textContent = '音源';
      $('beat').textContent = 'ファイル';
    } else {
      const { base, diff } = engine.params;
      a = `${fmt(base, 1)} Hz`;
      b = `${fmt(base + diff, 1)} Hz`;
      $('beatLabel').textContent = 'うなり';
      $('beat').textContent = `${fmt(diff, 1)} Hz`;
    }
    $('freqL').textContent = swapped ? b : a;
    $('freqR').textContent = swapped ? a : b;
    $('freqL').title = fileMode ? $('freqL').textContent : '';
    $('freqR').title = fileMode ? $('freqR').textContent : '';
  }

  // スライダーと数値入力を連動させる
  function bind(key, digits) {
    const range = $(key);
    const num = $(`${key}Num`);
    // よく使う値へ一度に移るボタン (ある項目だけ)
    const presets = document.querySelectorAll(`.presets[data-key="${key}"] button`);
    const showPresets = () => {
      for (const b of presets) {
        b.classList.toggle('active', Number(b.dataset.value) === engine.params[key]);
      }
    };
    const show = () => {
      range.value = engine.params[key];
      num.value = fmt(engine.params[key], digits);
      showPresets();
    };
    const apply = (raw) => {
      engine.setParams({ [key]: raw });
      save();
      renderEars(engine.swapped);
    };
    range.addEventListener('input', () => {
      apply(range.value);
      num.value = fmt(engine.params[key], digits);
      showPresets();
    });
    for (const b of presets) {
      b.addEventListener('click', () => {
        apply(b.dataset.value);
        show();
      });
    }
    // 入力途中は書き換えず、確定時に範囲内へ丸める
    num.addEventListener('change', () => {
      apply(num.value);
      show();
    });
    show();
  }

  bind('volL', 0);
  bind('volR', 0);
  bind('volBoth', 0);
  bind('diff', 1);
  bind('base', 0);
  bind('swapInterval', 1);

  // ---- 音源 (純音 / 音声ファイル) ----
  const toggle = $('toggle');
  const sourceRadios = document.querySelectorAll('input[name="source"]');
  let fileMeta = { L: null, R: null }; // { name, path } 次回起動時の復元用
  let fileMessage = '';

  function saveFiles() {
    try {
      localStorage.setItem(FILES_KEY, JSON.stringify(fileMeta));
    } catch (_) { /* 保存できなくても動作は続ける */ }
  }

  function renderSource() {
    const fileMode = engine.params.source === 'file';
    for (const r of sourceRadios) r.checked = r.value === engine.params.source;
    $('filePanel').hidden = !fileMode;
    $('freqPanel').hidden = fileMode;
    for (const side of SIDES) {
      const file = engine.files[side];
      const nameEl = $(`fileName${side}`);
      nameEl.textContent = file ? file.name : '未登録';
      nameEl.title = file ? file.name : '';
      nameEl.classList.toggle('empty', !file);
      $(`fileClear${side}`).disabled = !file;
    }
    $('rewind').disabled = !engine.hasFiles();
    $('fileHint').textContent =
      fileMessage || (engine.hasFiles() ? '繰り返し再生します' : '音声ファイルを登録してください');
    renderEars(engine.swapped);
  }

  function registerFile(side, blob, name, path) {
    fileMessage = '';
    engine.setFile(side, blob, name);
    fileMeta[side] = { name, path: path || '' };
    saveFiles();
    renderSource();
  }

  function clearFile(side) {
    engine.clearFile(side);
    fileMeta[side] = null;
    saveFiles();
    renderSource();
  }

  engine.onFileError = (side, name) => {
    fileMeta[side] = null;
    saveFiles();
    fileMessage = `「${name}」は再生できない形式です`;
    renderSource();
  };

  for (const side of SIDES) {
    const input = $(`fileInput${side}`);
    $(`filePick${side}`).addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = ''; // 同じファイルを選び直せるようにする
      if (!file) return;
      const path = app && app.getPathForFile ? app.getPathForFile(file) : '';
      registerFile(side, file, file.name, path);
    });
    $(`fileClear${side}`).addEventListener('click', () => {
      fileMessage = '';
      clearFile(side);
    });
  }

  $('rewind').addEventListener('click', () => engine.rewind());

  for (const r of sourceRadios) {
    r.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        await engine.setSource(r.value);
      } finally {
        toggle.disabled = false;
      }
      save();
      renderSource();
    });
  }

  // 前回登録したファイルを読み直す (Electron のみ。ファイルが無くなっていたら登録を外す)
  async function restoreFiles() {
    if (!app || !app.readAudioFile) return;
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(FILES_KEY) || '{}');
    } catch (_) {
      return;
    }
    for (const side of SIDES) {
      const meta = saved && saved[side];
      if (!meta || !meta.path || engine.files[side]) continue;
      const data = await app.readAudioFile(meta.path);
      if (engine.files[side]) continue; // 読み込み中に別のファイルが登録された
      if (data) {
        registerFile(side, new Blob([data.bytes], { type: data.type }), data.name, meta.path);
      } else {
        fileMessage = `「${meta.name}」が見つかりません`;
        renderSource();
      }
    }
  }

  // ---- 音量の効かせ方 (耳に固定 / チャンネルに固定) ----
  const modeRadios = document.querySelectorAll('input[name="volumeMode"]');
  const HINTS = {
    ear: '左右を入れ替えても、左耳・右耳それぞれの音量は変わりません。',
    channel: '音量は音源（左ch・右ch）に付き、左右を入れ替えると音量も一緒に入れ替わります。',
  };
  const renderMode = () => {
    for (const r of modeRadios) r.checked = r.value === engine.params.volumeMode;
    $('volumeHint').textContent = HINTS[engine.params.volumeMode];
    const ch = engine.params.volumeMode === 'channel';
    document.querySelector('label[for="volL"]').textContent = ch ? '左ch' : '左耳';
    document.querySelector('label[for="volR"]').textContent = ch ? '右ch' : '右耳';
  };
  for (const r of modeRadios) {
    r.addEventListener('change', () => {
      engine.setParams({ volumeMode: r.value });
      save();
      renderMode();
    });
  }
  renderMode();

  // ---- 左右の入れ替え ----
  const swapBox = $('swapEnabled');
  const swapPanel = swapBox.closest('.panel');
  const renderSwap = () => {
    swapBox.checked = engine.params.swapEnabled;
    swapPanel.classList.toggle('disabled', !engine.params.swapEnabled);
  };
  swapBox.addEventListener('change', () => {
    engine.setParams({ swapEnabled: swapBox.checked });
    save();
    renderSwap();
    renderEars(engine.swapped);
  });
  renderSwap();

  engine.onSwap = renderEars;
  renderSource();
  restoreFiles();

  // ---- 再生 / 停止 ----
  const renderToggle = () => {
    toggle.textContent = engine.playing ? '停止' : '再生';
    toggle.classList.toggle('playing', engine.playing);
  };
  toggle.addEventListener('click', async () => {
    if (!engine.playing && engine.params.source === 'file' && !engine.hasFiles()) {
      fileMessage = '';
      renderSource();
      $('filePickL').focus();
      return;
    }
    toggle.disabled = true;
    try {
      if (engine.playing) await engine.stop();
      else await engine.start();
    } finally {
      toggle.disabled = false;
    }
    renderToggle();
  });

  // バージョン表示と更新状況 (Electron 上でのみ有効)
  if (app) {
    app.getVersion().then((v) => { $('version').textContent = `v${v}`; });
    app.onUpdateStatus((text) => { $('update').textContent = text; });
  }
})();
