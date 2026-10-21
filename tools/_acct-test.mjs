const samples = [
  '│ Account Name      │ Account ID                           │\n│ personal          │ 0123abcd0123abcd0123abcd0123abcd     │\n│ work-test         │ fedcba98fedcba98fedcba98fedcba98     │',
  '| Account Name      | Account ID                           |\n| personal          | 0123abcd0123abcd0123abcd0123abcd     |',
];
const parse = (text) => [...text.matchAll(/^\s*(.+?)\s+[│|]\s+([0-9a-f]{32})\s*[│|]?\s*$/gim)].map((m) => ({ name: m[1].trim(), id: m[2] }));
let bad = 0;
for (const s of samples) {
  const r = parse(s);
  console.log(JSON.stringify(r));
  if (r.length !== 2) bad++;
}
process.exit(bad ? 1 : 0);
