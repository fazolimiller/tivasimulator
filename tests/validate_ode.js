// Valida a solução analítica contra integração numérica (RK4) das EDOs do modelo 3-compartimentos + efeito.
const PK = require('../js/pk.js');
const assert = require('assert');
const pt = { age: 50, weight: 80, height: 175, sex: 'F' };
let worst = 0;
for (const [drug, info] of Object.entries(PK.DRUGS)) {
  for (const m of info.models) {
    const sys = PK.createSystem(drug, m, pt);
    const p = sys.params, f = info.concFactor;
    const k = { k10: p.k10 / 60, k12: p.k12 / 60, k13: p.k13 / 60, k21: p.k21 / 60, k31: p.k31 / 60, ke0: p.ke0 / 60 };
    const rateAt = (t) => (t < 30 ? 2 : t < 1200 ? 0.05 : 0); // dose/s
    // estado: quantidades A1, A2, A3 e Ce
    let y = [0, 0, 0, 0];
    const dy = (t, y, r) => {
      const c1 = y[0] / p.vc * f;
      return [
        r - (k.k10 + k.k12 + k.k13) * y[0] + k.k21 * y[1] + k.k31 * y[2],
        k.k12 * y[0] - k.k21 * y[1],
        k.k13 * y[0] - k.k31 * y[2],
        k.ke0 * (c1 - y[3]),
      ];
    };
    const h = 0.05;
    let s = PK.newState();
    for (let sec = 0; sec < 2400; sec++) {
      for (let i = 0; i < 1 / h; i++) {
        const r = rateAt(sec + 0.5);
        const a = dy(0, y, r), b = dy(0, y.map((v, j) => v + a[j] * h / 2), r);
        const c = dy(0, y.map((v, j) => v + b[j] * h / 2), r), d = dy(0, y.map((v, j) => v + c[j] * h), r);
        y = y.map((v, j) => v + (h / 6) * (a[j] + 2 * b[j] + 2 * c[j] + d[j]));
      }
      s = PK.step(sys, s, rateAt(sec + 0.5));
      if (sec % 60 === 59) {
        const cpRef = y[0] / p.vc * f, ceRef = y[3];
        const e1 = Math.abs(PK.cp(s) - cpRef) / Math.max(cpRef, 1e-9), e2 = Math.abs(PK.ce(s) - ceRef) / Math.max(ceRef, 1e-9);
        worst = Math.max(worst, e1, e2);
        assert(e1 < 1e-4 && e2 < 1e-4, `${m} t=${sec} cp ${PK.cp(s)} vs ${cpRef}, ce ${PK.ce(s)} vs ${ceRef}`);
      }
    }
    console.log('ok', m);
  }
}
console.log('erro relativo máximo', worst.toExponential(2));
