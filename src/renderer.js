'use strict';

(function () {
  const STORAGE_KEY = 'binaural-player-settings-v1';
  const engine = new window.BinauralEngine();
  window.engine = engine;

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

  function renderEars(swapped) {
    const { base, diff } = engine.params;
    const a = `${fmt(base, 1)} Hz`;
    const b = `${fmt(base + diff, 1)} Hz`;
    $('freqL').textContent = swapped ? b : a;
    $('freqR').textContent = swapped ? a : b;
    $('beat').textContent = `${fmt(diff, 1)} Hz`;
  }

  // スライダーと数値入力を連動させる
  function bind(key, digits) {
    const range = $(key);
    const num = $(`${key}Num`);
    const show = () => {
      range.value = engine.params[key];
      num.value = fmt(engine.params[key], digits);
    };
    const apply = (raw) => {
      engine.setParams({ [key]: raw });
      save();
      renderEars(engine.swapped);
    };
    range.addEventListener('input', () => {
      apply(range.value);
      num.value = fmt(engine.params[key], digits);
    });
    // 入力途中は書き換えず、確定時に範囲内へ丸める
    num.addEventListener('change', () => {
      apply(num.value);
      show();
    });
    show();
  }

  bind('volL', 0);
  bind('volR', 0);
  bind('diff', 1);
  bind('base', 0);
  bind('swapInterval', 1);

  // 音量の効かせ方 (耳に固定 / チャンネルに固定)
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
  renderEars(false);

  const toggle = $('toggle');
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      if (engine.playing) await engine.stop();
      else await engine.start();
    } finally {
      toggle.disabled = false;
    }
    toggle.textContent = engine.playing ? '停止' : '再生';
    toggle.classList.toggle('playing', engine.playing);
  });

  // バージョン表示と更新状況 (Electron 上でのみ有効)
  const app = window.app;
  if (app) {
    app.getVersion().then((v) => { $('version').textContent = `v${v}`; });
    app.onUpdateStatus((text) => { $('update').textContent = text; });
  }
})();
