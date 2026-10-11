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
window.fetch = async (u) => { if (String(u).includes('ipify')) return { ok:true, status:200, json: async()=>({ ip:'203.0.113.77' }) }; return { ok:true, status:200, json: async()=>({}), text: async()=>'{}' }; };

try { window.eval(fs.readFileSync('vendor.min.js','utf8')); } catch(e){ errors.push('vendor: '+e.message); }
try { window.eval(fs.readFileSync('app.js','utf8')); } catch(e){ errors.push('app eval: '+e.stack.split('\n').slice(0,3).join(' | ')); }

const doc = window.document;
const T = () => window.__banTest;
function q(id){ return doc.getElementById(id); }
function fire(el, type){ el.dispatchEvent(new window.Event(type, { bubbles:true, cancelable:true })); }

setTimeout(() => {
  try {
    const screen = q('shadowBanScreen');
    console.log('screen exists:', !!screen, '| open initially:', screen.classList.contains('open'));

    T().updateSettings({ systemText: "Первая строка.\nВторая строка." });
    console.log('system line before ban:', JSON.stringify(q('systemTextLine').textContent));

    // 5 wrong settings codes -> auto ban + lock screen
    for (let i=0;i<5;i++){ q('settingsPasswordInput').value='000000'; fire(q('settingsPasswordForm'),'submit'); }
    console.log('after 5 fails -> banned:', T().isShadowBanned(), '| screen open:', screen.classList.contains('open'));
    console.log('journal inert:', q('journalApp').inert === true || q('journalApp').hasAttribute('inert'));
    const rows = [...q('shadowBanScreenInfo').querySelectorAll('.shadow-ban-info-row')].map(r=>r.textContent.replace(/\s+/g,' ').trim());
    console.log('info rows:'); rows.forEach(r=>console.log('  ', r));
    console.log('ban screen system text:', JSON.stringify(q('shadowBanScreenSystemText').textContent));

    // Escape must be swallowed while banned
    const esc = new window.KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true });
    doc.dispatchEvent(esc);
    console.log('escape prevented while banned:', esc.defaultPrevented, '| still open:', screen.classList.contains('open'));

    // lift -> normal UI restored
    T().liftShadowBan();
    console.log('after lift -> screen open:', screen.classList.contains('open'), '| gray line restored:', JSON.stringify(q('systemTextLine').textContent));

    // IP ban from registry hits this device via cached public IP
    T().setDeviceShadowBan('ip:203.0.113.77', true, 'Тестовый бан по IP', false);
    T().enforceIpBanOnLogin();
    console.log('IP ban enforced -> banned:', T().isShadowBanned(), '| screen open:', screen.classList.contains('open'));
    const vals = [...q('shadowBanScreenInfo').querySelectorAll('.shadow-ban-info-value')].map(v=>v.textContent);
    console.log('IP row:', vals[5], '| trigger mentions IP:', /IP-адресу/.test(vals[3]), '| issued row:', vals[6]);
    T().liftShadowBan();
    console.log('IP ban lifted -> open:', screen.classList.contains('open'));

    // manual device ban by a named technician
    T().applyShadowBan('причина теста', 'Иван Петров', 'manual-device');
    const vals2 = [...q('shadowBanScreenInfo').querySelectorAll('.shadow-ban-info-value')].map(v=>v.textContent);
    console.log('manual issuer shown:', vals2[2], '| reason:', vals2[4]);
    T().liftShadowBan();
    console.log('final -> banned:', T().isShadowBanned(), '| screen open:', screen.classList.contains('open'));
    console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
    process.exit(0);
  } catch(e){ console.log('TEST EXCEPTION:', e.stack.split('\n').slice(0,4).join(' | ')); process.exit(1); }
}, 300);
