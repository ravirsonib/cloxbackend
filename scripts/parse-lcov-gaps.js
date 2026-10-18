const fs = require('fs');
const text = fs.readFileSync('coverage/lcov.info', 'utf8').replace(/\r\n/g, '\n');
const parts = text.split('end_of_record');

function parse(name) {
  const block = parts.find((p) => p.includes(name));
  if (!block) {
    console.log('MISS', name);
    return;
  }
  const brdas = [...block.matchAll(/^BRDA:(\d+),(\d+),(\d+),([-\d]+)/gm)];
  const miss = brdas.filter((m) => m[4] === '0' || m[4] === '-');
  const byLine = {};
  for (const m of miss) {
    (byLine[m[1]] = byLine[m[1]] || []).push(m[3]);
  }
  const lines = Object.keys(byLine)
    .map(Number)
    .sort((a, b) => a - b);
  const brf = block.match(/^BRF:(\d+)/m);
  const brh = block.match(/^BRH:(\d+)/m);
  console.log(
    `\n===${name}=== BRH/BRF ${brh?.[1]}/${brf?.[1]} missArms ${miss.length}`,
  );
  console.log(lines.map((l) => `${l}[${byLine[l].join(',')}]`).join(' '));
  const das = [...block.matchAll(/^DA:(\d+),(\d+)/gm)]
    .filter((m) => m[2] === '0')
    .map((m) => +m[1]);
  console.log('DA0', das.join(','));
}

[
  'payments.service.ts',
  'trips.service.ts',
  'auth.service.ts',
  'jobs.service.ts',
  'documents.service.ts',
  'admin.service.ts',
  'compliance.service.ts',
  'leads.service.ts',
  'stripe.service.ts',
  'types.ts',
].forEach(parse);
