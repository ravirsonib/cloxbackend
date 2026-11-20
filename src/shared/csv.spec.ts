import { buildCsv, csvEscape } from './csv';

describe('csv helpers', () => {
  it('csvEscape quotes commas, quotes, and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('Acme, Inc')).toBe('"Acme, Inc"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('buildCsv joins header and rows with escaping', () => {
    const csv = buildCsv(['a', 'b'], [['1', 'two,parts'], ['x', 'y']]);
    expect(csv).toBe('a,b\n1,"two,parts"\nx,y\n');
  });
});
