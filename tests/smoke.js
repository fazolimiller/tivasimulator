const PK = require('../js/pk.js');
const TCI = require('../js/tci.js');
const pt = { age: 40, weight: 70, height: 170, sex: 'M' };
for (const [d, m] of [['propofol','Marsh'],['propofol','Schnider'],['propofol','Eleveld'],['remifentanil','Minto'],['remifentanil','Eleveld-Remifentanil'],['fentanyl','Shafer'],['alfentanil','Maitre'],['dexmedetomidine','Hannivoort'],['dexmedetomidine','Dyck'],['ketamine','Kamp'],['ketamine','Domino']]) {
  const sys = PK.createSystem(d, m, pt);
  console.log(m.padEnd(22), 'vc', sys.params.vc.toFixed(2), 'peak', sys.peakTime, 's', 'lam', sys.lambdas.map(x=>x.toExponential(2)).join(','));
}
function run(d, m, conc, events, settings) {
  const sys = PK.createSystem(d, m, pt);
  const t0 = Date.now();
  const r = TCI.simulate(sys, { concentration: conc, events }, settings);
  console.log(`\n== ${m} ${JSON.stringify(events)} (${Date.now()-t0} ms)`);
  for (const st of r.steps.slice(0, 25)) console.log(`  ${(st.t/60).toFixed(1)}min ${st.type} ${st.type==='bolus'? st.ml.toFixed(1)+' ml ('+st.dose.toFixed(1)+') dur '+st.duration+'s' : st.mlh.toFixed(1)+' ml/h'}`);
  for (const tm of [1, 2, 5, 10, 20, 30, 60, 90, 120, 180, 239]) console.log(`  t=${tm}min Cp=${r.cp[tm*60].toFixed(2)} Ce=${r.ce[tm*60].toFixed(2)} vol=${r.vol[tm*60].toFixed(1)}`);
  return r;
}
run('propofol','Marsh',10,[{t:0,type:'cpt',value:4}],{maxBolusRate:0});
run('propofol','Marsh',10,[{t:0,type:'cpt',value:4}],{maxBolusRate:1200});
run('propofol','Schnider',10,[{t:0,type:'cet',value:3},{t:1800,type:'cet',value:2},{t:3600,type:'cet',value:4}],{});
run('remifentanil','Minto',50,[{t:0,type:'cet',value:4}],{});
run('dexmedetomidine','Hannivoort',4,[{t:0,type:'cpt',value:0.5}],{});
run('propofol','Marsh',10,[{t:0,type:'rate',value:60},{t:600,type:'bolus',value:50},{t:1200,type:'stop'}],{});
