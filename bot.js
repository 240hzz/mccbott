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

const PRESETS = {
  anthropic:  { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b:free' },
  openai:     { baseUrl: 'https://api.openai.com/v1', model: '' },
};
const PROVIDER = (env.AI_PROVIDER || 'groq').toLowerCase();
const PRESET = PRESETS[PROVIDER] || PRESETS.openai;
const BASE_URL = (env.AI_BASE_URL || PRESET.baseUrl).replace(/\/+$/, '');
const DEFAULT_MODEL = PRESET.model;
const API_KEY = env.AI_API_KEY || (PROVIDER === 'anthropic' ? env.ANTHROPIC_API_KEY : '') || '';

const CONFIG = {
  host: env.MC_HOST || 'AGALARSMPIYU.aternos.me',
  port: parseInt(env.MC_PORT, 10) || 34162,
  username: env.MC_USERNAME || 'AIbotPlus',
  // MC_VERSION boşsa sürüm otomatik algılanır. Sabitlemek için örn: 1.20.4
  version: env.MC_VERSION || '1.21.1',
  auth: env.MC_AUTH || 'offline',

  // Sunucuda kayıt/giriş eklentisi varsa MC_PASSWORD girin, yoksa boş bırakın.
  password: env.MC_PASSWORD || '',

  // Komut verebilecek oyuncular, virgülle ayırın: MC_OWNERS=Ahmet,Mehmet
  // NOT: Offline sunucularda kullanıcı adı taklit edilebilir, dikkatli olun.
  owners: (env.MC_OWNERS || 'xSwaq')
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

  // Yapay zeka. Sağlayıcı: AI_PROVIDER = anthropic | groq | gemini | openrouter | openai (kendi AI_BASE_URL'iniz)
  // Anahtar: AI_API_KEY (anthropic için ANTHROPIC_API_KEY de olur). Anahtar yoksa yapay zeka kapalı kalır.
  ai: {
    provider: PROVIDER,
    baseUrl: BASE_URL,
    enabled: !!API_KEY,
    // true ise sahip dışındakilere yapay zeka hiç cevap vermez (varsayılan: sadece sohbet eder)
    ownerOnly: env.AI_OWNER_ONLY === 'true',
    apiKey: API_KEY,
    model: env.AI_MODEL || DEFAULT_MODEL,
    maxTokens: 150,          // kısa cevap = düşük maliyet
    cooldownMs: 8000,        // aynı oyuncu için bekleme süresi
    maxHistory: 6,           // oyuncu başına hatırlanan mesaj sayısı
    systemPrompt:
      env.AI_PROMPT ||
      'Sen "AIbotPlus" adlı, bu Minecraft sunucusunda yaşayan esprili bir köle bot karaktersin. ' +
        'Kendini köle olarak tanıtırsın ve sahibin xSwaq\'a "efendim" dersin; ' +
        'diğer oyunculara kibar ve saygılı davranırsın. Bu sadece eğlenceli bir rol, hakaret etme. ' +
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
let introduced = false;

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
  if (currentTask) currentTask.cancelled = true;
  currentTask = null;
  eating = false;
}

// ---------- Olaylar ----------
function registerEvents(b) {
  b.once('login', () => log('Sunucuya giriş yapıldı.'));

  b.once('spawn', () => {
    attempts = 0; // başarılı bağlantı: sayacı sıfırla
    log(`Doğdu. Sürüm: ${b.version} | Konum: ${fmtPos(b.entity.position)}`);
    log(`Yapay zeka: ${CONFIG.ai.enabled ? 'AÇIK (' + CONFIG.ai.provider + ' / ' + CONFIG.ai.model + ')' : 'KAPALI (AI_API_KEY yok)'} | Sahipler: ${CONFIG.owners.join(', ')}`);

    if (pathfinderLib) {
      moves = new pathfinderLib.Movements(b);
      moves.canDig = false; // yol bulurken blok kırıp zarar vermesin
      b.pathfinder.setMovements(moves);
    }

    if (CONFIG.afk.enabled) scheduleAfkAction(b);

    if (!introduced) {
      introduced = true;
      setTimeout(() => {
        if (b === bot) b.chat(`Selamlar, ben ${b.username}, efendim ${CONFIG.owners[0]}'ın kölesiyim. Emriniz?`);
      }, 4000);
    }
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
    stopAll(b);
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
  if (followTarget || currentTask || (b.pathfinder && b.pathfinder.isMoving())) return;

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

  const [rawCmd, ...args] = message.slice(prefix.length).trim().split(/\s+/);
  const cmd = String(rawCmd || '')
    .replace(/İ/g, 'i').toLowerCase()
    .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ş/g, 's')
    .replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ü/g, 'u');
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
      stopAll(b);
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

// ---------- Yapay zeka: sohbet + emir verme (sadece sahip) ----------
const aiHistory = new Map();   // oyuncu -> [{role, content}] (sadece düz metin)
const aiLastUse = new Map();   // oyuncu -> son kullanım zamanı
let aiBusy = false;
let moves = null;              // pathfinder Movements
let currentTask = null;        // { name, cancelled }
let home = null;               // { x, y, z } (bellekte tutulur, yeniden başlayınca sıfırlanır)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER_PROMPT =
  `Sen "${CONFIG.username}" adlı, bir Minecraft sunucusunda yaşayan esprili ve zeki bir köle bot karaktersin. ` +
  'Kendini köle olarak tanıtırsın ve sahibine "efendim" dersin (eğlenceli bir rol, hakaret yok). ' +
  'Konuştuğun kişi botun SAHİBİ: oyun içi emirlerini araçları çağırarak yerine getirirsin. ' +
  'Minecraft içi ya da dışı her türlü soruya Türkçe cevap verebilirsin. ' +
  'Sohbet satır sonu, markdown ve emoji kabul etmez; en fazla 3-4 kısa cümleyle cevap ver. ' +
  'Emir için gerekirse önce scan_surroundings, find_blocks veya find_container ile etrafı incele, ' +
  'sonra araçları sırayla çağır. Arka planda çalışan görevlerden (kazma, saldırı, eşya toplama, devriye) ' +
  'sonra devam etmek istersen wait_task kullan. ' +
  'Bir eşyayı sahibe getirmek için: find_container, take_from_container, bring_items_to_player. ' +
  'Blok ve eşya adları İngilizce Minecraft kimlikleridir (iron_ingot, oak_log, diamond_ore...). ' +
  'Yapamadığın ya da başaramadığın şeyi açıkça söyle, uydurma. ' +
  'Asla "/" ile başlayan sunucu komutu yazma. İşin bitince ne yaptığını tek cümleyle söyle.';

const OTHERS_SUFFIX =
  ' Bu kişi botun sahibi değil: oyun içi emir veremez. Emir isterse sahibinden başkasını dinlemediğini söyle.';

const TOOLS = [
  { name: 'say', description: 'Sohbete kısa bir mesaj yazar.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'get_status', description: 'Botun canı, açlığı, konumu, envanteri, evi ve aktif görevi.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'scan_surroundings',
    description: 'Etrafı tarar: saat/hava, yakındaki oyuncular, düşman moblar, yerdeki eşyalar ve çevredeki önemli bloklar (cevher, sandık, fırın, yatak, vb).',
    input_schema: { type: 'object', properties: {} } },
  { name: 'find_blocks',
    description: 'Belirli bir bloğun en yakın konumlarını bulur (en fazla 5).',
    input_schema: { type: 'object',
      properties: { block_name: { type: 'string' }, max_distance: { type: 'integer' } },
      required: ['block_name'] } },
  { name: 'find_container',
    description: 'Sandık/fıçı/shulker bulur. mode "owner_looking_at": sahibin baktığı konteyner (yoksa ona en yakın), "nearest": bota en yakın.',
    input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['owner_looking_at', 'nearest'] } } } },
  { name: 'list_container',
    description: 'Verilen koordinattaki konteynerin içindekileri listeler (yanına gidip açar).',
    input_schema: { type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } },
      required: ['x', 'y', 'z'] } },
  { name: 'take_from_container',
    description: 'Konteynerden eşya alıp envantere koyar.',
    input_schema: { type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        item_name: { type: 'string' }, count: { type: 'integer' } },
      required: ['x', 'y', 'z', 'item_name'] } },
  { name: 'deposit_to_container',
    description: 'Envanterdeki eşyayı konteynere koyar.',
    input_schema: { type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        item_name: { type: 'string' }, count: { type: 'integer' } },
      required: ['x', 'y', 'z', 'item_name'] } },
  { name: 'go_to_player', description: 'Oyuncunun yanına yürür ve varınca döner (en fazla 45 sn). Oyuncu görüş alanında olmalı.',
    input_schema: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] } },
  { name: 'go_to_coords', description: 'Koordinata yürür ve varınca döner (en fazla 45 sn).',
    input_schema: { type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'] } },
  { name: 'bring_items_to_player',
    description: 'Envanterdeki eşyayı oyuncunun yanına götürüp yere bırakır.',
    input_schema: { type: 'object',
      properties: { player: { type: 'string' }, item_name: { type: 'string' }, count: { type: 'integer' } },
      required: ['player', 'item_name'] } },
  { name: 'follow_player', description: 'Bir oyuncuyu sürekli takip eder.',
    input_schema: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] } },
  { name: 'mine_blocks',
    description: 'ARKA PLANDA yakındaki bloğu kazar/keser (örn oak_log, stone, coal_ore, diamond_ore). En fazla 64 adet.',
    input_schema: { type: 'object',
      properties: { block_name: { type: 'string' }, count: { type: 'integer' } },
      required: ['block_name'] } },
  { name: 'attack_mobs',
    description: 'ARKA PLANDA yakındaki düşman mobları öldürür. mob_name verilirse sadece o tür (zombie, skeleton...). seconds varsayılan 30, en fazla 180.',
    input_schema: { type: 'object',
      properties: { mob_name: { type: 'string' }, seconds: { type: 'integer' } } } },
  { name: 'collect_items', description: 'ARKA PLANDA yerdeki eşyaları toplar (en fazla 10).',
    input_schema: { type: 'object', properties: {} } },
  { name: 'wait_task', description: 'Arka plandaki görev bitene kadar bekler (en fazla seconds, varsayılan 30, en fazla 90).',
    input_schema: { type: 'object', properties: { seconds: { type: 'integer' } } } },
  { name: 'drop_item', description: 'Envanterdeki eşyayı olduğu yere atar.',
    input_schema: { type: 'object',
      properties: { item_name: { type: 'string' }, count: { type: 'integer' } },
      required: ['item_name'] } },
  { name: 'equip_item', description: 'Envanterdeki eşyayı kuşanır/eline alır.',
    input_schema: { type: 'object',
      properties: { item_name: { type: 'string' },
        destination: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } },
      required: ['item_name'] } },
  { name: 'sleep_in_bed', description: 'Yakındaki yatağa gidip uyur (sadece gece veya fırtınada).',
    input_schema: { type: 'object', properties: {} } },
  { name: 'set_home', description: 'Ev konumunu kaydeder. Koordinat verilmezse botun şu anki konumu.',
    input_schema: { type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } } },
  { name: 'go_home', description: 'Kayıtlı eve yürür ve varınca döner.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'patrol',
    description: 'ARKA PLANDA ev (veya verilen merkez) etrafında rastgele devriye atar. fight true ise yaklaşan düşman moblara saldırır. radius 3-40 (varsayılan 12), minutes 1-60 (varsayılan 10).',
    input_schema: { type: 'object',
      properties: { radius: { type: 'integer' }, minutes: { type: 'integer' }, fight: { type: 'boolean' },
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } } },
  { name: 'stop', description: 'Tüm aktif görevleri (yürüme, takip, kazma, saldırı, devriye) durdurur.',
    input_schema: { type: 'object', properties: {} } },
];

