/* Interface do TIVA Simulator */
(function () {
  'use strict';

  const STORAGE_KEY = 'tivasimulator.v1';
  const $ = (sel, el) => (el || document).querySelector(sel);

  const nf = (x, d) => (Number.isFinite(x) ? x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const concDigits = (u) => (u === 'mcg/ml' ? 2 : 2);

  function fmtTime(s, withSeconds) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return withSeconds === false ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), sec = s % 60;
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m}:${String(sec).padStart(2, '0')} min`;
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  let nextId = 1;
  const state = {
    patient: { age: 40, weight: 70, height: 170, sex: 'M', opioid: true },
    settings: { maxBolusRate: 1200, rateResolution: 0.1, minStepMinutes: 2, horizonH: 4 },
    infusions: [],
    time: 0,
    playing: false,
    speed: 60,
  };

  function newInfusion(drugKey) {
    const drug = PK.DRUGS[drugKey];
    return {
      id: nextId++, drugKey, modelName: drug.models[0], concentration: drug.defaultConc, events: [],
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        patient: state.patient, settings: state.settings, time: state.time, speed: state.speed,
        infusions: state.infusions.map(({ id, drugKey, modelName, concentration, events }) => ({ id, drugKey, modelName, concentration, events })),
      }));
    } catch (e) { /* armazenamento indisponível */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      Object.assign(state.patient, d.patient || {});
      Object.assign(state.settings, d.settings || {});
      state.time = d.time || 0;
      state.speed = d.speed || 60;
      state.infusions = (d.infusions || []).filter((i) => PK.DRUGS[i.drugKey] && PK.MODELS[i.modelName]);
      nextId = state.infusions.reduce((m, i) => Math.max(m, i.id), 0) + 1;
      return true;
    } catch (e) {
      return false;
    }
  }

  const horizon = () => state.settings.horizonH * 3600;

  // ---------------------------------------------------------------------------
  // Simulação
  // ---------------------------------------------------------------------------
  function simulateInfusion(inf) {
    const drug = PK.DRUGS[inf.drugKey];
    const sys = PK.createSystem(inf.drugKey, inf.modelName, state.patient);
    const res = TCI.simulate(sys, { concentration: inf.concentration, events: inf.events }, {
      horizon: horizon(),
      maxBolusRate: state.settings.maxBolusRate,
      rateResolution: state.settings.rateResolution,
      minStepMinutes: state.settings.minStepMinutes,
      threshold: drug.threshold,
      avgFactor: drug.avgFactor,
    });
    inf.sys = sys;
    inf.result = res;
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
      ctx.save();
      ctx.strokeStyle = cssVar('--text');
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const t = Math.min(Math.round(state.time), inf.result.horizon);
      const color = PK.DRUGS[inf.drugKey].color;
      for (const [v, fill] of [[inf.result.cp[t], true], [inf.result.ce[t], false]]) {
        const y = scales.y.getPixelForValue(v);
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = fill ? color : cssVar('--surface');
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function buildChart(inf) {
    const canvas = $('canvas', inf.el);
    const drug = PK.DRUGS[inf.drugKey];
    const grid = cssVar('--border'), text = cssVar('--muted');
    const chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [
        { label: 'Cp', data: [], borderColor: drug.color, borderWidth: 2, pointRadius: 0, yAxisID: 'y', order: 1 },
        { label: 'Ce', data: [], borderColor: drug.color, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, yAxisID: 'y', order: 2 },
        { label: 'Alvo', data: [], borderColor: text, borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0, stepped: 'before', yAxisID: 'y', spanGaps: false, order: 3 },
        { label: 'Taxa (ml/h)', data: [], borderColor: hexA(drug.color, 0.35), backgroundColor: hexA(drug.color, 0.10), fill: 'origin', borderWidth: 1, pointRadius: 0, stepped: 'before', yAxisID: 'y2', order: 4 },
      ] },
      options: {
        animation: false,
        parsing: false,
        normalized: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', min: 0, max: horizon() / 60, title: { display: true, text: 'Tempo (min)', color: text },
            ticks: { color: text, stepSize: 15, callback: (v) => v }, grid: { color: grid } },
          y: { beginAtZero: true, title: { display: true, text: drug.concUnit, color: text }, ticks: { color: text }, grid: { color: grid } },
          y2: { beginAtZero: true, position: 'right', title: { display: true, text: 'ml/h', color: text }, ticks: { color: text }, grid: { drawOnChartArea: false } },
        },
        plugins: {
          legend: { labels: { color: text, boxWidth: 18, boxHeight: 2 } },
          tooltip: {
            callbacks: {
              title: (items) => items.length ? fmtTime(items[0].parsed.x * 60) : '',
              label: (it) => `${it.dataset.label}: ${nf(it.parsed.y, it.datasetIndex === 3 ? 1 : 2)}`,
            },
          },
        },
        onClick(evt, _els, ch) {
          const x = ch.scales.x.getValueForPixel(evt.x);
          setTime(x * 60);
        },
      },
      plugins: [cursorPlugin],
    });
    chart.$inf = inf;
    inf.chart = chart;
  }

  function updateChartData(inf) {
    const r = inf.result, H = r.horizon;
    const step = H > 6 * 3600 ? 30 : 10;
    const cp = [], ce = [], tg = [], rate = [];
    for (let t = 0; t <= H; t += step) {
      cp.push({ x: t / 60, y: r.cp[t] });
      ce.push({ x: t / 60, y: r.ce[t] });
    }
    // alvo e taxa: só nos pontos de mudança (gráfico em degraus)
    let lastT;
    for (let t = 0; t <= H; t++) {
      const v = r.target[t];
      const same = (Number.isNaN(v) && Number.isNaN(lastT)) || v === lastT;
      if (t === 0 || !same || t === H) tg.push({ x: t / 60, y: Number.isNaN(v) ? null : v });
      lastT = v;
    }
    const conc = inf.concentration;
    let lastR = -1;
    for (let t = 0; t < H; t++) {
      // bolus de 1 s distorceria a escala: exibir a taxa da bomba (ml/h) limitada
      const mlh = (r.rate[t] * 3600) / conc;
      if (Math.abs(mlh - lastR) > 1e-9 || t === 0) { rate.push({ x: t / 60, y: mlh }); lastR = mlh; }
    }
    rate.push({ x: H / 60, y: lastR });
    // taxa de bolus instantâneo é enorme; recortar a escala do eixo
    const maint = r.steps.filter((s) => s.type === 'rate').map((s) => s.mlh);
    const maxMaint = maint.length ? Math.max(...maint) : 0;
    const ch = inf.chart;
    ch.data.datasets[0].data = cp;
    ch.data.datasets[1].data = ce;
    ch.data.datasets[2].data = tg;
    ch.data.datasets[3].data = rate;
    ch.options.scales.x.max = H / 60;
    ch.options.scales.x.ticks.stepSize = H > 6 * 3600 ? 60 : H > 2 * 3600 ? 30 : 15;
    const maxConc = Math.max(...cp.map((p) => p.y), ...ce.map((p) => p.y), ...tg.map((p) => p.y || 0));
    ch.options.scales.y.suggestedMax = maxConc * 1.1 || 1;
    ch.options.scales.y2.max = maxMaint > 0 ? Math.ceil(maxMaint * 1.6) : undefined;
    ch.options.scales.y.title.text = PK.DRUGS[inf.drugKey].concUnit;
    ch.update('none');
  }

  // ---------------------------------------------------------------------------
  // Cartões de infusão
  // ---------------------------------------------------------------------------
  const container = $('#infusions');
  const tpl = $('#infusionTpl');

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
      inf.events = inf.events.map((e) => (e.type === 'cpt' || e.type === 'cet') ? Object.assign({}, e, { value: d.defaultTarget }) : e);
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
      save();
    });

    const form = $('.action', el), actType = $('.act-type', el), actValue = $('.act-value', el);
    actType.addEventListener('change', () => updateActionUnit(inf));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const type = actType.value;
      let value = parseFloat(actValue.value);
      if (type !== 'stop' && !(value >= 0)) { actValue.focus(); return; }
      if (type === 'stop') value = 0;
      const t = Math.round(state.time);
      inf.events = inf.events.filter((ev) => !(ev.t === t && (ev.type === 'bolus') === (type === 'bolus')));
      inf.events.push({ t, type, value });
      inf.events.sort((a, b) => a.t - b.t);
      refreshCard(inf, true);
    });

    $('tbody', el).addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.t) setTime(+tr.dataset.t);
    });
    $('.events', el).addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        inf.events.splice(+del.dataset.del, 1);
        refreshCard(inf, true);
        return;
      }
      const go = e.target.closest('[data-go]');
      if (go) setTime(+go.dataset.go);
    });

    buildChart(inf);
    refreshCard(inf, true);
  }

  function updateActionUnit(inf) {
    const el = inf.el, drug = PK.DRUGS[inf.drugKey];
    const type = $('.act-type', el).value, val = $('.act-value', el), unit = $('.act-unit', el);
    val.disabled = type === 'stop';
    unit.textContent = { cet: drug.concUnit, cpt: drug.concUnit, rate: 'ml/h', bolus: drug.doseUnit, stop: '' }[type];
    if (type === 'cet' || type === 'cpt') val.placeholder = String(drug.defaultTarget).replace('.', ',');
    else val.placeholder = '';
  }

  const EVENT_LABEL = { cet: 'Alvo Ce', cpt: 'Alvo Cp', rate: 'Taxa', bolus: 'Bolus', stop: 'Parar' };

  function refreshCard(inf, resimulate) {
    const el = inf.el, drug = PK.DRUGS[inf.drugKey];
    if (resimulate) simulateInfusion(inf);

    $('.swatch', el).style.background = drug.color;
    $('.inf-title', el).textContent = drug.name;
    $('.inf-model', el).textContent = `${inf.modelName} · ${nf(inf.concentration, inf.concentration < 1 ? 2 : inf.concentration % 1 ? 1 : 0)} ${drug.doseUnit}/ml`;
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
    const p = state.patient;
    if (p.age < ages[0] || p.age > ages[1]) {
      warn.hidden = false;
      warn.textContent = `O modelo ${inf.modelName} foi desenvolvido para idades entre ${ages[0]} e ${ages[1]} anos.`;
    } else warn.hidden = true;

    // eventos
    const evBox = $('.events', el);
    evBox.innerHTML = '';
    if (!inf.events.length) {
      evBox.innerHTML = '<span class="muted small">Nenhuma ação. Escolha um alvo e clique em Aplicar para iniciar no tempo atual.</span>';
    }
    inf.events.forEach((ev, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const unit = { cet: drug.concUnit, cpt: drug.concUnit, rate: 'ml/h', bolus: drug.doseUnit, stop: '' }[ev.type];
      const val = ev.type === 'stop' ? '' : ` ${nf(ev.value, ev.value % 1 ? 2 : 0)} ${unit}`;
      chip.innerHTML = `<span class="chip-time" data-go="${ev.t}">${fmtTime(ev.t)}</span> ${EVENT_LABEL[ev.type]}${val}<button type="button" data-del="${i}" title="Remover ação">✕</button>`;
      evBox.appendChild(chip);
    });

    // tabela do esquema
    const tbody = $('tbody', el);
    tbody.innerHTML = '';
    const r = inf.result;
    const kg = (mlh) => (mlh * inf.concentration * drug.rateFactor) / p.weight;
    for (const st of r.steps) {
      const tr = document.createElement('tr');
      tr.dataset.t = st.t;
      let action, mlh, perkg;
      if (st.type === 'bolus') {
        tr.className = 'bolus';
        action = `Bolus ${nf(st.ml, 1)} ml (${nf(st.dose, st.dose < 10 ? 1 : 0)} ${drug.doseUnit})` +
          (st.mlh ? ` a ${nf(st.mlh, 0)} ml/h por ${st.duration} s` : '');
        mlh = st.mlh ? nf(st.mlh, 0) : '—';
        perkg = '';
      } else {
        action = st.mlh === 0 ? 'Pausar (0 ml/h)' : 'Ajustar taxa';
        mlh = nf(st.mlh, state.settings.rateResolution < 1 ? 1 : 0);
        perkg = nf(kg(st.mlh), 2);
      }
      tr.innerHTML = `<td>${fmtTime(st.t)}</td><td>${action}</td><td class="num">${mlh}</td><td class="num">${perkg}</td><td class="num">${nf(r.vol[Math.min(st.t, r.horizon)], 1)} ml</td>`;
      tbody.appendChild(tr);
    }
    if (!r.steps.length) tbody.innerHTML = '<tr><td colspan="5" class="muted">Sem passos programados.</td></tr>';

    if (resimulate) {
      updateChartData(inf);
      save();
    }
    updateLive(inf);
  }

  // Leituras no tempo atual
  function updateLive(inf) {
    const el = inf.el, r = inf.result, drug = PK.DRUGS[inf.drugKey];
    const t = Math.min(Math.round(state.time), r.horizon);
    const d = concDigits(drug.concUnit);
    $('.cp-now', el).textContent = `${nf(r.cp[t], d)}`;
    $('.ce-now', el).textContent = `${nf(r.ce[t], d)}`;
    const tg = r.target[t];
    $('.target-now', el).textContent = Number.isNaN(tg) ? '—' : `${nf(tg, d)} ${r.targetType[t] === 'cet' ? '(Ce)' : '(Cp)'}`;
    $('.vol-now', el).textContent = `${nf(r.vol[t], 1)} ml`;
    $('.action-time', el).textContent = `Nova ação em ${fmtTime(state.time)}:`;
    $('.cp-now', el).title = drug.concUnit;
    $('.ce-now', el).title = drug.concUnit;

    // passo vigente
    const steps = r.steps;
    let idx = -1;
    for (let i = 0; i < steps.length; i++) if (steps[i].t <= t) idx = i;
    const cur = idx >= 0 ? steps[idx] : null;
    const rateEl = $('.rate-now', el), kgEl = $('.rate-kg', el);
    const res = state.settings.rateResolution < 1 ? 1 : 0;
    if (!cur) {
      rateEl.textContent = '0 ml/h';
      kgEl.textContent = '';
    } else if (cur.type === 'bolus' && t < cur.t + Math.max(1, cur.duration)) {
      rateEl.textContent = `BOLUS ${nf(cur.ml, 1)} ml`;
      kgEl.textContent = cur.mlh ? `a ${nf(cur.mlh, 0)} ml/h por ${cur.duration} s` : 'em bolus';
    } else {
      const mlh = (r.rate[Math.min(t, r.horizon - 1)] * 3600) / inf.concentration;
      rateEl.textContent = `${nf(mlh, res)} ml/h`;
      kgEl.textContent = `${nf((mlh * inf.concentration * drug.rateFactor) / state.patient.weight, 2)} ${drug.rateUnit}`;
    }
    const next = steps[idx + 1];
    const nc = $('.next-change', el);
    if (next) {
      const what = next.type === 'bolus' ? `bolus de ${nf(next.ml, 1)} ml` : next.mlh === 0 ? 'pausar (0 ml/h)' : `${nf(next.mlh, res)} ml/h`;
      nc.innerHTML = `Próximo ajuste em <strong>${fmtDur(next.t - state.time)}</strong> (${fmtTime(next.t)}): ${what}`;
    } else nc.textContent = steps.length ? 'Sem outros ajustes programados no período simulado.' : '';

    const rows = $('tbody', el).rows;
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('now', i === idx);
      rows[i].classList.toggle('past', i < idx);
    }
    inf.chart.draw();
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
    for (const inf of state.infusions) updateLive(inf);
    clearTimeout(setTime.saveTimer);
    setTime.saveTimer = setTimeout(save, 400);
  }

  let lastFrame = null;
  function tick(ts) {
    if (!state.playing) return;
    if (lastFrame !== null) {
      const dt = (ts - lastFrame) / 1000;
      setTime(state.time + dt * state.speed);
      if (state.time >= horizon()) setPlaying(false);
    }
    lastFrame = ts;
    requestAnimationFrame(tick);
  }
  function setPlaying(p) {
    state.playing = p;
    btnPlay.textContent = p ? '⏸' : '▶';
    lastFrame = null;
    if (p) requestAnimationFrame(tick);
  }

  btnPlay.addEventListener('click', () => setPlaying(!state.playing));
  document.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    const j = b.dataset.jump;
    setTime(j === 'reset' ? 0 : state.time + Number(j));
  }));
  slider.addEventListener('input', () => setTime(+slider.value, true));
  $('#speed').addEventListener('change', (e) => { state.speed = +e.target.value; save(); });

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
    patientInfo();
    refreshAll(true);
  }
  function patientInfo() {
    const p = state.patient;
    const bmi = p.weight / Math.pow(p.height / 100, 2);
    $('#patientInfo').textContent = `IMC ${nf(bmi, 1)} kg/m² · massa magra (James) ${nf(PK.leanBodyMass(p), 1)} kg · massa livre de gordura ${nf(PK.fatFreeMass(p), 1)} kg`;
  }
  for (const f of [...pFields, 'sex', 'opioid']) $('#' + f).addEventListener('change', readPatient);

  function readSettings() {
    const mb = parseFloat($('#maxBolusRate').value);
    state.settings.maxBolusRate = mb >= 0 ? mb : 0;
    state.settings.rateResolution = parseFloat($('#rateResolution').value);
    state.settings.minStepMinutes = parseFloat($('#minStep').value);
    state.settings.horizonH = parseFloat($('#horizon').value);
    slider.max = horizon();
    if (state.time > horizon()) setTime(horizon());
    refreshAll(true);
  }
  for (const f of ['maxBolusRate', 'rateResolution', 'minStep', 'horizon']) $('#' + f).addEventListener('change', readSettings);

  function writeForm() {
    for (const f of pFields) $('#' + f).value = state.patient[f];
    $('#sex').value = state.patient.sex;
    $('#opioid').checked = state.patient.opioid !== false;
    $('#maxBolusRate').value = state.settings.maxBolusRate;
    $('#rateResolution').value = String(state.settings.rateResolution);
    $('#minStep').value = String(state.settings.minStepMinutes);
    $('#horizon').value = String(state.settings.horizonH);
    $('#speed').value = String(state.speed);
    slider.max = horizon();
    patientInfo();
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
    for (const inf of state.infusions) { inf.chart.destroy(); inf.el.remove(); }
    state.infusions = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    const inf = newInfusion('propofol');
    state.infusions.push(inf);
    createCard(inf);
    setTime(0);
  });

  // Sobre
  const about = $('#about');
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
    about.showModal();
  });

  // ---------------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------------
  if (!load() || !state.infusions.length) {
    state.infusions = [newInfusion('propofol'), newInfusion('remifentanil')];
  }
  writeForm();
  for (const inf of state.infusions) createCard(inf);
  setTime(state.time);
})();
