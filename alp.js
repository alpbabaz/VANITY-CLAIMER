import http2 from 'http2';
import { readFileSync, watch } from 'fs';
import WebSocket from 'ws';

const TOKEN = " SELF BOT TOKEN ";
const GUILD_ID = "1520364027010617495";
const GREEN = '\x1b[32m', RESET = '\x1b[0m';
const ORANGE = '\x1b[38;5;208m', BLUE = '\x1b[38;5;39m';
const SP = 'eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzMi4wLjAuMCBTYWZhcmkvNTM3LjM2Iiwib3NfdmVyc2lvbiI6IjEwIn0=';

const B_GU = Buffer.from('"t":"GUILD_UPDATE"');
const B_VK = Buffer.from('"vanity_url_code":');
const B_VK_NULL = Buffer.from('"vanity_url_code":null');
const B_SEQ = Buffer.from('"s":');

const log = (m) => console.log(`${GREEN}${m}${RESET}`);
let mfa = "", h2 = null, warmer = null;
const guilds = new Map();
let targets = [];

const loadMfa = () => { 
  try { 
    const n = readFileSync("mfa.txt", "utf8").trim(); 
    if (n !== mfa) { mfa = n; rebuild(); }
  } catch {} 
};

const checkSuccess = (res, status) => {
  try {
    const p = JSON.parse(res);
    if (p.retry_after) log(`[ ! ] --> 'Rate limited: ${p.retry_after}s'`);
    else if (p.code && !p.message) log(`[ + ] --> ${res}`);
    else if (p.message && (p.code === 50020 || p.code === 50024 || /invalid|taken|ge?ersiz|kullanilmis|already|unavailable/i.test(p.message))) log(`[ - ] --> ${res}`);
    else log(`[ ! ] --> '${p.message || p.error || 'Unknown error'}'`);
  } catch {
    log(`[ ! ] --> Http Status: ${status} | Body: ${res}`);
  }
};

const fireRequest = (t) => {
  let sentCount = 0;
  for (let i = 0; i < 2; i++) {
    try {
      const req = h2.request(t.headers);
      req.write(t.bodyBuf);
      req.end();
      sentCount++;
      req.on('response', (headers) => {
        const status = headers[':status'];
        let d = '';
        req.setEncoding('utf8');
        req.on('data', c => d += c).on('end', () => {
          if (d) checkSuccess(d.trim(), status);
          if (status === 200 && t._fireTime && !t._firstResponseLogged) {
            t._firstResponseLogged = true;
            const elapsed = performance.now() - t._fireTime;
            log('[ ms ] HTTP 200 --> ' + elapsed.toFixed(2) + ' ms');
          }
        });
      });
      req.on('error', () => {});
    } catch {}
  }
  return sentCount;
};

const rebuild = () => {
  const arr = [];
  for (const [id, vanity] of guilds.entries()) {
    arr.push({
      guildId: id,
      idBuf: Buffer.from(`"id":"${id}"`),
      vanBuf: Buffer.from(`"vanity_url_code":"${vanity}"`),
      bodyBuf: Buffer.from(`{"code":"${vanity}"}`),
      headers: {
        ':method': 'PATCH', ':authority': 'canary.discord.com', ':path': `/api/v9/guilds/${GUILD_ID}/vanity-url`,
        'authorization': TOKEN, 'content-type': 'application/json',
        'x-super-properties': SP, 'content-length': Buffer.byteLength(`{"code":"${vanity}"}`),
        ...(mfa ? { 'x-discord-mfa-authorization': mfa } : {})
      }
    });
  }
  targets = arr;
};

const initH2 = () => {
  if (h2 && !h2.destroyed) h2.destroy();
  h2 = http2.connect('https://162.159.135.232', {
    servername: 'canary.discord.com', rejectUnauthorized: false,
    settings: { enablePush: false, initialWindowSize: 2147483647, maxConcurrentStreams: 4294967295 }
  });
  h2.on('error', () => {});
  h2.once('connect', () => {
    // Handshake ve HPACK'in tamamlanmasi icin bir kere isitici istek (OPTIONS) at
    try {
      const dummy = h2.request({ ':method': 'OPTIONS', ':authority': 'canary.discord.com', ':path': '/' });
      dummy.on('response', () => {}).on('end', () => {});
      dummy.end();
    } catch {}
  });
  h2.on('close', () => setTimeout(initH2, 500));
};

setInterval(() => { if (h2 && !h2.destroyed) h2.ping(Buffer.alloc(8), () => {}); }, 15000);