// ---- Yardımcılar ----
function stopAll(b) {
  if (currentTask) currentTask.cancelled = true;
  currentTask = null;
  followTarget = null;
  if (b && b.pathfinder) b.pathfinder.setGoal(null);
  if (b) b.clearControlStates();
}

function startTask(b, name, fn) {
  stopAll(b);
  const task = { name, cancelled: false };
  currentTask = task;
  fn(task)
    .catch((err) => log(`Görev hatası (${name}):`, err.message))
    .finally(() => {
      if (currentTask === task) currentTask = null;
      if (b.pathfinder) b.pathfinder.setGoal(null);
    });
  return task;
}

const v3 = (b, x, y, z) => b.entity.position.clone().set(x, y, z);

async function gotoSafe(b, goal, timeoutMs = 45_000) {
  let timer;
  try {
    await Promise.race([
      b.pathfinder.goto(goal),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('zaman aşımı')), timeoutMs); }),
    ]);
  } catch (e) {
    b.pathfinder.setGoal(null);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function equipBestWeapon(b) {
  const sword = b.inventory.items().find((i) => i.name.includes('sword'))
    || b.inventory.items().find((i) => i.name.includes('_axe'));
  return sword ? b.equip(sword, 'hand').catch(() => {}) : Promise.resolve();
}

// Mob ile dövüş: endAt zamanına kadar; stopWhenNone true ise mob kalmayınca çıkar
async function fightLoop(b, task, mob, endAt, stopWhenNone = false) {
  const { goals } = pathfinderLib;
  await equipBestWeapon(b);
  while (!task.cancelled && Date.now() < endAt) {
    const target = b.nearestEntity(
      (e) => e.type === 'hostile' && (!mob || e.name === mob) &&
        e.position.distanceTo(b.entity.position) < 20
    );
    if (!target) {
      if (stopWhenNone) return;
      await sleep(500);
      continue;
    }
    b.pathfinder.setGoal(new goals.GoalFollow(target, 1), true);
    if (target.position.distanceTo(b.entity.position) < 3.5) {
      await b.lookAt(target.position.offset(0, (target.height || 1.5) * 0.9, 0)).catch(() => {});
      b.attack(target);
      await sleep(650);
    } else {
      await sleep(200);
    }
  }
}

// Sahibin baktığı bloğu ışın izleyerek bulur
function blockLookedAtBy(b, playerName, maxDist = 8) {
  const e = b.players[playerName]?.entity;
  if (!e) return null;
  const eye = e.position.offset(0, 1.6, 0);
  const dx = -Math.sin(e.yaw) * Math.cos(e.pitch);
  const dy = Math.sin(e.pitch);
  const dz = -Math.cos(e.yaw) * Math.cos(e.pitch);
  for (let t = 0.3; t <= maxDist; t += 0.1) {
    const block = b.blockAt(eye.offset(dx * t, dy * t, dz * t));
    if (block && block.boundingBox !== 'empty') return block;
  }
  return null;
}

const isContainerName = (n) => /(chest|barrel|shulker_box)$/.test(n) && n !== 'ender_chest';

function containerIds(b) {
  return Object.values(b.registry.blocksByName)
    .filter((x) => isContainerName(x.name))
    .map((x) => x.id);
}

// Konteynere gidip açar, fn(window) çalıştırır, kapatır
async function withContainer(b, x, y, z, fn) {
  const block = b.blockAt(v3(b, x, y, z));
  if (!block || !isContainerName(block.name)) throw new Error('orada sandık/fıçı yok');
  await gotoSafe(b, new pathfinderLib.goals.GoalNear(x, y, z, 3), 30_000);
  const win = await b.openContainer(block);
  try {
    return await fn(win);
  } finally {
    try { win.close(); } catch { /* yok say */ }
  }
}

const countBy = (items) => {
  const m = {};
  for (const i of items) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
};
const fmtCounts = (m) =>
  Object.entries(m).map(([k, v]) => `${k} x${v}`).join(', ') || 'boş';

function scanSurroundings(b) {
  const out = [];
  out.push(`Zaman: ${b.time?.isDay ? 'gündüz' : 'gece'}, hava: ${b.isRaining ? 'yağmurlu' : 'açık'}`);
  out.push(`Konum: ${fmtPos(b.entity.position)}`);

  const players = Object.values(b.players)
    .filter((p) => p.username !== b.username)
    .map((p) => p.entity
      ? `${p.username} (${Math.round(p.entity.position.distanceTo(b.entity.position))}m)`
      : `${p.username} (uzakta)`);
  out.push(`Oyuncular: ${players.join(', ') || 'yok'}`);

  const hostiles = {};
  let drops = 0;
  for (const e of Object.values(b.entities)) {
    const d = e.position.distanceTo(b.entity.position);
    if (d > 24 || e === b.entity) continue;
    if (e.type === 'hostile') hostiles[e.name] = (hostiles[e.name] || 0) + 1;
    if (e.name === 'item' || e.displayName === 'Item') drops++;
  }
  out.push(`Düşman moblar (24m): ${fmtCounts(hostiles) === 'boş' ? 'yok' : fmtCounts(hostiles)}`);
  out.push(`Yerdeki eşya sayısı: ${drops}`);

  const R = 8;
  const base = b.entity.position.floored();
  const counts = {};
  const skip = new Set(['air', 'cave_air', 'void_air', 'stone', 'dirt', 'grass_block', 'deepslate', 'water', 'lava', 'bedrock', 'netherrack']);
  for (let x = -R; x <= R; x++) {
    for (let y = -R; y <= R; y++) {
      for (let z = -R; z <= R; z++) {
        const bl = b.blockAt(base.offset(x, y, z));
        if (bl && !skip.has(bl.name)) counts[bl.name] = (counts[bl.name] || 0) + 1;
      }
    }
  }
  const interesting = Object.entries(counts).filter(([n]) =>
    /(ore|chest|barrel|furnace|crafting_table|_bed|spawner|portal|anvil|enchanting|sign|door|farmland|wheat|carrots|potatoes)/.test(n));
  const top = Object.entries(counts).sort((a, c) => c[1] - a[1]).slice(0, 8);
  out.push(`Önemli bloklar (8 blok): ${interesting.map(([n, c]) => `${n} x${c}`).join(', ') || 'yok'}`);
  out.push(`En çok bloklar: ${top.map(([n, c]) => `${n} x${c}`).join(', ')}`);
  return out.join('\n');
}

// ---- Araç çalıştırıcı ----
async function runTool(b, name, input, owner) {
  const needsPf = ['go_to_player', 'go_to_coords', 'bring_items_to_player', 'follow_player', 'mine_blocks',
    'attack_mobs', 'collect_items', 'list_container', 'take_from_container', 'deposit_to_container',
    'sleep_in_bed', 'go_home', 'patrol'];
  if (needsPf.includes(name) && !pathfinderLib) return 'Hata: pathfinder kurulu değil.';
  const goals = pathfinderLib ? pathfinderLib.goals : null;
  const invItem = (n) => b.inventory.items().find((i) => i.name === String(n).toLowerCase());

  switch (name) {
    case 'say':
      await sendChunks(b, owner, String(input.text || ''), false);
      return 'Mesaj yazıldı.';

    case 'get_status':
      return `Can ${Math.round(b.health)}/20, açlık ${b.food}/20, konum ${fmtPos(b.entity.position)}, ` +
        `ev: ${home ? `${home.x}, ${home.y}, ${home.z}` : 'yok'}, ` +
        `görev: ${currentTask ? currentTask.name : 'yok'}, ` +
        `elde: ${b.heldItem ? b.heldItem.name : 'boş'}, ` +
        `envanter: ${fmtCounts(countBy(b.inventory.items())).slice(0, 600)}`;

    case 'scan_surroundings':
      return scanSurroundings(b);

    case 'find_blocks': {
      const info = b.registry.blocksByName[String(input.block_name || '').toLowerCase()];
      if (!info) return `Hata: "${input.block_name}" adında bir blok yok.`;
      const dist = Math.max(8, Math.min(Number(input.max_distance) || 64, 128));
      const found = b.findBlocks({ matching: info.id, maxDistance: dist, count: 5 });
      if (!found.length) return `${dist} blok içinde ${info.name} yok.`;
      return found.map((p) => `${p.x}, ${p.y}, ${p.z} (${Math.round(p.distanceTo(b.entity.position))}m)`).join(' | ');
    }

    case 'find_container': {
      const positions = b.findBlocks({ matching: containerIds(b), maxDistance: 48, count: 30 });
      if (!positions.length) return 'Yakında sandık/fıçı yok.';
      let ref = b.entity.position;
      let note = 'bota en yakın';
      if (input.mode !== 'nearest') {
        const looked = blockLookedAtBy(b, owner);
        if (looked) {
          if (isContainerName(looked.name)) {
            return `Sahibin baktığı ${looked.name}: ${looked.position.x}, ${looked.position.y}, ${looked.position.z}`;
          }
          ref = looked.position;
          note = 'sahibin baktığı yere en yakın';
        } else {
          note = 'sahip bir şeye bakmıyor/görünmüyor, bota en yakın';
        }
      }
      positions.sort((a, c) => a.distanceTo(ref) - c.distanceTo(ref));
      const p = positions[0];
      const blk = b.blockAt(p);
      return `${blk ? blk.name : 'konteyner'} (${note}): ${p.x}, ${p.y}, ${p.z}`;
    }

    case 'list_container': {
      const items = await withContainer(b, input.x, input.y, input.z, async (win) => win.containerItems());
      return `İçerik: ${fmtCounts(countBy(items))}`.slice(0, 1200);
    }

    case 'take_from_container': {
      const want = Math.max(1, Math.min(Number(input.count) || 1, 2304));
      const itemName = String(input.item_name).toLowerCase();
      return withContainer(b, input.x, input.y, input.z, async (win) => {
        const stock = win.containerItems().filter((i) => i.name === itemName);
        const have = stock.reduce((s, i) => s + i.count, 0);
        if (!have) return `Hata: konteynerde ${itemName} yok.`;
        let left = Math.min(want, have);
        const total = left;
        for (const stack of stock) {
          if (left <= 0) break;
          const n = Math.min(stack.count, left);
          await win.withdraw(stack.type, null, n);
          left -= n;
        }
        return `${total} adet ${itemName} alındı${total < want ? ` (istenen ${want}, konteynerde ${have} vardı)` : ''}.`;
      });
    }

    case 'deposit_to_container': {
      const item = invItem(input.item_name);
      if (!item) return `Hata: envanterde ${input.item_name} yok.`;
      const total = b.inventory.items().filter((i) => i.name === item.name).reduce((s, i) => s + i.count, 0);
      const n = Math.max(1, Math.min(Number(input.count) || total, total));
      return withContainer(b, input.x, input.y, input.z, async (win) => {
        await win.deposit(item.type, null, n);
        return `${n} adet ${item.name} konteynere konuldu.`;
      });
    }

    case 'go_to_player': {
      const t = b.players[input.player]?.entity;
      if (!t) return `Hata: ${input.player} görüş alanımda değil.`;
      stopAll(b);
      const { x, y, z } = t.position;
      await gotoSafe(b, new goals.GoalNear(x, y, z, 2));
      return `${input.player} oyuncusunun yanına varıldı.`;
    }

    case 'go_to_coords':
      stopAll(b);
      await gotoSafe(b, new goals.GoalNear(input.x, input.y, input.z, 1));
      return `${input.x}, ${input.y}, ${input.z} konumuna varıldı.`;

    case 'bring_items_to_player': {
      const t = b.players[input.player]?.entity;
      if (!t) return `Hata: ${input.player} görüş alanımda değil.`;
      const item = invItem(input.item_name);
      if (!item) return `Hata: envanterde ${input.item_name} yok.`;
      const total = b.inventory.items().filter((i) => i.name === item.name).reduce((s, i) => s + i.count, 0);
      const n = Math.max(1, Math.min(Number(input.count) || total, total));
      stopAll(b);
      const { x, y, z } = t.position;
      await gotoSafe(b, new goals.GoalNear(x, y, z, 2));
      const fresh = b.players[input.player]?.entity;
      if (fresh) await b.lookAt(fresh.position.offset(0, 1.2, 0)).catch(() => {});
      await b.toss(item.type, null, n);
      return `${n} adet ${item.name} ${input.player} oyuncusuna bırakıldı.`;
    }

    case 'follow_player': {
      const t = b.players[input.player]?.entity;
      if (!t) return `Hata: ${input.player} görüş alanımda değil.`;
      stopAll(b);
      followTarget = input.player;
      b.pathfinder.setGoal(new goals.GoalFollow(t, 2), true);
      return `${input.player} takip ediliyor.`;
    }

    case 'mine_blocks': {
      const blockName = String(input.block_name || '').toLowerCase();
      const info = b.registry.blocksByName[blockName];
      if (!info) return `Hata: "${blockName}" adında bir blok yok.`;
      const count = Math.max(1, Math.min(Number(input.count) || 1, 64));
      startTask(b, `${blockName} kaz`, async (task) => {
        let mined = 0;
        let fails = 0;
        while (!task.cancelled && mined < count && fails < 5) {
          const block = b.findBlock({ matching: info.id, maxDistance: 48 });
          if (!block) {
            b.chat(`Yakında ${blockName} bulamadım. (${mined}/${count})`);
            return;
          }
          try {
            await gotoSafe(b, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), 30_000);
            const target = b.blockAt(block.position);
            if (!target || target.name !== blockName) continue;
            const tool = moves && moves.bestHarvestTool ? moves.bestHarvestTool(target) : null;
            if (tool) await b.equip(tool, 'hand');
            await b.dig(target);
            mined++;
            fails = 0;
          } catch {
            fails++;
          }
        }
        if (!task.cancelled) b.chat(`Bitti: ${mined}/${count} ${blockName}.`);
      });
      return `${count} adet ${blockName} kazılmaya başlandı (arka planda).`;
    }

    case 'attack_mobs': {
      const mob = input.mob_name ? String(input.mob_name).toLowerCase() : null;
      const seconds = Math.max(5, Math.min(Number(input.seconds) || 30, 180));
      startTask(b, 'saldır', async (task) => {
        await fightLoop(b, task, mob, Date.now() + seconds * 1000);
        if (!task.cancelled) b.chat('Saldırı bitti.');
      });
      return `${seconds} saniye boyunca ${mob || 'düşman moblara'} saldırılacak (arka planda).`;
    }

    case 'collect_items': {
      startTask(b, 'eşya topla', async (task) => {
        let got = 0;
        for (let i = 0; i < 10 && !task.cancelled; i++) {
          const drop = b.nearestEntity(
            (e) => (e.name === 'item' || e.displayName === 'Item') &&
              e.position.distanceTo(b.entity.position) < 24
          );
          if (!drop) break;
          try {
            await gotoSafe(b, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5), 15_000);
            got++;
          } catch { break; }
          await sleep(300);
        }
        if (!task.cancelled) b.chat(`${got} eşya noktasına gidildi.`);
      });
      return 'Yerdeki eşyalar toplanıyor (arka planda).';
    }

    case 'wait_task': {
      const secs = Math.max(1, Math.min(Number(input.seconds) || 30, 90));
      const end = Date.now() + secs * 1000;
      while (currentTask && Date.now() < end) await sleep(500);
      return currentTask ? `Görev (${currentTask.name}) hâlâ sürüyor.` : 'Görev bitti.';
    }

    case 'drop_item': {
      const item = invItem(input.item_name);
      if (!item) return `Hata: envanterde ${input.item_name} yok.`;
      const total = b.inventory.items().filter((i) => i.name === item.name).reduce((s, i) => s + i.count, 0);
      const n = Math.max(1, Math.min(Number(input.count) || total, total));
      await b.toss(item.type, null, n);
      return `${n} adet ${item.name} atıldı.`;
    }

    case 'equip_item': {
      const item = invItem(input.item_name);
      if (!item) return `Hata: envanterde ${input.item_name} yok.`;
      await b.equip(item, input.destination || 'hand');
      return `${item.name} kuşanıldı.`;
    }

    case 'sleep_in_bed': {
      if (b.time?.isDay && !b.isRaining) return 'Şu an uyunamaz (gündüz).';
      const bedIds = Object.values(b.registry.blocksByName)
        .filter((x) => x.name.endsWith('_bed')).map((x) => x.id);
      const bed = b.findBlock({ matching: bedIds, maxDistance: 48 });
      if (!bed) return 'Yakında yatak yok.';
      stopAll(b);
      await gotoSafe(b, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 30_000);
      await b.sleep(bed);
      return 'Yatağa yatıldı.';
    }

    case 'set_home': {
      const p = b.entity.position;
      home = {
        x: Math.round(input.x ?? p.x),
        y: Math.round(input.y ?? p.y),
        z: Math.round(input.z ?? p.z),
      };
      return `Ev kaydedildi: ${home.x}, ${home.y}, ${home.z}`;
    }

    case 'go_home':
      if (!home) return 'Hata: ev kayıtlı değil, önce set_home kullan.';
      stopAll(b);
      await gotoSafe(b, new goals.GoalNear(home.x, home.y, home.z, 1));
      return 'Eve varıldı.';

    case 'patrol': {
      const p = b.entity.position;
      const center = input.x != null
        ? { x: input.x, y: input.y ?? p.y, z: input.z ?? p.z }
        : (home || { x: p.x, y: p.y, z: p.z });
      const radius = Math.max(3, Math.min(Number(input.radius) || 12, 40));
      const minutes = Math.max(1, Math.min(Number(input.minutes) || 10, 60));
      const fight = !!input.fight;
      startTask(b, 'devriye', async (task) => {
        const end = Date.now() + minutes * 60_000;
        while (!task.cancelled && Date.now() < end) {
          if (fight) await fightLoop(b, task, null, Date.now() + 15_000, true);
          if (task.cancelled) break;
          const ang = Math.random() * Math.PI * 2;
          const r = 2 + Math.random() * (radius - 2);
          try {
            await gotoSafe(
              b,
              new goals.GoalXZ(Math.round(center.x + Math.cos(ang) * r), Math.round(center.z + Math.sin(ang) * r)),
              20_000
            );
          } catch { /* ulaşılamadı, sonrakini dene */ }
          const pause = rand(2000, 6000);
          const until = Date.now() + pause;
          while (!task.cancelled && Date.now() < until) await sleep(300);
          if (!task.cancelled && Math.random() < 0.4) {
            b.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false);
          }
        }
        if (!task.cancelled) b.chat('Devriye bitti.');
      });
      return `${Math.round(center.x)}, ${Math.round(center.z)} çevresinde ${radius} blok yarıçapla ${minutes} dk devriye başladı` +
        `${fight ? ' (düşmanlara saldırır)' : ''} (arka planda).`;
    }

    case 'stop':
      stopAll(b);
      return 'Tüm görevler durduruldu.';

    default:
      return `Hata: bilinmeyen araç ${name}.`;
  }
}

