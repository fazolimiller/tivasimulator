/*
 * Geração de esquemas de infusão "TCI manual" para bombas que só aceitam ml/h.
 *
 * Para cada infusão, uma lista de eventos (alvo plasmático, alvo no efeito, taxa manual,
 * bolus, parar) é convertida em uma sequência de passos executáveis na bomba
 * (bolus em ml e taxas em ml/h) e simulada segundo a segundo para obter Cp e Ce.
 *
 * Lógica (adaptada do STANPUMP / SimTIVA):
 *  - Alvo plasmático (Cp): bolus para atingir o alvo em 1 s (ou na taxa máxima de bolus),
 *    depois taxas ideais calculadas em intervalos de 120 s; essas taxas são agrupadas em
 *    degraus que só mudam quando a taxa ideal se afasta mais que um limiar (%), usando
 *    uma média ponderada entre a taxa do início e a do fim do degrau.
 *  - Alvo no efeito (Ce): bolus calculado para que o pico de Ce seja igual ao alvo,
 *    pausa até o pico, depois manutenção como no alvo plasmático.
 *  - Redução de alvo: pausa da infusão até a concentração cair ao alvo e retomada.
 */
(function (root) {
  'use strict';

  const PK = root.PK || (typeof require !== 'undefined' ? require('./pk.js') : null);

  const INTERVAL = 120; // s – intervalo de cálculo das taxas ideais

  const DEFAULT_SETTINGS = {
    horizon: 4 * 3600, // s
    maxBolusRate: 1200, // ml/h; 0 = bolus instantâneo (1 s)
    rateResolution: 0.1, // ml/h
    threshold: 0.08, // desvio relativo da taxa ideal que dispara um novo degrau
    avgFactor: 0.667, // peso da taxa do início do degrau na média
    minStepMinutes: 2, // tempo mínimo entre mudanças de taxa (múltiplo de 2 min)
  };

  function roundTo(x, res) {
    return Math.round(x / res) * res;
  }

  /**
   * Simula uma infusão.
   * @param {object} sys sistema criado por PK.createSystem
   * @param {{concentration:number, events:Array}} inf
   *        events: {t (s), type:'cpt'|'cet'|'rate'|'bolus'|'stop', value}
   *        - cpt/cet: value = alvo (unidade de concentração do fármaco)
   *        - rate: value = ml/h
   *        - bolus: value = dose (mg ou mcg)
   * @param {object} settings ver DEFAULT_SETTINGS
   */
  function simulate(sys, inf, settings) {
    const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const H = Math.max(60, Math.round(cfg.horizon));
    const conc = inf.concentration; // dose/ml
    const mlhToRate = (mlh) => (mlh * conc) / 3600; // ml/h -> dose/s
    const rateToMlh = (r) => (r * 3600) / conc;

    const out = {
      horizon: H,
      rate: new Float64Array(H), // dose/s durante o segundo [t, t+1)
      cp: new Float64Array(H + 1),
      ce: new Float64Array(H + 1),
      vol: new Float64Array(H + 1), // ml acumulados
      target: new Float64Array(H + 1).fill(NaN),
      targetType: new Array(H + 1).fill(null),
      steps: [],
    };

    let s = PK.newState();
    let t = 0;
    let lastRateMlh = null; // última taxa anunciada nos passos

    function record(st) {
      out.cp[t] = PK.cp(st);
      out.ce[t] = PK.ce(st);
    }
    record(s);

    // Emite `n` segundos à taxa `rate` (dose/s), sem ultrapassar `tEnd`
    function emit(rate, n, tEnd) {
      for (let k = 0; k < n && t < tEnd; k++) {
        out.rate[t] = rate;
        s = PK.step(sys, s, rate);
        out.vol[t + 1] = out.vol[t] + rate / conc;
        t++;
        record(s);
      }
    }

    function announceRate(mlh, extra) {
      if (lastRateMlh !== null && Math.abs(lastRateMlh - mlh) < 1e-9 && !extra) return;
      out.steps.push(Object.assign({ t, type: 'rate', mlh }, extra || {}));
      lastRateMlh = mlh;
    }

    // Bolus de `dose` na taxa máxima configurada (ou em 1 s)
    function giveBolus(dose, tEnd, label) {
      if (dose <= 0) return;
      const t0 = t;
      if (cfg.maxBolusRate > 0) {
        const rmax = mlhToRate(cfg.maxBolusRate);
        let remaining = dose;
        while (remaining > 1e-12 && t < tEnd) {
          const r = Math.min(rmax, remaining);
          emit(r, 1, tEnd);
          remaining -= r;
        }
        out.steps.push({ t: t0, type: 'bolus', dose: dose - remaining, ml: (dose - remaining) / conc,
          mlh: cfg.maxBolusRate, duration: t - t0, label });
      } else {
        emit(dose, 1, tEnd);
        out.steps.push({ t: t0, type: 'bolus', dose, ml: dose / conc, mlh: null, duration: 1, label });
      }
      lastRateMlh = null; // força anunciar a próxima taxa
    }

    // Taxas ideais (dose/s) em intervalos de 120 s para manter Cp = alvo, a partir do estado st
    function idealRates(st, target, n) {
      const res = new Array(n);
      const udf = sys.pUdf(INTERVAL);
      let x = st;
      for (let i = 0; i < n; i++) {
        const free = PK.cp(PK.advance(sys, x, 0, INTERVAL));
        const r = Math.max(0, (target - free) / udf);
        res[i] = r;
        x = PK.advance(sys, x, r, INTERVAL);
      }
      return res;
    }

    // Manutenção do alvo plasmático com degraus de taxa em ml/h (malha fechada a cada degrau)
    function maintain(target, tEnd) {
      const minK = Math.max(1, Math.round(cfg.minStepMinutes * 60 / INTERVAL));
      while (t < tEnd) {
        const n = Math.min(180, Math.max(1, Math.ceil((tEnd - t) / INTERVAL)));
        const ideal = idealRates(s, target, n);
        let j = -1;
        if (ideal[0] <= 0) {
          for (let k = 1; k < n; k++) if (ideal[k] > 0) { j = k; break; }
        } else {
          for (let k = minK; k < n; k++) {
            if (Math.abs(ideal[0] - ideal[k]) / ideal[0] > cfg.threshold) { j = k; break; }
          }
        }
        let r, len;
        if (ideal[0] <= 0) {
          r = 0;
          len = j > 0 ? j * INTERVAL : tEnd - t;
        } else if (j > 0) {
          r = (ideal[0] - ideal[j]) * cfg.avgFactor + ideal[j];
          len = j * INTERVAL;
        } else {
          r = ideal.reduce((a, b) => a + b, 0) / n;
          len = tEnd - t;
        }
        const mlh = Math.max(0, roundTo(rateToMlh(r), cfg.rateResolution));
        announceRate(mlh);
        emit(mlhToRate(mlh), len, tEnd);
      }
    }

    // Pausa até que f(estado) <= alvo, no máximo até tEnd
    function pauseUntil(pred, tEnd) {
      if (t >= tEnd) return;
      announceRate(0);
      while (t < tEnd && !pred(s)) emit(0, 1, tEnd);
    }

    function cptSegment(target, tEnd, allowBolus) {
      const next = PK.cp(PK.step(sys, s, 0));
      if (allowBolus && next < target) {
        const udf1 = sys.pUdf(1);
        if (cfg.maxBolusRate > 0) {
          // bolus na taxa máxima até Cp alcançar o alvo
          const rmax = mlhToRate(cfg.maxBolusRate);
          let dose = 0;
          const t0 = t;
          while (t < tEnd) {
            const need = (target - PK.cp(PK.step(sys, s, 0))) / udf1;
            if (need <= 0) break;
            const r = Math.min(rmax, need);
            emit(r, 1, tEnd);
            dose += r;
            if (r < rmax) break;
          }
          out.steps.push({ t: t0, type: 'bolus', dose, ml: dose / conc, mlh: cfg.maxBolusRate, duration: t - t0 });
          lastRateMlh = null;
        } else {
          giveBolus((target - next) / udf1, tEnd);
        }
      } else if (PK.cp(s) > target) {
        pauseUntil((st) => PK.cp(st) <= target, tEnd);
      }
      maintain(target, tEnd);
    }

    // Pico de Ce resultante de um bolus `dose` a partir do estado atual
    function peakAfterBolus(dose) {
      const rmax = cfg.maxBolusRate > 0 ? mlhToRate(cfg.maxBolusRate) : Infinity;
      let x = s, remaining = dose, best = PK.ce(s), tBest = 0;
      for (let k = 1; k <= 7200; k++) {
        const r = Math.min(rmax, remaining);
        remaining -= r;
        x = PK.step(sys, x, r);
        const c = PK.ce(x);
        if (c > best) { best = c; tBest = k; }
        else if (remaining <= 0 && c < best) break;
      }
      return { peak: best, tPeak: tBest };
    }

    function cetSegment(target, tEnd) {
      const c_e = PK.ce(s), c_p = PK.cp(s);
      if (Math.abs(target - c_e) < target * 0.05 && Math.abs(c_e - c_p) < c_e * 0.1) {
        // Ce ~ alvo e Cp ~ Ce: manter como alvo plasmático
        cptSegment(target, tEnd, false);
        return;
      }
      if (c_e >= target) {
        // reduzir: pausa entre o tempo para Cp e o tempo para Ce caírem ao alvo
        let cptPause = 0, cetPause = 0, x = s;
        while (PK.cp(x) >= target && cptPause < 86400) { x = PK.step(sys, x, 0); cptPause++; }
        x = PK.advance(sys, s, 0, cptPause);
        cetPause = cptPause;
        while (PK.ce(x) >= target && cetPause < 86400) { x = PK.step(sys, x, 0); cetPause++; }
        const sg = 1 / (1 + Math.exp(-(cetPause - 300) / 50));
        const corr = 0.5 * sg + 0.3;
        const breakpoint = Math.floor((cetPause - cptPause) * corr + cptPause);
        announceRate(0);
        emit(0, breakpoint, tEnd);
        maintain(target, tEnd);
        return;
      }
      // aumentar: bolus cujo pico de Ce = alvo
      const p0 = peakAfterBolus(0);
      if (p0.peak >= target) {
        pauseUntil((st) => PK.ce(st) >= target, Math.min(tEnd, t + p0.tPeak));
        maintain(target, tEnd);
        return;
      }
      let lo = 0, hi = Math.max(1e-6, (target - c_e) * sys.params.vc / sys.drug.concFactor);
      while (peakAfterBolus(hi).peak < target) hi *= 2;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (peakAfterBolus(mid).peak < target) lo = mid; else hi = mid;
      }
      const dose = hi;
      const { tPeak } = peakAfterBolus(dose);
      const t0 = t;
      giveBolus(dose, tEnd);
      const pauseLen = tPeak - (t - t0);
      if (pauseLen > 0 && t < tEnd) {
        announceRate(0);
        emit(0, pauseLen, tEnd);
      }
      maintain(target, tEnd);
    }

    const events = (inf.events || []).filter((e) => e.t >= 0 && e.t < H).slice().sort((a, b) => a.t - b.t);
    let mode = null; // { type, value } do modo vigente (para retomar após bolus)

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const tStart = Math.round(ev.t);
      const tEnd = i + 1 < events.length ? Math.round(events[i + 1].t) : H;
      // tempo anterior ao evento sem nada definido: taxa 0
      if (t < tStart) {
        if (!mode) emit(0, tStart - t, tStart);
      }
      t = Math.max(t, tStart);
      if (t >= tEnd) continue;

      if (ev.type === 'bolus') {
        giveBolus(ev.value, tEnd, 'manual');
        if (mode && (mode.type === 'cpt' || mode.type === 'cet')) {
          fillTarget(mode, t, tEnd);
          // após bolus manual em TCI, retomar como alvo plasmático (sem novo bolus)
          if (mode.type === 'cpt') cptSegment(mode.value, tEnd, false);
          else cetSegment(mode.value, tEnd);
        } else if (mode && mode.type === 'rate') {
          announceRate(mode.value);
          emit(mlhToRate(mode.value), tEnd - t, tEnd);
        } else {
          announceRate(0);
          emit(0, tEnd - t, tEnd);
        }
        continue;
      }

      mode = { type: ev.type, value: ev.value };
      fillTarget(mode, t, tEnd);
      if (ev.type === 'cpt') cptSegment(ev.value, tEnd, true);
      else if (ev.type === 'cet') cetSegment(ev.value, tEnd);
      else if (ev.type === 'rate') {
        announceRate(ev.value);
        emit(mlhToRate(ev.value), tEnd - t, tEnd);
      } else if (ev.type === 'stop') {
        announceRate(0);
        emit(0, tEnd - t, tEnd);
      }
    }
    if (t < H) emit(0, H - t, H);

    function fillTarget(m, a, b) {
      if (m.type !== 'cpt' && m.type !== 'cet') return;
      for (let k = a; k <= b && k <= H; k++) {
        out.target[k] = m.value;
        out.targetType[k] = m.type;
      }
    }

    // Remove degraus de duração zero e taxas repetidas
    const clean = [];
    for (const st of out.steps) {
      if (st.type === 'rate') {
        const prev = clean[clean.length - 1];
        if (prev && prev.type === 'rate' && prev.t === st.t) clean.pop();
        const last = clean.slice().reverse().find((x) => x.type === 'rate');
        const lastIsBolus = clean.length && clean[clean.length - 1].type === 'bolus';
        if (last && !lastIsBolus && Math.abs(last.mlh - st.mlh) < 1e-9) continue;
      }
      clean.push(st);
    }
    out.steps = clean.filter((st) => st.t < H);
    return out;
  }

  // Passo da bomba vigente no instante t (s)
  function stepAt(steps, t) {
    let cur = null;
    for (const st of steps) {
      if (st.t <= t) cur = st; else break;
    }
    return cur;
  }

  const api = { simulate, stepAt, DEFAULT_SETTINGS, INTERVAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TCI = api;
})(typeof self !== 'undefined' ? self : this);
