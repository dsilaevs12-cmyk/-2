// Verifies the sync timing fix: push fires immediately after idle, echo pulls
// land only AFTER the GitHub CDN stale-cache grace window (~60 s).
const vm = require('vm');
const fs = require('fs');
const src = fs.readFileSync('app.js', 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

let now = 1_000_000;
const timers = new Map(); // id -> {at, fn}
let id = 1;
const sandbox = {
  Date: { now: () => now },
  setTimeout: (fn, ms) => { timers.set(id, { at: now + ms, fn }); return id++; },
  clearTimeout: (t) => timers.delete(t),
  syncRuntime: { generation: 1, lastLocalMutationAt: 0, lastPushedAt: 0, echoTimers: [], isSyncing: false, retryTimer: null, blocked: false, lastReceivedAt: 0, lastPullAt: 0, pushTimer: null },
  syncConfigured: () => true,
  syncAutomatic: () => true,
  syncOnline: () => true,
  fullSync: (reason) => { sandbox.__lastSyncReason = reason; },
  updateSyncUI: () => {},
  state: { revision: 1, lastSyncedRevision: 1 },
  PUSH_DEBOUNCE_MS: 2500,
  TABLET_PUSH_DEBOUNCE_MS: 4000,
  isWideTouchDevice: () => false,
  document: { hidden: false },
};
vm.createContext(sandbox);
vm.runInContext(extract('scheduleEchoPolls'), sandbox);
vm.runInContext(extract('clearEchoPolls'), sandbox);
vm.runInContext(extract('scheduleSync'), sandbox);

// Scenario 1: idle device makes a mark -> push must fire at delay 0.
sandbox.syncRuntime.lastLocalMutationAt = now;
sandbox.syncRuntime.lastPushedAt = now - 10 * 60 * 1000;
timers.clear();
vm.runInContext('scheduleSync()', sandbox);
const immediate = [...timers.values()].filter(t => t.at === now);
if (!immediate.length) throw new Error('FAIL: expected immediate push when idle > debounce window');
const echoDelays = sandbox.syncRuntime.echoTimers.map(tid => timers.get(tid).at - now);
if (!echoDelays.length) throw new Error('FAIL: echo polls not scheduled');
if (echoDelays.some(d => d <= 60000)) throw new Error('FAIL: echo pull within CDN grace window: ' + echoDelays.join(','));
console.log('OK scenario 1: push@0ms, echo delays =', echoDelays.join(', '), 'ms');

// Scenario 2: rapid consecutive marks -> push debounced relative to last push.
now += 1000;
sandbox.syncRuntime.lastLocalMutationAt = now;
sandbox.syncRuntime.lastPushedAt = now - 500;
timers.clear();
sandbox.syncRuntime.echoTimers = [];
vm.runInContext('scheduleSync()', sandbox);
const pushT = [...timers.values()].find(t => t.at > now && t.at - now <= 2500);
if (!pushT) throw new Error('FAIL: expected debounced push <=2.5s');
console.log('OK scenario 2: burst push delayed by', pushT.at - now, 'ms (<=2500)');

// Scenario 3: echo timer self-removes from list and runs fullSync("echo").
sandbox.syncRuntime.echoTimers = [];
vm.runInContext('scheduleEchoPolls()', sandbox);
const echoIds = [...sandbox.syncRuntime.echoTimers];
const firstId = echoIds.sort((a,b) => timers.get(a).at - timers.get(b).at)[0];
now = timers.get(firstId).at;
timers.get(firstId).fn();
if (sandbox.__lastSyncReason !== 'echo') throw new Error('FAIL: echo timer did not call fullSync("echo")');
if (sandbox.syncRuntime.echoTimers.includes(firstId)) throw new Error('FAIL: fired echo timer still in list');
if (sandbox.syncRuntime.echoTimers.length !== 2) throw new Error('FAIL: wrong remaining echo count ' + sandbox.syncRuntime.echoTimers.length);
console.log('OK scenario 3: echo fired fullSync("echo") and self-removed, remaining', sandbox.syncRuntime.echoTimers.length);

// Scenario 4: clearEchoPolls cancels all pending echoes.
vm.runInContext('clearEchoPolls()', sandbox);
if (sandbox.syncRuntime.echoTimers.length) throw new Error('FAIL: clearEchoPolls left timers');
const echoLeft = [...timers.values()].filter(t => t.at > now && t.at - now >= 75000);
console.log('OK scenario 4: clearEchoPolls cancelled pending echoes');

console.log('ALL ECHO TIMING TESTS PASSED');