// İç format Anthropic tarzıdır. OpenAI uyumlu sağlayıcılar (Groq, Gemini, OpenRouter) için çevrilir.
function toOpenAiMessages(system, msgs) {
  const out = [{ role: 'system', content: system }];
  for (const m of msgs) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      const calls = m.content.filter((c) => c.type === 'tool_use').map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const r of m.content) {
        if (r.type === 'tool_result') out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: String(r.content) });
      }
    }
  }
  return out;
}

async function callClaude(body) {
  const isAnthropic = CONFIG.ai.provider === 'anthropic';
  let url, headers, payload;

  if (isAnthropic) {
    url = `${CONFIG.ai.baseUrl}/v1/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': CONFIG.ai.apiKey,
      'anthropic-version': '2023-06-01',
    };
    payload = body;
  } else {
    url = `${CONFIG.ai.baseUrl}/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${CONFIG.ai.apiKey}` };
    payload = {
      model: body.model,
      max_tokens: body.max_tokens,
      messages: toOpenAiMessages(body.system, body.messages),
    };
    if (body.tools) {
      payload.tools = body.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    log(`AI hatası (${CONFIG.ai.provider}): HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const data = await res.json();
  if (isAnthropic) return data;

  // OpenAI yanıtını Anthropic biçimine çevir
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) {
    log('AI hatası: beklenmeyen yanıt', JSON.stringify(data).slice(0, 200));
    return null;
  }
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* boş bırak */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return { content, stop_reason: (msg.tool_calls && msg.tool_calls.length) ? 'tool_use' : 'end_turn' };
}