const initWs = () => {
  const ws = new WebSocket('wss://gateway.discord.gg/?v=9', { perMessageDeflate: false, handshakeTimeout: 5000, skipUTF8Validation: true });
  let hb, seq = null;
  ws.on('open', () => log('websocket baglandi'));
  ws.on('close', () => { clearInterval(hb); setTimeout(initWs, 1000); });
  ws.on('error', () => {});
  ws.on('message', (rawData) => {
    const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
    // HOT PATH - ZERO JSON PARSING OVERHEAD
    if (data.indexOf(B_GU) !== -1) {
      // Seq guncelle
      const seqIdx = data.indexOf(B_SEQ);
      if (seqIdx !== -1) {
        let ns = seqIdx + 4, ne = ns;
        while (ne < data.length && data[ne] >= 0x30 && data[ne] <= 0x39) ne++;
        if (ne > ns) seq = parseInt(data.toString('utf8', ns, ne), 10);
      }

      let fired = false, ft = null;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (data.indexOf(t.idBuf) !== -1) {
          if (data.indexOf(B_VK) !== -1 && data.indexOf(t.vanBuf) === -1) {
            // Aninda atesle
            t._fireTime = performance.now();
            t._firstResponseLogged = false;
            let sentCount = fireRequest(t);
            log(`[ * ] PATCH (${sentCount} stream) -> ${t.bodyBuf.toString()}`);
            fired = true;
            ft = t;
          }
          break;
        }
      }
      if (fired) {
        // JSON.parse yok - buffer'dan direkt cek
        setImmediate(() => {
          try {
            const id = ft.guildId, o = guilds.get(id);
            let n = null;
            if (data.indexOf(B_VK_NULL) === -1) {
              const vi = data.indexOf(B_VK);
              if (vi !== -1) {
                const qs = vi + B_VK.length;
                if (data[qs] === 0x22) {
                  const qe = data.indexOf(0x22, qs + 1);
                  if (qe !== -1) n = data.toString('utf8', qs + 1, qe);
                }
              }
            }
            if (o && o !== n) console.log(ORANGE + id + RESET + ' : ' + BLUE + o + ' -> ' + (n || 'NULL') + RESET);
            if (n) { if (!o) console.log(ORANGE + id + RESET + ' : ' + BLUE + n + RESET); guilds.set(id, n); rebuild(); }
            else if (o) { guilds.delete(id); rebuild(); }
          } catch {}
        });
        return;
      }
    }

    try {
      const p = JSON.parse(data.toString('utf8'));
      const { d, op, t, s } = p;
      if (s) seq = s;
      if (op === 10) {
        ws.send(`{"op":2,"d":{"token":"${TOKEN}","intents":1,"properties":{"os":"linux","browser":"chrome","device":"all eyes on me"}}}`);
        hb = setInterval(() => ws.readyState === 1 && ws.send(`{"op":1,"d":${seq !== null ? seq : 'null'}}`), d.heartbeat_interval);
      } else if (op === 7) ws.close();
      else if (op === 1) ws.send(`{"op":1,"d":${seq !== null ? seq : 'null'}}`);
      else if (t === 'READY' && d?.guilds) {
        log('websocket degisikliklere hazir');
        const v = {};
        for (let i = 0; i < d.guilds.length; i++) {
          const g = d.guilds[i];
          if (g.vanity_url_code) { guilds.set(g.id, g.vanity_url_code); v[g.id] = g.vanity_url_code; }
        }
        if (Object.keys(v).length) { for (const [k,val] of Object.entries(v)) console.log(ORANGE + k + RESET + ' : ' + BLUE + val + RESET); rebuild(); }
      } else if (t === 'GUILD_UPDATE' && d) {
        const id = d.guild_id || d.id, n = d.vanity_url_code, o = guilds.get(id);
        if (o && o !== n) {
          console.log(ORANGE + id + RESET + ' : ' + BLUE + o + ' -> ' + (n || 'NULL') + RESET);
          // Eger hot path kacirdiysa yavas yoldan istek atalim
          const target = targets.find(x => x.guildId === id);
          if (target) {
            target._fireTime = performance.now();
            target._firstResponseLogged = false;
            let sentCount = fireRequest(target);
            log(`[ * ] SLOW PATCH (${sentCount} stream) -> ${target.bodyBuf.toString()}`);
          }
        }
        if (n) { if (!o) console.log(ORANGE + id + RESET + ' : ' + BLUE + n + RESET); guilds.set(id, n); rebuild(); }
        else if (o) { guilds.delete(id); rebuild(); }
      }
    } catch {}
  });
};

log('selam kizlar y?regim sizlar');
loadMfa();
watch("mfa.txt", (e) => e === 'change' && loadMfa());
initH2();
log('http2 islemcisi baslatildi');
setTimeout(initWs, 100);

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});