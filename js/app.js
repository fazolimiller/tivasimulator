/* Interface do TCI Sim */
(function () {
  'use strict';

  const STORAGE_KEY = 'tivasimulator.v1';
  const THEME_KEY = 'tivasimulator.theme';
  const $ = (sel, el) => (el || document).querySelector(sel);

  const nf = (x, d) => (Number.isFinite(x) ? x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), sec = s % 60;
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  let nextId = 1;
  const state = {
    patient: { age: 40, weight: 70, height: 170, sex: 'M', opioid: true },
    // Valores fixos (bolus manual instantâneo, ajuste a cada 2 min no mínimo); duração automática
    settings: { maxBolusRate: 0, rateResolution: 0.1, minStepMinutes: 2, horizonH: 4 },
    infusions: [],
    time: 0,
    playing: false,
    speed: 1, // sempre inicia em tempo real
    zoom: 30, // minutos visíveis no gráfico
    winStart: 0, // início da janela visível (s)
  };

  function newInfusion(drugKey) {
    const drug = PK.DRUGS[drugKey];
    return { id: nextId++, drugKey, modelName: drug.models[0], concentration: drug.defaultConc, events: [], actType: 'cet' };
  }

  function snapshot() {
    return {
      patient: state.patient, time: Math.round(state.time),
      infusions: state.infusions.map(({ id, drugKey, modelName, concentration, events }) => ({ id, drugKey, modelName, concentration, events })),
    };
  }

  function applySnapshot(d) {
    Object.assign(state.patient, d.patient || {});
    state.time = d.time || 0;
    state.infusions = (d.infusions || [])
      .filter((i) => PK.DRUGS[i.drugKey] && PK.MODELS[i.modelName])
      .map((i) => Object.assign({ actType: 'cet' }, i));
    nextId = state.infusions.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch (e) { /* armazenamento indisponível */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      applySnapshot(JSON.parse(raw));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Link de compartilhamento: cenário codificado no fragmento (#s=...), nada é enviado a servidor
  function encodeShare() {
    const json = JSON.stringify(snapshot());
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeShare(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function loadFromHash() {
    const m = location.hash.match(/^#s=(.+)$/);
    if (!m) return false;
    try {
      applySnapshot(decodeShare(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    } catch (e) {
      return false;
    }
  }

  const horizon = () => state.settings.horizonH * 3600;

  // Duração simulada: pelo menos 4 h e 2 h além da última ação (máx. 12 h)
  function syncHorizon() {
    const last = Math.max(0, ...state.infusions.flatMap((i) => i.events.map((e) => e.t)));
    const h = Math.min(12, Math.max(4, Math.ceil((last + 2 * 3600) / 3600)));
    if (h === state.settings.horizonH) return false;
    state.settings.horizonH = h;
    $('#timeSlider').max = horizon();
    return true;
  }
  function refreshAfterEdit(inf) {
    if (syncHorizon()) { refreshAll(true); setTime(state.time); } else refreshCard(inf, true);
  }

  // ---------------------------------------------------------------------------
  // Simulação
  // ---------------------------------------------------------------------------
  function simulateInfusion(inf) {
    const drug = PK.DRUGS[inf.drugKey];
    const sys = PK.createSystem(inf.drugKey, inf.modelName, state.patient);
    inf.result = TCI.simulate(sys, { concentration: inf.concentration, events: inf.events }, {
      horizon: horizon(),
      maxBolusRate: state.settings.maxBolusRate,
      rateResolution: state.settings.rateResolution,
      minStepMinutes: state.settings.minStepMinutes,
      threshold: drug.threshold,
      avgFactor: drug.avgFactor,
    });
    inf.sys = sys;
  }

  // Passo da bomba vigente no instante t
  function currentStep(inf, t) {
    const steps = inf.result.steps;
    let idx = -1;
    for (let i = 0; i < steps.length; i++) if (steps[i].t <= t) idx = i;
    return { idx, cur: idx >= 0 ? steps[idx] : null, next: steps[idx + 1] || null };
  }

  // ---------------------------------------------------------------------------
  // Gráfico
  // ---------------------------------------------------------------------------
  const cursorPlugin = {
    id: 'timeCursor',
    afterDatasetsDraw(chart) {
      const inf = chart.$inf;
      if (!inf || !inf.result) return;
      const { ctx, chartArea, scales } = chart;
      const x = scales.x.getPixelForValue(state.time / 60);
      if (x < chartArea.left || x > chartArea.right) return;
      const color = PK.DRUGS[inf.drugKey].color;
      ctx.save();
      ctx.strokeStyle = cssVar('--text');
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const t = Math.min(Math.round(state.time), inf.result.horizon);
      for (const [v, fill] of [[inf.result.cp[t], true], [inf.result.ce[t], false]]) {
        const y = scales.y.getPixelForValue(v);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = fill ? color : cssVar('--surface');
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.fill();
        ctx.stroke();
      }
      // rótulo com o tempo
      const label = fmtTime(state.time);
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      const lx = Math.min(Math.max(x - w / 2, chartArea.left), chartArea.right - w);
      ctx.fillStyle = cssVar('--header');
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(lx, chartArea.top - 20, w, 18, 5); else ctx.rect(lx, chartArea.top - 20, w, 18);
      ctx.fill();
      ctx.fillStyle = cssVar('--header-text');
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 6, chartArea.top - 11);
      ctx.restore();
    },
  };

  function buildChart(inf) {
    const canvas = $('canvas', inf.el);
    const drug = PK.DRUGS[inf.drugKey];
    const grid = cssVar('--border'), text = cssVar('--muted');
    const rateFill = (ctx) => {
      const { chart } = ctx;
      if (!chart.chartArea) return hexA(drug.color, 0.12);
      const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
      g.addColorStop(0, hexA(drug.color, 0.22));
      g.addColorStop(1, hexA(drug.color, 0.03));
      return g;
    };
    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [
        { label: 'Cp', data: [], borderColor: drug.color, borderWidth: 2.5, pointRadius: 0, yAxisID: 'y', order: 1 },
        { label: 'Ce', data: [], borderColor: drug.color, borderDash: [7, 5], borderWidth: 2.5, pointRadius: 0, yAxisID: 'y', order: 2 },
        { label: 'Alvo', data: [], borderColor: text, borderDash: [2, 4], borderWidth: 1.5, pointRadius: 0, stepped: 'before', yAxisID: 'y', order: 3 },
        { label: 'Taxa', data: [], borderColor: hexA(drug.color, 0.45), backgroundColor: rateFill, fill: 'origin', borderWidth: 1, pointRadius: 0, stepped: 'before', yAxisID: 'y2', order: 4 },
      ] },
      options: {
        animation: false,
        parsing: false,
        normalized: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 24 } },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', min: 0, max: horizon() / 60, title: { display: true, text: 'Tempo (min)', color: text },
            ticks: { color: text, stepSize: 15 }, grid: { color: hexA('#7f8ea3', 0.18) }, border: { color: grid } },
          y: { beginAtZero: true, title: { display: true, text: drug.concUnit, color: text }, ticks: { color: text },
            grid: { color: hexA('#7f8ea3', 0.18) }, border: { color: grid } },
          y2: { beginAtZero: true, position: 'right', title: { display: true, text: 'ml/h', color: text }, ticks: { color: text },
            grid: { drawOnChartArea: false }, border: { color: grid } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(11,45,74,.94)',
            padding: 10,
            callbacks: {
              title: (items) => (items.length ? fmtTime(items[0].parsed.x * 60) : ''),
              label: (it) => (it.datasetIndex === 3
                ? ` Taxa: ${nf(it.parsed.y, 1)} ml/h`
                : ` ${it.dataset.label}: ${nf(it.parsed.y, 2)} ${drug.concUnit}`),
            },
          },
        },
        onClick(evt, _els, ch) {
          setTime(ch.scales.x.getValueForPixel(evt.x) * 60);
        },
      },
      plugins: [cursorPlugin],
    });
    chart.$inf = inf;
    inf.chart = chart;
  }

  function updateChartData(inf) {
    const r = inf.result, H = r.horizon;
    const step = H > 6 * 3600 ? 10 : 5;
    const cp = [], ce = [], tg = [], rate = [];
    for (let t = 0; t <= H; t += step) {
      cp.push({ x: t / 60, y: r.cp[t] });
      ce.push({ x: t / 60, y: r.ce[t] });
    }
    let lastT;
    for (let t = 0; t <= H; t++) {
      const v = r.target[t];
      const same = (Number.isNaN(v) && Number.isNaN(lastT)) || v === lastT;
      if (t === 0 || !same || t === H) tg.push({ x: t / 60, y: Number.isNaN(v) ? null : v });
      lastT = v;
    }
    let lastR = -1;
    for (let t = 0; t < H; t++) {
      const mlh = (r.rate[t] * 3600) / inf.concentration;
      if (Math.abs(mlh - lastR) > 1e-9 || t === 0) { rate.push({ x: t / 60, y: mlh }); lastR = mlh; }
    }
    rate.push({ x: H / 60, y: lastR });
    const ch = inf.chart;
    ch.data.datasets[0].data = cp;
    ch.data.datasets[1].data = ce;
    ch.data.datasets[2].data = tg;
    ch.data.datasets[3].data = rate;
    applyWindow(inf);
  }

  // ---------------------------------------------------------------------------
  // Janela de tempo do gráfico (zoom + e −)
  // ---------------------------------------------------------------------------
  const ZOOMS = [10, 15, 30, 60, 120, 240, 480, 720]; // minutos
  const tickStep = (wm) => (wm <= 10 ? 1 : wm <= 15 ? 2 : wm <= 30 ? 5 : wm <= 60 ? 10 : wm <= 120 ? 15 : wm <= 240 ? 30 : 60);

  // A janela acompanha o cursor: quando ele passa de 80% da janela, ela avança
  function syncWindow(force) {
    const H = horizon(), W = Math.min(state.zoom * 60, H);
    let start = state.winStart;
    if (force || state.time < start || state.time > start + W * 0.8) {
      // início alinhado às marcações do eixo (ex.: 25, 30, 35 min)
      const snap = tickStep(W / 60) * 60;
      start = Math.floor((state.time - W * 0.2) / snap) * snap;
    }
    start = Math.max(0, Math.min(start, H - W));
    const changed = start !== state.winStart;
    state.winStart = start;
    return changed;
  }

  function applyWindow(inf) {
    const r = inf.result, ch = inf.chart;
    const H = r.horizon, W = Math.min(state.zoom * 60, H);
    const a = Math.round(state.winStart), b = Math.min(H, Math.round(state.winStart + W));
    ch.options.scales.x.min = a / 60;
    ch.options.scales.x.max = b / 60;
    const wm = W / 60;
    ch.options.scales.x.ticks.stepSize = tickStep(wm);
    // escalas pelos valores visíveis
    let maxConc = 0;
    for (let t = a; t <= b; t++) {
      maxConc = Math.max(maxConc, r.cp[t], r.ce[t], Number.isNaN(r.target[t]) ? 0 : r.target[t]);
    }
    ch.options.scales.y.suggestedMax = maxConc * 1.1 || 1;
    ch.options.scales.y.max = undefined;
    // eixo da taxa: maior taxa de manutenção visível (bolus ficaria fora de escala)
    let maxMaint = 0;
    const steps = r.steps;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i], end = i + 1 < steps.length ? steps[i + 1].t : H;
      if (st.type === 'rate' && st.t <= b && end >= a) maxMaint = Math.max(maxMaint, st.mlh);
    }
    ch.options.scales.y2.max = maxMaint > 0 ? Math.ceil(maxMaint * 1.4) : undefined;
    ch.update('none');
    const lbl = $('.zoom-label', inf.el);
    if (lbl) lbl.textContent = wm >= 60 ? `${nf(wm / 60, wm % 60 ? 1 : 0)} h` : `${Math.round(wm)} min`;
  }

  function setZoom(dir) {
    const H = horizon() / 60;
    let i = ZOOMS.indexOf(state.zoom);
    if (i < 0) i = 2;
    i = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
    if (dir > 0 && ZOOMS[i - 1] >= H) return; // já mostra tudo
    state.zoom = ZOOMS[i];
    syncWindow(true);
    for (const inf of state.infusions) applyWindow(inf);
  }

  // ---------------------------------------------------------------------------
  // Cartões de infusão
  // ---------------------------------------------------------------------------
  const container = $('#infusions');
  const tpl = $('#infusionTpl');
  const UNIT_OF = (drug, type) => ({ cet: drug.concUnit, cpt: drug.concUnit, rate: 'ml/h', bolus: drug.doseUnit, stop: '' }[type]);

  function createCard(inf) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    inf.el = el;
    container.appendChild(el);

    const selDrug = $('.sel-drug', el), selModel = $('.sel-model', el), inpConc = $('.inp-conc', el);
    for (const [k, d] of Object.entries(PK.DRUGS)) selDrug.add(new Option(d.name, k));

    selDrug.addEventListener('change', () => {
      const d = PK.DRUGS[selDrug.value];
      inf.drugKey = selDrug.value;
      inf.modelName = d.models[0];
      inf.concentration = d.defaultConc;
      inf.events = inf.events.map((e) => ((e.type === 'cpt' || e.type === 'cet') ? Object.assign({}, e, { value: d.defaultTarget }) : e));
      inf.chart.destroy();
      buildChart(inf);
      refreshCard(inf, true);
    });
    selModel.addEventListener('change', () => { inf.modelName = selModel.value; refreshCard(inf, true); });
    inpConc.addEventListener('change', () => {
      const v = parseFloat(inpConc.value);
      if (v > 0) { inf.concentration = v; refreshCard(inf, true); } else inpConc.value = inf.concentration;
    });
    $('.btn-remove', el).addEventListener('click', () => {
      if (!confirm('Remover esta infusão?')) return;
      inf.chart.destroy();
      el.remove();
      state.infusions = state.infusions.filter((i) => i !== inf);
      renderPumpStrip();
      save();
    });

    $('.act-types', el).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-type]');
      if (!b) return;
      inf.actType = b.dataset.type;
      updateActionUnit(inf);
      if (inf.actType !== 'stop') $('.act-value', el).focus();
    });
    $('.action', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const type = inf.actType;
      const input = $('.act-value', el);
      let value = parseFloat(String(input.value).replace(',', '.'));
      if (type !== 'stop' && !(value >= 0)) { input.focus(); return; }
      if (type === 'stop') value = 0;
      const t = Math.round(state.time);
      inf.events = inf.events.filter((ev) => !(ev.t === t && (ev.type === 'bolus') === (type === 'bolus')));
      inf.events.push({ t, type, value });
      inf.events.sort((a, b) => a.t - b.t);
      refreshAfterEdit(inf);
      toast(`${PK.DRUGS[inf.drugKey].name}: ação aplicada em ${fmtTime(t)}`);
    });

    $('.zoom', el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-zoom]');
      if (b) setZoom(+b.dataset.zoom);
    });

    $('tbody', el).addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.t) setTime(+tr.dataset.t);
    });
    $('.events', el).addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        inf.events.splice(+del.dataset.del, 1);
        refreshAfterEdit(inf);
        return;
      }
      const go = e.target.closest('[data-go]');
      if (go) setTime(+go.dataset.go);
    });

    buildChart(inf);
    refreshCard(inf, true);
  }

  function updateActionUnit(inf) {
    const el = inf.el, drug = PK.DRUGS[inf.drugKey], type = inf.actType;
    for (const b of el.querySelectorAll('.act-types button')) {
      b.classList.toggle('on', b.dataset.type === type);
      b.setAttribute('aria-pressed', b.dataset.type === type);
    }
    const val = $('.act-value', el);
    val.disabled = type === 'stop';
    $('.act-unit', el).textContent = UNIT_OF(drug, type);
    val.placeholder = type === 'stop' ? 'Pausa a bomba' : (type === 'cet' || type === 'cpt') ? `ex.: ${nf(drug.defaultTarget, drug.defaultTarget % 1 ? 1 : 0)}` : '';
  }

  const EVENT_LABEL = { cet: 'Alvo Ce', cpt: 'Alvo Cp', rate: 'Taxa', bolus: 'Bolus', stop: 'Parar' };

  function refreshCard(inf, resimulate) {
    const el = inf.el, drug = PK.DRUGS[inf.drugKey], p = state.patient;
    if (resimulate) simulateInfusion(inf);

    el.style.setProperty('--drug', drug.color);
    el.style.setProperty('--drug-soft', hexA(drug.color, 0.15));
    $('.inf-title', el).textContent = drug.name;
    $('.inf-model', el).textContent = inf.modelName;
    $('.inf-conc', el).textContent = `${nf(inf.concentration, inf.concentration % 1 ? (inf.concentration < 1 ? 2 : 1) : 0)} ${drug.doseUnit}/ml`;
    const selDrug = $('.sel-drug', el), selModel = $('.sel-model', el);
    selDrug.value = inf.drugKey;
    selModel.innerHTML = '';
    for (const m of drug.models) selModel.add(new Option(m, m));
    selModel.value = inf.modelName;
    $('.inp-conc', el).value = inf.concentration;
    $('.conc-label', el).firstChild.textContent = `Concentração (${drug.doseUnit}/ml)`;
    $('.kg-head', el).textContent = drug.rateUnit;
    updateActionUnit(inf);

    const ages = PK.MODELS[inf.modelName].ages;
    const warn = $('.model-warn', el);
    if (p.age < ages[0] || p.age > ages[1]) {
      warn.hidden = false;
      warn.textContent = `O modelo ${inf.modelName} foi desenvolvido para idades entre ${ages[0]} e ${ages[1]} anos.`;
    } else warn.hidden = true;

    const evBox = $('.events', el);
    evBox.innerHTML = '';
    if (!inf.events.length) {
      evBox.innerHTML = '<span class="empty">Nenhuma ação ainda. Escolha o tipo, digite o valor e clique em Aplicar para iniciar no tempo atual.</span>';
    }
    inf.events.forEach((ev, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const val = ev.type === 'stop' ? '' : ` ${nf(ev.value, ev.value % 1 ? 2 : 0)} ${UNIT_OF(drug, ev.type)}`;
      chip.innerHTML = `<span class="chip-time" data-go="${ev.t}" title="Ir para este tempo">${fmtTime(ev.t)}</span> ${EVENT_LABEL[ev.type]}${val}<button type="button" data-del="${i}" title="Remover ação" aria-label="Remover ação">✕</button>`;
      evBox.appendChild(chip);
    });

    const tbody = $('tbody', el);
    tbody.innerHTML = '';
    const r = inf.result;
    const kg = (mlh) => (mlh * inf.concentration * drug.rateFactor) / p.weight;
    const resDigits = state.settings.rateResolution < 1 ? 1 : 0;
    for (const st of r.steps) {
      const tr = document.createElement('tr');
      tr.dataset.t = st.t;
      let action, mlh, perkg = '';
      if (st.type === 'bolus') {
        tr.className = 'bolus';
        action = `Bolus ${nf(st.ml, 1)} ml (${nf(st.dose, st.dose < 10 ? 1 : 0)} ${drug.doseUnit})` +
          (st.mlh ? ` em ${st.duration} s` : '');
        mlh = st.mlh ? nf(st.mlh, 0) : '—';
      } else {
        action = st.mlh === 0 ? 'Pausar' : 'Ajustar taxa';
        mlh = nf(st.mlh, resDigits);
        perkg = nf(kg(st.mlh), 2);
      }
      tr.innerHTML = `<td class="st"></td><td>${fmtTime(st.t)}</td><td>${action}</td><td class="num">${mlh}</td><td class="num">${perkg}</td><td class="num">${nf(r.vol[Math.min(st.t, r.horizon)], 1)} ml</td>`;
      tbody.appendChild(tr);
    }
    if (!r.steps.length) tbody.innerHTML = '<tr><td colspan="6" class="muted">Sem passos programados.</td></tr>';
    $('.scheme-count', el).textContent = r.steps.length ? `(${r.steps.length} passos)` : '';

    if (resimulate) {
      updateChartData(inf);
      renderPumpStrip();
      save();
    }
    updateLive(inf);
  }

  // Leituras no tempo atual
  function updateLive(inf) {
    const el = inf.el, r = inf.result, drug = PK.DRUGS[inf.drugKey];
    const t = Math.min(Math.round(state.time), r.horizon);
    const u = `<small>${drug.concUnit}</small>`;
    $('.cp-now', el).innerHTML = `${nf(r.cp[t], 2)} ${u}`;
    $('.ce-now', el).innerHTML = `${nf(r.ce[t], 2)} ${u}`;
    const tg = r.target[t];
    $('.target-now', el).innerHTML = Number.isNaN(tg) ? '—' : `${nf(tg, 2)} <small>${r.targetType[t] === 'cet' ? 'Ce' : 'Cp'}</small>`;
    $('.vol-now', el).innerHTML = `${nf(r.vol[t], 1)} <small>ml</small>`;
    $('.action-time', el).textContent = `em ${fmtTime(state.time)}`;

    const { idx, cur, next } = currentStep(inf, t);
    const rateEl = $('.rate-now', el), kgEl = $('.rate-kg', el), stEl = $('.pd-state', el);
    const res = state.settings.rateResolution < 1 ? 1 : 0;
    let mode = 'run';
    if (!cur) {
      rateEl.textContent = '0 ml/h';
      kgEl.textContent = inf.events.length ? 'aguardando início' : 'sem programação';
      mode = 'pause';
    } else if (cur.type === 'bolus' && t < cur.t + Math.max(1, cur.duration)) {
      rateEl.textContent = `${nf(cur.ml, 1)} ml`;
      kgEl.textContent = cur.mlh ? `bolus a ${nf(cur.mlh, 0)} ml/h por ${cur.duration} s` : 'bolus imediato';
      mode = 'bolus';
    } else {
      const mlh = (r.rate[Math.min(t, r.horizon - 1)] * 3600) / inf.concentration;
      rateEl.textContent = `${nf(mlh, res)} ml/h`;
      kgEl.textContent = `${nf((mlh * inf.concentration * drug.rateFactor) / state.patient.weight, 2)} ${drug.rateUnit}`;
      if (mlh === 0) mode = 'pause';
    }
    stEl.className = 'pd-state ' + mode;
    stEl.textContent = { run: 'INFUNDINDO', pause: 'PAUSADA', bolus: 'BOLUS' }[mode];

    const nc = $('.next-change', el);
    if (next) {
      const what = next.type === 'bolus' ? `bolus ${nf(next.ml, 1)} ml` : next.mlh === 0 ? 'pausar' : `${nf(next.mlh, res)} ml/h`;
      nc.innerHTML = `Próximo: <strong>${what}</strong> em <strong>${fmtDur(next.t - state.time)}</strong> <span style="opacity:.7">(${fmtTime(next.t)})</span>`;
    } else nc.textContent = r.steps.length ? 'Sem outros ajustes no período simulado.' : 'Aplique uma ação para gerar o esquema.';

    const rows = $('tbody', el).rows;
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('now', i === idx);
      rows[i].classList.toggle('past', i < idx);
      if (rows[i].cells.length > 1) rows[i].cells[0].textContent = i === idx ? '▶' : i < idx ? '✓' : '';
    }
    inf.chart.draw();
  }

  // Resumo de todas as bombas na barra de tempo
  function renderPumpStrip() {
    const box = $('#pumpStrip');
    box.innerHTML = '';
    for (const inf of state.infusions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pump-chip';
      b.addEventListener('click', () => inf.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      inf.chip = b;
      box.appendChild(b);
    }
    updatePumpStrip();
  }
  function updatePumpStrip() {
    const res = state.settings.rateResolution < 1 ? 1 : 0;
    for (const inf of state.infusions) {
      if (!inf.chip || !inf.result) continue;
      const drug = PK.DRUGS[inf.drugKey], r = inf.result;
      const t = Math.min(Math.round(state.time), r.horizon);
      const { cur, next } = currentStep(inf, t);
      let now;
      if (cur && cur.type === 'bolus' && t < cur.t + Math.max(1, cur.duration)) now = `bolus ${nf(cur.ml, 1)} ml`;
      else now = `${nf((r.rate[Math.min(t, r.horizon - 1)] * 3600) / inf.concentration, res)} ml/h`;
      const soonS = next ? next.t - state.time : Infinity;
      inf.chip.classList.toggle('alert', soonS <= 60);
      inf.chip.innerHTML = `<span class="dot" style="background:${drug.color}"></span>${drug.name} <strong>${now}</strong>` +
        (next ? ` <span class="soon">↻ ${fmtDur(soonS)}</span>` : '');
    }
  }

  function refreshAll(resimulate) {
    for (const inf of state.infusions) refreshCard(inf, resimulate);
  }

  // ---------------------------------------------------------------------------
  // Tempo
  // ---------------------------------------------------------------------------
  const clockEl = $('#clock'), slider = $('#timeSlider'), btnPlay = $('#btnPlay');

  function setTime(t, fromSlider) {
    state.time = Math.max(0, Math.min(horizon(), t));
    clockEl.textContent = fmtTime(state.time);
    if (!fromSlider) slider.value = Math.round(state.time);
    const moved = syncWindow();
    for (const inf of state.infusions) {
      if (moved) applyWindow(inf);
      updateLive(inf);
    }
    updatePumpStrip();
    clearTimeout(setTime.saveTimer);
    setTime.saveTimer = setTimeout(save, 400);
  }

  let lastFrame = null;
  function tick(ts) {
    if (!state.playing) return;
    if (lastFrame !== null) {
      setTime(state.time + ((ts - lastFrame) / 1000) * state.speed);
      if (state.time >= horizon()) setPlaying(false);
    }
    lastFrame = ts;
    requestAnimationFrame(tick);
  }
  function setPlaying(p) {
    state.playing = p;
    btnPlay.textContent = p ? '❚❚' : '▶';
    btnPlay.setAttribute('aria-label', p ? 'Pausar' : 'Reproduzir');
    lastFrame = null;
    if (p) requestAnimationFrame(tick);
  }

  btnPlay.addEventListener('click', () => setPlaying(!state.playing));
  document.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    const j = b.dataset.jump;
    setTime(j === 'reset' ? 0 : state.time + Number(j));
  }));
  slider.addEventListener('input', () => setTime(+slider.value, true));
  $('#speed').addEventListener('change', (e) => { state.speed = +e.target.value; });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!state.playing); }
    else if (e.key === 'ArrowRight') setTime(state.time + (e.shiftKey ? 600 : 60));
    else if (e.key === 'ArrowLeft') setTime(state.time - (e.shiftKey ? 600 : 60));
  });

  // ---------------------------------------------------------------------------
  // Paciente e configurações
  // ---------------------------------------------------------------------------
  const pFields = ['age', 'weight', 'height'];
  function readPatient() {
    for (const f of pFields) {
      const v = parseFloat($('#' + f).value);
      if (v > 0 || (f === 'age' && v >= 0)) state.patient[f] = v;
    }
    state.patient.sex = $('#sex').value;
    state.patient.opioid = $('#opioid').checked;
    setupSummary();
    refreshAll(true);
  }
  function setupSummary() {
    const p = state.patient;
    const bmi = p.weight / Math.pow(p.height / 100, 2);
    $('#patientInfo').textContent = `IMC ${nf(bmi, 1)} kg/m² · massa magra (James) ${nf(PK.leanBodyMass(p), 1)} kg · massa livre de gordura ${nf(PK.fatFreeMass(p), 1)} kg`;
    $('#setupSummary').textContent = `${nf(p.age, 0)} anos · ${nf(p.weight, p.weight % 1 ? 1 : 0)} kg · ${nf(p.height, 0)} cm · ${p.sex === 'M' ? 'masc.' : 'fem.'}`;
  }
  for (const f of [...pFields, 'sex', 'opioid']) $('#' + f).addEventListener('change', readPatient);

  function writeForm() {
    for (const f of pFields) $('#' + f).value = state.patient[f];
    $('#sex').value = state.patient.sex;
    $('#opioid').checked = state.patient.opioid !== false;
    $('#speed').value = String(state.speed);
    slider.max = horizon();
    setupSummary();
  }

  function clearCards() {
    for (const inf of state.infusions) { if (inf.chart) inf.chart.destroy(); if (inf.el) inf.el.remove(); }
  }

  $('#btnAdd').addEventListener('click', () => {
    const used = new Set(state.infusions.map((i) => i.drugKey));
    const key = ['propofol', 'remifentanil', 'dexmedetomidine', 'ketamine', 'fentanyl', 'alfentanil'].find((k) => !used.has(k)) || 'propofol';
    const inf = newInfusion(key);
    state.infusions.push(inf);
    createCard(inf);
    inf.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('Apagar todas as infusões e ações?')) return;
    clearCards();
    state.infusions = [newInfusion('propofol')];
    syncHorizon();
    createCard(state.infusions[0]);
    renderPumpStrip();
    setTime(0);
    save();
  });

  $('#btnShare').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#s=${encodeShare()}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copiado. Quem abrir verá este mesmo cenário (paciente, infusões e ações).');
    } catch (e) {
      prompt('Copie o link deste cenário:', url);
    }
  });

  // Tema
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  $('#btnTheme').addEventListener('click', () => {
    // padrão: tema claro; escuro só quando escolhido no botão
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    // recriar gráficos com as cores do novo tema
    for (const inf of state.infusions) { inf.chart.destroy(); buildChart(inf); updateChartData(inf); updateLive(inf); }
  });
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) { /* ignore */ }

  // Sobre
  $('#btnAbout').addEventListener('click', () => {
    const ul = $('#modelRefs');
    ul.innerHTML = '';
    for (const d of Object.values(PK.DRUGS)) {
      for (const m of d.models) {
        const li = document.createElement('li');
        li.textContent = `${d.name} – ${m}: ${PK.MODELS[m].ref}`;
        ul.appendChild(li);
      }
    }
    $('#about').showModal();
  });

  // ---------------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------------
  const fromLink = loadFromHash();
  if (!fromLink && (!load() || !state.infusions.length)) {
    state.infusions = [newInfusion('propofol'), newInfusion('remifentanil')];
  }
  syncHorizon();
  writeForm();
  for (const inf of state.infusions) createCard(inf);
  renderPumpStrip();
  setTime(state.time);
  if (fromLink) { save(); toast('Cenário carregado do link compartilhado.'); }

  // Aplicativo instalável (PWA): funciona offline depois do primeiro acesso
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sem suporte */ });
  }
})();
