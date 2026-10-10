const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const errors = [];
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
window.addEventListener('error', e => errors.push('onerror: ' + (e.error ? e.error.stack : e.message)));
window.matchMedia = q => ({ matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
Object.defineProperty(window, 'crypto', { value: { getRandomValues: a=>{for(let i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256);return a;}, randomUUID: ()=>'id-'+Math.random().toString(16).slice(2), subtle:{ importKey: async()=>({}), deriveBits: async()=>new ArrayBuffer(32), digest: async()=>new ArrayBuffer(32) } } });
window.URL.createObjectURL = ()=>'blob:x'; window.URL.revokeObjectURL = ()=>{};
window.alert = m => console.log('ALERT:', String(m).slice(0,120));
window.confirm = () => true;
window.prompt = () => 'Тест';
window.scrollTo = ()=>{};
window.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} };
window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };

// Pre-seed localStorage BEFORE the app script runs: cloud configured + no local accounts yet
const REMOTE_ACCOUNTS = [
  { id: 'acct-aaa', fullName: 'Иван Иванов', role: 'teacher', passHash: 'x', salt: 'y', deleted: false, updatedAt: Date.now() - 1000 },
  { id: 'acct-bbb', fullName: 'Мария Петрова', role: 'student', passHash: 'z', salt: 'w', deleted: false, updatedAt: Date.now() - 2000 }
];
window.localStorage.setItem('attendance_sync_config', JSON.stringify({ enabled: true, gistId: 'abc123def456', lastSyncStatus: 'off' }));
window.localStorage.setItem('attendance_sync_token', JSON.stringify({ token: 'ghp_testtoken' }));

let fetchCount = 0;
window.fetch = async (u, o) => {
  fetchCount++;
  const gistJson = { files: { 'attendance.json': { content: JSON.stringify({ schema: 1, revision: 5, students: [], attendance: {}, classes: ["class-main"], lessonMarks: {}, accounts: REMOTE_ACCOUNTS }) } } };
  return { ok: true, status: 200, headers: { get: h => h==='etag' ? '"e1"' : null }, json: async () => gistJson, text: async () => JSON.stringify(gistJson) };
};

try { window.eval(fs.readFileSync('vendor.min.js','utf8')); } catch(e){ errors.push('vendor: '+e.message); }
try { window.eval(fs.readFileSync('app.js','utf8')); } catch(e){ errors.push('app eval: '+e.stack.split('\n').slice(0,3).join(' | ')); }

setTimeout(async () => {
  const d = window.document;
  d.getElementById('authTabLogin').click();
  const pullBtn = d.getElementById('authSyncPullButton');
  const statusEl = d.getElementById('authSyncStatus');
  pullBtn.click();
  await new Promise(r => setTimeout(r, 800));
  console.log('fetch calls:', fetchCount);
  console.log('status after pull:', JSON.stringify(statusEl.textContent.slice(0,110)), '| class:', statusEl.className);
  const stored = JSON.parse(window.localStorage.getItem('attendance_auth_accounts') || '[]');
  console.log('local accounts after pull:', stored.map(a => a.fullName).join(', ') || '(none)');
  // Now check button
  d.getElementById('authSyncCheckButton').click();
  await new Promise(r => setTimeout(r, 800));
  console.log('status after check:', JSON.stringify(statusEl.textContent.slice(0,140)), '| class:', statusEl.className);
  console.log('errors:', errors.length); errors.slice(0,5).forEach(e=>console.log('ERR:', e.slice(0,300)));
  process.exit(errors.length ? 1 : 0);
}, 1500);
