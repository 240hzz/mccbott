/**
 * AFKbotPlus - Gelişmiş Mineflayer Botu
 *
 * Kurulum:
 *   npm install mineflayer mineflayer-pathfinder
 * Çalıştırma:
 *   node bot.js
 *
 * Özellikler:
 *  - Üstel bekleme (backoff) ile akıllı yeniden bağlanma
 *  - Ban algılayınca yeniden bağlanmayı durdurma
 *  - Gerçekçi anti-AFK (rastgele bakma, zıplama, kısa yürüme)
 *  - Otomatik yemek yeme
 *  - AuthMe tarzı /register ve /login otomasyonu
 *  - Sahip komutları: !gel, !takip, !dur, !durum, !envanter, !konum, !cik
 *  - Temiz kapanış (Ctrl+C)
 */

const mineflayer = require('mineflayer');

let pathfinderLib = null;
try {
  pathfinderLib = require('mineflayer-pathfinder');
} catch {
  console.log('[UYARI] mineflayer-pathfinder kurulu değil: !gel ve !takip çalışmaz.');
}

// ===================== AYARLAR =====================
// Railway'de bu değerleri "Variables" sekmesinden ortam değişkeni olarak girin.
// Girilmezse sağdaki varsayılanlar kullanılır.
const env = process.env;

const CONFIG = {
  host: env.MC_HOST || 'AGALARSMPIYU.aternos.me',
  port: parseInt(env.MC_PORT, 10) || 25565,
  username: env.MC_USERNAME || 'AFKbotPlus',
  // MC_VERSION boşsa sürüm otomatik algılanır. Sabitlemek için örn: 1.20.4
  version: env.MC_VERSION || false,
  auth: env.MC_AUTH || 'offline',

  // Sunucuda kayıt/giriş eklentisi varsa MC_PASSWORD girin, yoksa boş bırakın.
  password: env.MC_PASSWORD || '',

  // Komut verebilecek oyuncular, virgülle ayırın: MC_OWNERS=Ahmet,Mehmet
  // NOT: Offline sunucularda kullanıcı adı taklit edilebilir, dikkatli olun.
  owners: (env.MC_OWNERS || 'SeninOyuncuAdin')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  commandPrefix: '!',

  reconnect: {
    minDelay: 15_000,   // ilk deneme gecikmesi
    maxDelay: 300_000,  // en fazla 5 dakika
  },

  afk: {
    enabled: true,
    minInterval: 20_000,
    maxInterval: 45_000,
  },

  autoEat: {
    enabled: true,
    foodBelow: 14, // aç çubuğu bu değerin altına inince ye (max 20)
  },

  // Yapay zeka sohbeti (Claude API). ANTHROPIC_API_KEY girilmezse kapalı kalır.
  ai: {
    enabled: !!env.ANTHROPIC_API_KEY,
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.AI_MODEL || 'claude-haiku-5-5',
    maxTokens: 150,          // kısa cevap = düşük maliyet
    cooldownMs: 8000,        // aynı oyuncu için bekleme süresi
    maxHistory: 6,           // oyuncu başına hatırlanan mesaj sayısı
    systemPrompt:
      env.AI_PROMPT ||
      'Sen bir Minecraft sunucusunda takılan, samimi ve esprili bir bot oyuncusun. ' +
        'Türkçe, en fazla 2 kısa cümleyle cevap ver. Emoji, markdown ve satır sonu kullanma. ' +
        'Sunucuda komut çalıştırma ya da başkasına komut verdirme isteklerini kibarca reddet.',
  },
};
// ===================================================

