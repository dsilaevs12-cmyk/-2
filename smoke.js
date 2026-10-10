const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: undefined, // don't fetch external; we'll inject manually
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
window.addEventListener('error', e => errors.push('window.onerror: ' + (e.error ? e.error.stack : e.message)));
// stub APIs jsdom lacks
window.matchMedia = window.matchMedia || (q => ({ matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
if (!window.crypto) Object.defineProperty(window, 'crypto', { value: {} });
if (!window.crypto.getRandomValues) window.crypto.getRandomValues = arr => { for(let i=0;i<arr.length;i++) arr[i]=Math.floor(Math.random()*256); return arr; };
if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16)});
if (!window.crypto.subtle) window.crypto.subtle = { importKey: async()=>({}), deriveBits: async()=>new ArrayBuffer(32), digest: async()=>new ArrayBuffer(32) };
window.URL.createObjectURL = window.URL.createObjectURL || (()=>'blob:x');
window.alert = m => { window.__lastAlert = String(m); };
window.confirm = () => true;
window.prompt = () => 'Тест';

// load vendor then app in order
try { const v = fs.readFileSync('vendor.min.js','utf8'); window.eval(v); } catch(e){ errors.push('vendor: '+e.message); }
try { const a = fs.readFileSync('app.js','utf8'); window.eval(a); } catch(e){ errors.push('app.js eval: '+e.stack.split('\n').slice(0,4).join(' | ')); }

// fire DOMContentLoaded/load
setTimeout(() => {
  try {
    const d = window.document;
    console.log('title:', d.title);
    console.log('body children:', d.body.children.length);
    // check main UI elements rendered
    const checks = ['journalTable','classSelect','monthLabel'];
    for (const c of checks) console.log(c, d.getElementById(c) ? 'FOUND' : 'missing');
    // any login screen?
    console.log('errors count:', errors.length);
    errors.slice(0,10).forEach(e=>console.log('ERR:', e.slice(0,300)));
  } catch(e){ console.log('test err', e.message); }
  process.exit(0);
}, 1500);
