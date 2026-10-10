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
window.alert = m => { window.__lastAlert = String(m); console.log('ALERT:', String(m).slice(0,120)); };
window.confirm = () => true;
window.prompt = () => 'Тестовое учреждение';
window.scrollTo = ()=>{};
window.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} };
window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
window.fetch = async (u, o) => ({ ok:true, status:200, json: async()=>({}), text: async()=>'{}' });

try { window.eval(fs.readFileSync('vendor.min.js','utf8')); } catch(e){ errors.push('vendor: '+e.message); }
try { window.eval(fs.readFileSync('app.js','utf8')); } catch(e){ errors.push('app eval: '+e.stack.split('\n').slice(0,3).join(' | ')); }

// trigger init if DOMContentLoaded already handled by outside-only? readyState is 'complete'? check
setTimeout(() => {
  const d = window.document;
  console.log('readyState:', d.readyState);
  console.log('authGate visible:', d.getElementById('authGate') && !d.getElementById('authGate').hidden);
  console.log('errors:', errors.length); errors.slice(0,8).forEach(e=>console.log('ERR:', e.slice(0,400)));

  // Try to register an admin account via app internals if exposed
  const g = window;
  const api = ['registerAccount','createAccount','addInstitution','switchToInstitution','renderInstitutionList','removeInstitution','renameInstitution','loginAs'].filter(n => typeof g[n] === 'function');
  console.log('exposed fns:', api.join(', ') || '(none — functions are scoped)');
  process.exit(0);
}, 2000);
