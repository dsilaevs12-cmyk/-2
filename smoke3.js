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
window.fetch = async (u, o) => ({ ok:true, status:200, json: async()=>({ files: {} }), text: async()=>'{}' });

try { window.eval(fs.readFileSync('vendor.min.js','utf8')); } catch(e){ errors.push('vendor: '+e.message); }
try { window.eval(fs.readFileSync('app.js','utf8')); } catch(e){ errors.push('app eval: '+e.stack.split('\n').slice(0,3).join(' | ')); }

setTimeout(() => {
  const d = window.document;
  // login form should contain the sync box
  const box = d.getElementById('authSyncBox');
  const pullBtn = d.getElementById('authSyncPullButton');
  const checkBtn = d.getElementById('authSyncCheckButton');
  const statusEl = d.getElementById('authSyncStatus');
  console.log('sync box exists:', !!box, '| pull:', !!pullBtn, '| check:', !!checkBtn, '| status:', !!statusEl);
  // switch to login tab
  d.getElementById('authTabLogin').click();
  console.log('login form visible after tab click:', !d.getElementById('authLoginForm').hidden);
  // press "check" without configured cloud -> expect warn message
  checkBtn.click();
  setTimeout(() => {
    console.log('status after check (unconfigured):', JSON.stringify(statusEl.textContent.slice(0,80)), '| class:', statusEl.className);
    // configure sync via localStorage then re-check path: simulate by setting globals if accessible is not possible (scoped). Just verify pull button also responds.
    pullBtn.click();
    setTimeout(() => {
      console.log('status after pull (unconfigured):', JSON.stringify(statusEl.textContent.slice(0,80)), '| class:', statusEl.className);
      console.log('errors:', errors.length); errors.slice(0,5).forEach(e=>console.log('ERR:', e.slice(0,300)));
      process.exit(errors.length ? 1 : 0);
    }, 300);
  }, 300);
}, 1500);
