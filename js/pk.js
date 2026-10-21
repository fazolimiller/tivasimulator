/*
 * Motor farmacocinético/farmacodinâmico (modelo tricompartimental + compartimento efeito).
 *
 * Baseado nos algoritmos publicados do STANPUMP (S. Shafer) e na implementação
 * usada pelo SimTIVA: solução analítica do modelo de 3 compartimentos em passos de
 * 1 segundo, com taxa constante dentro de cada segundo.
 *
 * Unidades internas:
 *   - tempo: segundos
 *   - quantidade: "unidade de dose" do fármaco (mg para propofol/cetamina, mcg para opioides/dex)
 *   - taxa: unidade de dose / s
 *   - concentração: unidade de exibição do fármaco (mcg/ml ou ng/ml)
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Covariáveis auxiliares
  // ---------------------------------------------------------------------------

  // Massa magra (James) – usada por Schnider e Minto. sex: 'M' | 'F'
  function leanBodyMass(p) {
    const r = p.weight / p.height;
    return p.sex === 'M' ? 1.1 * p.weight - 128 * r * r : 1.07 * p.weight - 148 * r * r;
  }

  function sigmoid(x, e50, gamma) {
    return Math.pow(x, gamma) / (Math.pow(x, gamma) + Math.pow(e50, gamma));
  }

  // Massa livre de gordura (Al-Sallami) – usada pelos modelos de Eleveld
  function fatFreeMass(p) {
    const bmi = p.weight / Math.pow(p.height / 100, 2);
    if (p.sex === 'M') {
      return (0.88 + (1 - 0.88) / (1 + Math.pow(p.age / 13.4, -12.7))) * ((9270 * p.weight) / (6680 + 216 * bmi));
    }
    return (1.11 + (1 - 1.11) / (1 + Math.pow(p.age / 7.1, -1.1))) * ((9270 * p.weight) / (8780 + 244 * bmi));
  }

  const FFM_REF = (0.88 + (1 - 0.88) / (1 + Math.pow(35 / 13.4, -12.7))) * ((9270 * 70) / (6680 + 216 * 24.22145));

  function fromClearances(vc, v2, v3, cl1, cl2, cl3) {
    return { vc, v2, v3, k10: cl1 / vc, k12: cl2 / vc, k13: cl3 / vc, k21: cl2 / v2, k31: cl3 / v3 };
  }

  // ---------------------------------------------------------------------------
  // Fármacos e modelos
  //   doseUnit: unidade da quantidade infundida
  //   concUnit: unidade de concentração plasmática/efeito exibida
  //   concFactor: (doseUnit / L) -> concUnit
  //   rateUnit: unidade da taxa por peso exibida (e fator a partir de doseUnit/kg/h)
  // ---------------------------------------------------------------------------

  const DRUGS = {
    propofol: {
      name: 'Propofol', doseUnit: 'mg', concUnit: 'mcg/ml', concFactor: 1,
      rateUnit: 'mg/kg/h', rateFactor: 1, defaultConc: 10, defaultTarget: 3, color: '#2563eb', threshold: 0.08, avgFactor: 0.667,
      models: ['Marsh', 'Schnider', 'Eleveld', 'Paedfusor'],
    },
    remifentanil: {
      name: 'Remifentanil', doseUnit: 'mcg', concUnit: 'ng/ml', concFactor: 1,
      rateUnit: 'mcg/kg/min', rateFactor: 1 / 60, defaultConc: 50, defaultTarget: 3, color: '#dc2626', threshold: 0.08, avgFactor: 0.667,
      models: ['Minto', 'Eleveld-Remifentanil'],
    },
    fentanyl: {
      name: 'Fentanil', doseUnit: 'mcg', concUnit: 'ng/ml', concFactor: 1,
      rateUnit: 'mcg/kg/h', rateFactor: 1, defaultConc: 50, defaultTarget: 2, color: '#9333ea', threshold: 0.08, avgFactor: 0.667,
      models: ['Shafer'],
    },
    alfentanil: {
      name: 'Alfentanil', doseUnit: 'mcg', concUnit: 'ng/ml', concFactor: 1,
      rateUnit: 'mcg/kg/h', rateFactor: 1, defaultConc: 500, defaultTarget: 60, color: '#c026d3', threshold: 0.15, avgFactor: 0.63,
      models: ['Maitre'],
    },
    dexmedetomidine: {
      name: 'Dexmedetomidina', doseUnit: 'mcg', concUnit: 'ng/ml', concFactor: 1,
      rateUnit: 'mcg/kg/h', rateFactor: 1, defaultConc: 4, defaultTarget: 0.6, color: '#059669', threshold: 0.15, avgFactor: 0.75,
      models: ['Hannivoort', 'Dyck'],
    },
    ketamine: {
      name: 'Cetamina', doseUnit: 'mg', concUnit: 'ng/ml', concFactor: 1000,
      rateUnit: 'mg/kg/h', rateFactor: 1, defaultConc: 10, defaultTarget: 150, color: '#d97706', threshold: 0.15, avgFactor: 0.52,
      models: ['Kamp', 'Domino'],
    },
  };

  // Cada modelo devolve { vc, k10, k12, k13, k21, k31, ke0 } com k em min^-1 e volumes em L.
  const MODELS = {
    Marsh: {
      ref: 'Marsh, BJA 1991;67:41-8 (ke0 1,21 – Struys, Anesthesiology 2000)',
      ages: [16, 100],
      params(p) {
        return { vc: 0.228 * p.weight, k10: 0.119, k12: 0.112, k13: 0.0419, k21: 0.055, k31: 0.0033, ke0: 1.21 };
      },
    },
    Schnider: {
      ref: 'Schnider, Anesthesiology 1998;88:1170-82',
      ages: [16, 100],
      params(p) {
        const vc = 4.27, v2 = 18.9 - 0.391 * (p.age - 53), v3 = 238;
        const cl1 = 1.89 + 0.0456 * (p.weight - 77) - 0.0681 * (leanBodyMass(p) - 59) + 0.0264 * (p.height - 177);
        const cl2 = 1.29 - 0.024 * (p.age - 53), cl3 = 0.836;
        return Object.assign(fromClearances(vc, v2, v3, cl1, cl2, cl3), { ke0: 0.456 });
      },
    },
    Eleveld: {
      ref: 'Eleveld, BJA 2018;120:942-59 (propofol)',
      ages: [0, 100],
      params(p) {
        const toWeeks = 52.1429;
        const pma = p.age * toWeeks + 40;
        const opioid = p.opioid !== false;
        const fcentral = (x) => sigmoid(x, 33.6, 1);
        const fageing = (x) => Math.exp(x * (p.age - 35));
        const fclmat = (x) => sigmoid(x, 42.3, 9.06);
        const fq3mat = (x) => sigmoid(x + 40, 68.3, 1);
        const vc = 6.28 * fcentral(p.weight) / fcentral(70);
        const v2 = 25.5 * p.weight / 70 * fageing(-0.0156);
        const v3 = 273 * fatFreeMass(p) / FFM_REF * (opioid ? Math.exp(-0.0138 * p.age) : 1);
        const cl1 = (p.sex === 'M' ? 1.79 : 2.1) * Math.pow(p.weight / 70, 0.75) *
          (fclmat(pma) / fclmat(35 * toWeeks + 40)) * (opioid ? Math.exp(-0.00286 * p.age) : 1);
        const cl2 = 1.75 * Math.pow(v2 / 25.5, 0.75) * (1 + 1.3 * (1 - fq3mat(p.age * toWeeks)));
        const cl3 = 1.11 * Math.pow(v3 / 273, 0.75) * (fq3mat(p.age * toWeeks) / fq3mat(35 * toWeeks));
        return Object.assign(fromClearances(vc, v2, v3, cl1, cl2, cl3), { ke0: 0.146 * Math.pow(p.weight / 70, -0.25) });
      },
    },
    Paedfusor: {
      ref: 'Absalom, BJA 2003;91:507-13 (ke0 por Tpeak – Jeleazcov, BJA 2008)',
      ages: [1, 16],
      params(p) {
        const r = { k12: 0.114, k13: 0.0419, k21: 0.055, k31: 0.0033 };
        if (p.age < 13) {
          r.vc = 0.4584 * p.weight;
          r.k10 = 0.1527 * Math.pow(p.weight, -0.3);
          r.ke0 = 0.0351 * Math.log(p.weight) + 0.7751 * Math.exp(-0.099 * p.age);
        } else if (p.age < 14) {
          Object.assign(r, { vc: 0.4 * p.weight, k10: 0.0678, ke0: 0.319 });
        } else if (p.age < 15) {
          Object.assign(r, { vc: 0.342 * p.weight, k10: 0.0792, ke0: 0.286 });
        } else if (p.age < 16) {
          Object.assign(r, { vc: 0.284 * p.weight, k10: 0.0954, ke0: 0.251 });
        } else {
          Object.assign(r, { vc: 0.229 * p.weight, k10: 0.119, ke0: 1.21 });
        }
        return r;
      },
    },
    Minto: {
      ref: 'Minto, Anesthesiology 1997;86:10-23',
      ages: [12, 100],
      params(p) {
        const lbm = leanBodyMass(p);
        const vc = 5.1 - 0.0201 * (p.age - 40) + 0.072 * (lbm - 55);
        const v2 = 9.82 - 0.0811 * (p.age - 40) + 0.108 * (lbm - 55);
        const v3 = 5.42;
        const cl1 = 2.6 - 0.0162 * (p.age - 40) + 0.0191 * (lbm - 55);
        const cl2 = 2.05 - 0.0301 * (p.age - 40);
        const cl3 = 0.076 - 0.00113 * (p.age - 40);
        return Object.assign(fromClearances(vc, v2, v3, cl1, cl2, cl3), { ke0: 0.595 - 0.007 * (p.age - 40) });
      },
    },
    'Eleveld-Remifentanil': {
      ref: 'Eleveld, Anesthesiology 2017;126:1005-18 (remifentanil)',
      ages: [0, 100],
      params(p) {
        const size = fatFreeMass(p) / FFM_REF;
        const fageing = (x) => Math.exp(x * (p.age - 35));
        const ksex = p.sex === 'M' ? 1 : 1 + 0.47 * sigmoid(p.age, 12, 6) * (1 - sigmoid(p.age, 45, 6));
        const vc = 5.81 * size * fageing(-0.00554);
        const v2 = 8.82 * size * fageing(-0.00327) * ksex;
        const v3 = 5.03 * size * fageing(-0.0315) * Math.exp(-0.026 * (p.weight - 70));
        const cl1 = 2.58 * Math.pow(size, 0.75) * (sigmoid(p.weight, 2.88, 2) / sigmoid(70, 2.88, 2)) * ksex * fageing(-0.00327);
        const cl2 = 1.72 * Math.pow(v2 / 8.82, 0.75) * fageing(-0.00554) * ksex;
        const cl3 = 0.124 * Math.pow(v3 / 5.03, 0.75) * fageing(-0.00554);
        return Object.assign(fromClearances(vc, v2, v3, cl1, cl2, cl3), { ke0: 1.09 * fageing(-0.0289) });
      },
    },
    Shafer: {
      ref: 'Shafer, Anesthesiology 1990;73:1091-102 (ke0 – Scott 1991)',
      ages: [16, 100],
      params() {
        return { vc: 6.09, k10: 0.0827, k12: 0.471, k13: 0.225, k21: 0.102, k31: 0.006, ke0: Math.log(2) / 6.6 };
      },
    },
    Maitre: {
      ref: 'Maitre, Anesthesiology 1987;66:3-12 (ke0 – Scott & Stanski 1987)',
      ages: [16, 100],
      params(p) {
        const vc = p.sex === 'F' ? 0.111 * p.weight : 0.111 * 1.15 * p.weight;
        const old = Math.max(0, p.age - 40);
        return {
          vc, k10: (0.356 - 0.00269 * old) / vc, k12: 0.104, k13: 0.017, k21: 0.0673,
          k31: 0.0126 - 0.000113 * old, ke0: Math.log(2) / 0.9,
        };
      },
    },
    Hannivoort: {
      ref: 'Hannivoort, Anesthesiology 2015;123:357-67 (ke0 MOAA/S – Colin, BJA 2017)',
      ages: [18, 100],
      params(p) {
        const w = p.weight / 70;
        const vc = 1.78 * w, v2 = 30.3 * w, v3 = 52 * w;
        const cl1 = 0.686 * Math.pow(w, 0.75), cl2 = 2.98 * Math.pow(v2 / 30.3, 0.75), cl3 = 0.602 * Math.pow(v3 / 52, 0.75);
        const ke0 = (0.036013 * Math.log(p.height) - 0.1103923) + (-0.00003167 * p.height - 0.00083989) * Math.log(p.weight);
        return Object.assign(fromClearances(vc, v2, v3, cl1, cl2, cl3), { ke0 });
      },
    },
    Dyck: {
      ref: 'Dyck, Anesthesiology 1993;78:821-8 (ke0 MOAA/S – Colin, BJA 2017)',
      ages: [18, 100],
      params(p) {
        return Object.assign(fromClearances(7.99, 13.8, 187, 0.00791 * p.height - 0.927, 2.26, 1.99), { ke0: 0.0428 });
      },
    },
    Kamp: {
      ref: 'Kamp, Anesthesiology 2020;133:1192-213 (ke0 – Navarrete, JCMC 2025)',
      ages: [18, 100],
      params(p) {
        const w = p.weight / 70, a = Math.pow(w, 0.75);
        return Object.assign(fromClearances(25 * w, 56 * w, 157 * w, 84 / 60 * a, 161 / 60 * a, 79 / 60 * a),
          { ke0: 0.1876 * Math.log(p.weight) + 0.5932 });
      },
    },
    Domino: {
      ref: 'Domino, Clin Pharmacol Ther 1984 (ke0 – Navarrete, JCMC 2025)',
      ages: [18, 100],
      params(p) {
        return { vc: 0.063 * p.weight, k10: 0.4381, k12: 0.5921, k13: 0.59, k21: 0.247, k31: 0.0146, ke0: 0.238 };
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Solução do modelo
  // ---------------------------------------------------------------------------

  // Raízes (lambdas) do polinômio característico do modelo 3-compartimentos (cube.c, STANPUMP)
  function cubeRoots(k10, k12, k21, k13, k31) {
    const a0 = k10 * k21 * k31;
    const a1 = k10 * k31 + k21 * k31 + k21 * k13 + k10 * k21 + k31 * k12;
    const a2 = k10 + k12 + k13 + k21 + k31;
    const p = a1 - (a2 * a2) / 3;
    const q = (2 * a2 * a2 * a2) / 27 - (a1 * a2) / 3 + a0;
    let r1 = Math.sqrt(-(p * p * p) / 27);
    let phi = Math.max(-1, Math.min(1, (-q / 2) / r1));
    phi = Math.acos(phi) / 3;
    r1 = 2 * Math.exp(Math.log(r1) / 3);
    const deg = Math.PI / 180;
    const r = [
      -(Math.cos(phi) * r1 - a2 / 3),
      -(Math.cos(phi + 120 * deg) * r1 - a2 / 3),
      -(Math.cos(phi + 240 * deg) * r1 - a2 / 3),
    ];
    return r.sort((a, b) => a - b);
  }

  /**
   * Cria um "sistema" farmacocinético pronto para simular.
   * @param {string} drugKey chave em DRUGS
   * @param {string} modelName chave em MODELS
   * @param {{age:number, weight:number, height:number, sex:'M'|'F', opioid?:boolean}} patient
   */
  function createSystem(drugKey, modelName, patient) {
    const drug = DRUGS[drugKey];
    const model = MODELS[modelName];
    if (!drug || !model) throw new Error('Fármaco/modelo desconhecido: ' + drugKey + '/' + modelName);
    const pm = model.params(patient);
    // min^-1 -> s^-1
    const k10 = pm.k10 / 60, k12 = pm.k12 / 60, k13 = pm.k13 / 60, k21 = pm.k21 / 60, k31 = pm.k31 / 60, ke0 = pm.ke0 / 60;
    const [l1, l2, l3] = cubeRoots(k10, k12, k21, k13, k31);
    const vc = pm.vc;
    const f = drug.concFactor;

    // Coeficientes da resposta a uma infusão unitária (1 unidade/s) no plasma e no efeito
    const pc = [
      ((k21 - l1) * (k31 - l1)) / (l1 - l2) / (l1 - l3) / vc / l1 * f,
      ((k21 - l2) * (k31 - l2)) / (l2 - l1) / (l2 - l3) / vc / l2 * f,
      ((k21 - l3) * (k31 - l3)) / (l3 - l2) / (l3 - l1) / vc / l3 * f,
    ];
    const ec = [
      (pc[0] / (ke0 - l1)) * ke0,
      (pc[1] / (ke0 - l2)) * ke0,
      (pc[2] / (ke0 - l3)) * ke0,
      ((ke0 - k21) * (ke0 - k31)) / (l1 - ke0) / (l2 - ke0) / (l3 - ke0) / vc * f,
    ];
    const lambdas = [l1, l2, l3, ke0];
    const decay1 = lambdas.map((l) => Math.exp(-l));

    const sys = {
      drugKey, drug, modelName, model, patient,
      params: Object.assign({}, pm),
      lambdas, pc, ec, decay1,
      peakTime: 0,
    };

    // Concentração plasmática após t s de uma infusão de 1 unidade/s (p_udf no STANPUMP)
    sys.pUdf = function (t) {
      let s = 0;
      for (let i = 0; i < 3; i++) s += pc[i] * (1 - Math.exp(-lambdas[i] * t));
      return s;
    };

    // Tempo até o pico de efeito após bolus instantâneo (1 s)
    let st = newState();
    st = step(sys, st, 1);
    let prev = ce(st), t = 1;
    for (; t < 7200; t++) {
      st = step(sys, st, 0);
      const c = ce(st);
      if (c <= prev) break;
      prev = c;
    }
    sys.peakTime = t;
    return sys;
  }

  // Estado: p[0..2] = componentes plasmáticos, e[0..3] = componentes no efeito
  function newState() {
    return { p: [0, 0, 0], e: [0, 0, 0, 0] };
  }

  function cloneState(s) {
    return { p: s.p.slice(), e: s.e.slice() };
  }

  function cp(s) { return s.p[0] + s.p[1] + s.p[2]; }
  function ce(s) { return s.e[0] + s.e[1] + s.e[2] + s.e[3]; }

  // Avança 1 s com taxa constante `rate` (unidade/s). Retorna novo estado.
  function step(sys, s, rate) {
    const d = sys.decay1, pc = sys.pc, ec = sys.ec;
    return {
      p: [
        s.p[0] * d[0] + pc[0] * rate * (1 - d[0]),
        s.p[1] * d[1] + pc[1] * rate * (1 - d[1]),
        s.p[2] * d[2] + pc[2] * rate * (1 - d[2]),
      ],
      e: [
        s.e[0] * d[0] + ec[0] * rate * (1 - d[0]),
        s.e[1] * d[1] + ec[1] * rate * (1 - d[1]),
        s.e[2] * d[2] + ec[2] * rate * (1 - d[2]),
        s.e[3] * d[3] + ec[3] * rate * (1 - d[3]),
      ],
    };
  }

  // Avança `t` s com taxa constante `rate` (solução fechada, sem iterar segundo a segundo)
  function advance(sys, s, rate, t) {
    const L = sys.lambdas.map((l) => Math.exp(-l * t));
    return {
      p: [0, 1, 2].map((i) => s.p[i] * L[i] + sys.pc[i] * rate * (1 - L[i])),
      e: [0, 1, 2, 3].map((i) => s.e[i] * L[i] + sys.ec[i] * rate * (1 - L[i])),
    };
  }

  const api = {
    DRUGS, MODELS, createSystem, newState, cloneState, step, advance, cp, ce,
    leanBodyMass, fatFreeMass,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PK = api;
})(typeof self !== 'undefined' ? self : this);