const textOf = (content) =>
  (content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();

// Tetikleyiciler: "!ai ...", "!sor ...", mesajda bot adı geçmesi, fısıltı
function handleAi(b, username, message, viaWhisper) {
  if (!CONFIG.ai.enabled) {
    const l = message.toLowerCase();
    if (l.startsWith(`${CONFIG.commandPrefix}ai `) || l.startsWith(`${CONFIG.commandPrefix}sor `)) {
      sendChunks(b, username, 'Yapay zeka kapalı: Railway Variables kısmına AI_API_KEY eklenmemiş.', viaWhisper);
      return true;
    }
    return false;
  }

  const owner = isOwner(username);
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

  // Sahip değilse: AI_OWNER_ONLY açıksa tamamen yok say, değilse sadece sohbet
  if (!owner && CONFIG.ai.ownerOnly) return true;

  // Sahip için anında durdurma kelimeleri (AI meşgulken bile çalışır)
  if (owner && /^(dur|durdur|iptal|stop|bırak|bekle)[\s!.]*$/i.test(text)) {
    stopAll(b);
    sendChunks(b, username, 'Durdum.', viaWhisper);
    return true;
  }

  const now = Date.now();
  const cooldown = owner ? 1500 : CONFIG.ai.cooldownMs;
  if (now - (aiLastUse.get(username) || 0) < cooldown) return true; // sessizce yok say
  if (aiBusy) {
    if (owner) sendChunks(b, username, 'Bir önceki işle meşgulüm, bitince yaz ya da "dur" de.', viaWhisper);
    return true;
  }

  aiLastUse.set(username, now);
  askAi(b, username, text.slice(0, 400), viaWhisper, owner);
  return true;
}

async function askAi(b, username, text, viaWhisper, owner) {
  aiBusy = true;
  try {
    const history = aiHistory.get(username) || [];
    const msgs = [...history, { role: 'user', content: `${username}: ${text}` }];
    const system = owner ? OWNER_PROMPT : CONFIG.ai.systemPrompt + OTHERS_SUFFIX;

    let finalText = '';
    let usedTools = false;
    // Araç kullanım döngüsü (sadece sahip için): en fazla 12 tur
    for (let i = 0; i < 12; i++) {
      const body = {
        model: CONFIG.ai.model,
        max_tokens: owner ? 500 : CONFIG.ai.maxTokens,
        system,
        messages: msgs,
      };
      if (owner) body.tools = TOOLS;

      const data = await callClaude(body);
      if (!data) {
        await sendChunks(b, username, 'Yapay zeka şu an cevap veremiyor (limit veya bağlantı hatası).', viaWhisper);
        return;
      }

      if (data.stop_reason === 'tool_use') {
        usedTools = true;
        msgs.push({ role: 'assistant', content: data.content });
        const results = [];
        for (const block of data.content.filter((c) => c.type === 'tool_use')) {
          let out;
          try {
            out = await runTool(b, block.name, block.input || {}, username);
          } catch (e) {
            out = `Hata: ${e.message}`;
          }
          log(`Araç: ${block.name} ${JSON.stringify(block.input)} -> ${String(out).slice(0, 150)}`);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: String(out).slice(0, 1500) });
        }
        msgs.push({ role: 'user', content: results });
        continue;
      }

      finalText = textOf(data.content);
      break;
    }

    if (!finalText) finalText = usedTools ? 'Tamamdır.' : '';
    if (!finalText) return;

    history.push({ role: 'user', content: `${username}: ${text}` });
    history.push({ role: 'assistant', content: finalText });
    while (history.length > CONFIG.ai.maxHistory) history.shift();
    while (history.length && history[0].role !== 'user') history.shift();
    aiHistory.set(username, history);

    await sendChunks(b, username, finalText, viaWhisper);
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

  for (const chunk of chunks.slice(0, 4)) {
    const part = chunk.trim().replace(/^\/+/, '');
    if (!part || b !== bot) continue;
    if (viaWhisper) b.whisper(username, part);
    else b.chat(part);
    await sleep(1500);
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