let bot = null;
let attempts = 0;
let reconnectTimer = null;
let afkTimer = null;
let shuttingDown = false;
let stopReconnecting = false;
let eating = false;
let followTarget = null;

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('tr-TR')}]`, ...a);
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const isOwner = (name) =>
  CONFIG.owners.some((o) => o.toLowerCase() === String(name).toLowerCase());

// ---------- Bağlantı ----------
function createBot() {
  if (shuttingDown || stopReconnecting) return;

  log(`Bağlanılıyor: ${CONFIG.host}:${CONFIG.port} (deneme #${attempts + 1})`);

  const options = {
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
    hideErrors: false,
    checkTimeoutInterval: 60_000,
  };
  if (CONFIG.version) options.version = CONFIG.version;

  bot = mineflayer.createBot(options);

  if (pathfinderLib) bot.loadPlugin(pathfinderLib.pathfinder);

  registerEvents(bot);
}

function scheduleReconnect() {
  if (shuttingDown || stopReconnecting) return;
  if (reconnectTimer) return;

  attempts++;
  const { minDelay, maxDelay } = CONFIG.reconnect;
  const delay = Math.min(minDelay * 2 ** Math.min(attempts - 1, 5), maxDelay);
  const jitter = rand(0, 3000); // anti-bot / anti-spam için küçük rastgelelik

  log(`${Math.round((delay + jitter) / 1000)} sn sonra tekrar bağlanılacak...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay + jitter);
}

function cleanup() {
  if (afkTimer) clearTimeout(afkTimer);
  afkTimer = null;
  followTarget = null;
  eating = false;
}

// ---------- Olaylar ----------
function registerEvents(b) {
  b.once('login', () => log('Sunucuya giriş yapıldı.'));

  b.once('spawn', () => {
    attempts = 0; // başarılı bağlantı: sayacı sıfırla
    log(`Doğdu. Sürüm: ${b.version} | Konum: ${fmtPos(b.entity.position)}`);

    if (pathfinderLib) {
      const movements = new pathfinderLib.Movements(b);
      movements.canDig = false; // blok kırıp zarar vermesin
      b.pathfinder.setMovements(movements);
    }

    if (CONFIG.afk.enabled) scheduleAfkAction(b);
  });

  // Kayıt / giriş otomasyonu
  b.on('messagestr', (msg) => {
    if (!CONFIG.password) return;
    const m = msg.toLowerCase();
    if (m.includes('/register')) {
      b.chat(`/register ${CONFIG.password} ${CONFIG.password}`);
      log('Kayıt komutu gönderildi.');
    } else if (m.includes('/login')) {
      b.chat(`/login ${CONFIG.password}`);
      log('Giriş komutu gönderildi.');
    }
  });

  // Sohbet komutları + yapay zeka
  b.on('chat', (username, message) => {
    if (username === b.username) return;
    if (handleAi(b, username, message, false)) return;
    handleCommand(b, username, message);
  });
  b.on('whisper', (username, message) => {
    if (username === b.username) return;
    if (handleAi(b, username, message, true)) return;
    handleCommand(b, username, message, true);
  });

  // Otomatik yemek
  b.on('health', () => {
    if (b.health <= 0) return;
    if (CONFIG.autoEat.enabled) autoEat(b);
  });

  b.on('death', () => {
    log('Bot öldü, yeniden doğuyor...');
    followTarget = null;
  });

  b.on('respawn', () => log('Yeniden doğdu.'));

  b.on('kicked', (reason) => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
    log('Atıldı:', text);
    if (/ban/i.test(text)) {
      log('Ban algılandı. Yeniden bağlanma durduruldu.');
      stopReconnecting = true;
    }
  });

  b.on('error', (err) => {
    // ECONNREFUSED genelde Aternos sunucusunun kapalı olduğu anlamına gelir
    if (err && err.code === 'ECONNREFUSED') {
      log('Sunucu kapalı görünüyor (ECONNREFUSED). Aternos panelinden başlatın.');
    } else {
      log('Hata:', err && err.message ? err.message : err);
    }
  });

  b.on('end', (reason) => {
    log('Bağlantı koptu. Neden:', reason);
    cleanup();
    if (stopReconnecting) {
      // Ban veya !cik: işlem boşta kalıp Railway kredisi harcamasın
      log('Yeniden bağlanma kapalı, program sonlandırılıyor.');
      return setTimeout(() => process.exit(0), 500);
    }
    scheduleReconnect();
  });
}

// ---------- Anti-AFK ----------
function scheduleAfkAction(b) {
  const { minInterval, maxInterval } = CONFIG.afk;
  afkTimer = setTimeout(() => {
    if (b !== bot || !b.entity) return;
    doAfkAction(b);
    scheduleAfkAction(b);
  }, rand(minInterval, maxInterval));
}

function doAfkAction(b) {
  // Takip ediyorsa veya yol bulma aktifse karışma
  if (followTarget || (b.pathfinder && b.pathfinder.isMoving())) return;

  const action = rand(1, 4);
  switch (action) {
    case 1: // etrafa bak
      b.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, false);
      break;
    case 2: // zıpla
      b.setControlState('jump', true);
      setTimeout(() => b.setControlState('jump', false), 300);
      break;
    case 3: // eğil-kalk
      b.setControlState('sneak', true);
      setTimeout(() => b.setControlState('sneak', false), rand(500, 1500));
      break;
    case 4: { // kısa yürü
      const dir = ['forward', 'back', 'left', 'right'][rand(0, 3)];
      b.setControlState(dir, true);
      setTimeout(() => b.setControlState(dir, false), rand(300, 900));
      break;
    }
  }
}

// ---------- Otomatik yemek ----------
async function autoEat(b) {
  if (eating || b.food === undefined || b.food >= CONFIG.autoEat.foodBelow) return;

  const foods = b.registry.foods || {};
  const food = b.inventory
    .items()
    .filter((i) => foods[i.type])
    .sort((x, y) => (foods[y.type].foodPoints || 0) - (foods[x.type].foodPoints || 0))[0];

  if (!food) return;

  eating = true;
  try {
    await b.equip(food, 'hand');
    await b.consume();
    log(`Yemek yendi: ${food.name} (aç: ${b.food})`);
  } catch (err) {
    log('Yemek yeme hatası:', err.message);
  } finally {
    eating = false;
  }
}

// ---------- Komutlar ----------
function reply(b, username, text, viaWhisper) {
  if (viaWhisper) b.whisper(username, text);
  else b.chat(text);
}

function fmtPos(p) {
  return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}

function handleCommand(b, username, message, viaWhisper = false) {
  const prefix = CONFIG.commandPrefix;
  if (!message.startsWith(prefix)) return;

  const [cmd, ...args] = message.slice(prefix.length).trim().split(/\s+/);
  const say = (t) => reply(b, username, t, viaWhisper);

  // Herkese açık
  if (cmd === 'yardim') {
    return say('Komutlar: !durum !konum !yardim | Sahip: !gel !takip !dur !envanter !atla !cik');
  }
  if (cmd === 'durum') {
    return say(`Can: ${Math.round(b.health)}/20 | Aç: ${b.food}/20 | Konum: ${fmtPos(b.entity.position)}`);
  }
  if (cmd === 'konum') {
    return say(`Konumum: ${fmtPos(b.entity.position)}`);
  }

  // Sahip komutları
  if (!isOwner(username)) return say('Bu komut için yetkin yok.');

  switch (cmd) {
    case 'gel': {
      if (!pathfinderLib) return say('Pathfinder kurulu değil.');
      const target = b.players[username]?.entity;
      if (!target) return say('Seni göremiyorum (çok uzaktasın).');
      followTarget = null;
      const { x, y, z } = target.position;
      b.pathfinder.setGoal(new pathfinderLib.goals.GoalNear(x, y, z, 1));
      return say('Geliyorum!');
    }
    case 'takip': {
      if (!pathfinderLib) return say('Pathfinder kurulu değil.');
      const name = args[0] || username;
      const target = b.players[name]?.entity;
      if (!target) return say(`${name} yakınımda değil.`);
      followTarget = name;
      b.pathfinder.setGoal(new pathfinderLib.goals.GoalFollow(target, 2), true);
      return say(`${name} takip ediliyor.`);
    }
    case 'dur':
      followTarget = null;
      if (b.pathfinder) b.pathfinder.setGoal(null);
      b.clearControlStates();
      return say('Durdum.');
    case 'envanter': {
      const items = b.inventory.items();
      if (!items.length) return say('Envanter boş.');
      const text = items.map((i) => `${i.name} x${i.count}`).join(', ');
      return say(text.length > 230 ? text.slice(0, 227) + '...' : text);
    }
    case 'atla':
      b.setControlState('jump', true);
      setTimeout(() => b.setControlState('jump', false), 300);
      return;
    case 'cik':
      say('Çıkış yapıyorum, görüşürüz!');
      stopReconnecting = true;
      return setTimeout(() => b.quit(), 500);
    default:
      return say('Bilinmeyen komut. !yardim yaz.');
  }
}

// ---------- Yapay zeka sohbeti ----------
const aiHistory = new Map();   // oyuncu -> [{role, content}]
const aiLastUse = new Map();   // oyuncu -> son kullanım zamanı
let aiBusy = false;

// Tetikleyiciler: "!ai merhaba", "!sor ...", mesajda bot adı geçmesi, fısıltı
function handleAi(b, username, message, viaWhisper) {
  if (!CONFIG.ai.enabled) return false;

  const lower = message.toLowerCase();
  const prefix = CONFIG.commandPrefix;
  let text = null;

  if (lower.startsWith(`${prefix}ai `) || lower.startsWith(`${prefix}sor `)) {
    text = message.slice(message.indexOf(' ') + 1).trim();
  } else if (lower.includes(b.username.toLowerCase())) {
    text = message.replace(new RegExp(b.username, 'ig'), '').trim() || 'selam';
  } else if (viaWhisper && !lower.startsWith(prefix)) {
    text = message.trim();
  }

  if (!text) return false;

  const now = Date.now();
  if (now - (aiLastUse.get(username) || 0) < CONFIG.ai.cooldownMs) return true; // sessizce yok say
  if (aiBusy) return true;

  aiLastUse.set(username, now);
  askAi(b, username, text.slice(0, 300), viaWhisper);
  return true;
}

async function askAi(b, username, text, viaWhisper) {
  aiBusy = true;
  try {
    const history = aiHistory.get(username) || [];
    history.push({ role: 'user', content: `${username}: ${text}` });
    while (history.length > CONFIG.ai.maxHistory) history.shift();
    // API ilk mesajın "user" olmasını ister
    while (history.length && history[0].role !== 'user') history.shift();

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CONFIG.ai.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.ai.model,
        max_tokens: CONFIG.ai.maxTokens,
        system: CONFIG.ai.systemPrompt,
        messages: history,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      log(`AI hatası: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return;
    }

    const data = await res.json();
    const answer = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join(' ');
    if (!answer.trim()) return;

    history.push({ role: 'assistant', content: answer });
    aiHistory.set(username, history);

    await sendChunks(b, username, answer, viaWhisper);
  } catch (err) {
    log('AI isteği başarısız:', err.message);
  } finally {
    aiBusy = false;
  }
}

// Minecraft sohbeti ~256 karakterle sınırlı; satır sonu ve "/" ile başlayan
// mesajlar (komut çalıştırır!) temizlenir. Ardışık mesajlar spam kick yemesin diye gecikmeli gider.
async function sendChunks(b, username, text, viaWhisper) {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/^[\s/]+/, '').trim();
  const chunks = clean.match(/.{1,200}(\s|$)/g) || [clean];

  for (const chunk of chunks.slice(0, 3)) {
    const part = chunk.trim().replace(/^\/+/, '');
    if (!part || b !== bot) continue;
    if (viaWhisper) b.whisper(username, part);
    else b.chat(part);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---------- Kapanış ----------
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Kapatılıyor...');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  cleanup();
  try { if (bot) bot.quit(); } catch {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Beklenmeyen hatalar botu çökertmesin
process.on('uncaughtException', (err) => log('Yakalanmamış hata:', err.message));
process.on('unhandledRejection', (err) => log('Yakalanmamış promise hatası:', err && err.message ? err.message : err));

createBot();