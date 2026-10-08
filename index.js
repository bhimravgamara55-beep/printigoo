const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Optional PDF inspection (graceful fallback if not yet installed)
let PDFDocument = null;
try {
  PDFDocument = require('pdf-lib').PDFDocument;
} catch (e) {
  console.warn('[PDF Parser] pdf-lib not loaded, using fallback page counter.');
}

const app = express();
const server = http.createServer(app);

// Initialize Socket.io with permissive CORS for local dev & cloud deployment
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ephemeral Uploads Directory
const UPLOAD_DIR = path.join(__dirname, 'uploads', 'temp');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer Storage Configuration (Random UUID filenames)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.pdf';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max limit
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    const isPdf = file.originalname.toLowerCase().endsWith('.pdf');
    if (allowed.includes(file.mimetype) || isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF documents and image files (JPG, PNG, WebP) are allowed.'));
    }
  }
});

// ---------------------------------------------------------------------
// PERSISTENT JSON DATABASE (Storage in data/shops.json & data/subscriptions.json)
// ---------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const SHOPS_FILE = path.join(DATA_DIR, 'shops.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

const DEFAULT_SHOPS = {
  'gamara-enterprises': {
    name: 'GAMARA ENTERPRISES',
    slug: 'gamara-enterprises',
    ownerName: 'Bhimrav Gamara',
    address: 'Radhanpur, Gujarat',
    phone: '9909577877',
    whatsapp: '9909577877',
    upiId: 'bmgamara@ybl',
    username: 'gamara',
    password: 'password123',
    status: 'online',
    createdAt: new Date().toISOString(),
    pricing: {
      bwSingle: 2.0,
      bwDouble: 3.0,
      colorSingle: 10.0,
      colorDouble: 15.0,
      legalMarkup: 1.5
    },
    subscription: {
      plan: 'Yearly Pro',
      amount: 1999,
      status: 'active',
      validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    }
  }
};

function loadShops() {
  try {
    if (fs.existsSync(SHOPS_FILE)) {
      const raw = fs.readFileSync(SHOPS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch (err) {
    console.error('[Storage] Error reading shops.json:', err.message);
  }
  saveShops(DEFAULT_SHOPS);
  return { ...DEFAULT_SHOPS };
}

function saveShops(data) {
  try {
    fs.writeFileSync(SHOPS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Error writing shops.json:', err.message);
  }
}

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      const raw = fs.readFileSync(SUBS_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[Storage] Error reading subscriptions.json:', err.message);
  }
  return [];
}

function saveSubscriptions(arr) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Error writing subscriptions.json:', err.message);
  }
}

// Master In-Memory Cache with instant JSON disk-sync
const shops = loadShops();
const subscriptionsList = loadSubscriptions();
const ADMIN_PIN = 'Gamara@0933';

// Jobs storage: key = jobId
const jobs = new Map();

// Daily Sequential Token Counter per shop
const tokenCounters = {};
function getNextToken(shopSlug) {
  if (!tokenCounters[shopSlug]) {
    tokenCounters[shopSlug] = 100;
  }
  tokenCounters[shopSlug] += 1;
  if (tokenCounters[shopSlug] > 999) {
    tokenCounters[shopSlug] = 101;
  }
  return `#${tokenCounters[shopSlug]}`;
}

// Pricing Calculation Helper
function calculateJobPrice({ pages, copies, colorMode, duplex, paperSize, pricing }) {
  const safeCopies = Math.max(1, parseInt(copies, 10) || 1);
  const isDuplex = duplex === 'double';
  const isColor = colorMode === 'color';
  const isLegal = paperSize === 'Legal';

  // Sheets needed per copy
  const sheetsPerCopy = isDuplex ? Math.ceil(pages / 2) : pages;

  // Rate per sheet
  let baseRate = 0;
  if (isColor) {
    baseRate = isDuplex ? pricing.colorDouble : pricing.colorSingle;
  } else {
    baseRate = isDuplex ? pricing.bwDouble : pricing.bwSingle;
  }

  if (isLegal) {
    baseRate += pricing.legalMarkup;
  }

  const totalAmount = Math.max(1, sheetsPerCopy * baseRate * safeCopies);

  return {
    totalAmount: parseFloat(totalAmount.toFixed(2)),
    sheetsPerCopy,
    ratePerSheet: baseRate
  };
}

// Shred / Unlink file safely (Zero-Retention Privacy)
function shredFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Zero-Retention Shredder] Securely purged: ${path.basename(filePath)}`);
    }
  } catch (err) {
    console.error(`[Shredder Error] Could not delete ${filePath}:`, err.message);
  }
}

// ---------------------------------------------------------------------
// Ephemeral Storage Sweeper: Auto-delete files older than 30 minutes
// ---------------------------------------------------------------------
const RETENTION_MS = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
  console.log('[Ephemeral Sweeper] Checking for expired temporary files (>30 mins)...');
  const now = Date.now();

  // Clean from file system
  try {
    if (fs.existsSync(UPLOAD_DIR)) {
      const files = fs.readdirSync(UPLOAD_DIR);
      files.forEach((file) => {
        const fullPath = path.join(UPLOAD_DIR, file);
        try {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > RETENTION_MS) {
            shredFile(fullPath);
          }
        } catch (e) {
          // ignore stat errors
        }
      });
    }
  } catch (e) {
    console.error('[Ephemeral Sweeper] Error sweeping temp directory:', e.message);
  }

  // Clean memory jobs if expired & update status
  for (const [id, job] of jobs.entries()) {
    if (job.expiresAt && now > new Date(job.expiresAt).getTime()) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        shredFile(job.filePath);
      }
      job.jobStatus = 'expired';
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// ---------------------------------------------------------------------
// Static Web UI Serving (Works in both nested and flat folder modes)
// ---------------------------------------------------------------------
let WEB_DIR = __dirname;
if (fs.existsSync(path.join(__dirname, 'web'))) {
  WEB_DIR = path.join(__dirname, 'web');
} else if (fs.existsSync(path.join(__dirname, '..', 'web'))) {
  WEB_DIR = path.join(__dirname, '..', 'web');
}
// Serve Landing & Sign-in Page on Root / (Guaranteed home.html)
app.get('/', (req, res) => {
  const homePath = path.join(WEB_DIR, 'home.html');
  if (fs.existsSync(homePath)) {
    return res.sendFile(homePath);
  }
  const indexPath = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.send('PrintGoo Landing Page not found.');
});

// Serve Customer QR Scan Upload Portal for /q/:shop_slug
app.get('/q/:shop_slug', (req, res) => {
  const customerPath = path.join(WEB_DIR, 'customer.html');
  if (fs.existsSync(customerPath)) {
    return res.sendFile(customerPath);
  }
  res.send('PrintGoo Customer Portal not found.');
});

// Serve Business Registration / Onboarding Page
app.get('/register', (req, res) => {
  const regPath = path.join(WEB_DIR, 'register.html');
  if (fs.existsSync(regPath)) {
    return res.sendFile(regPath);
  }
  res.sendFile(path.join(WEB_DIR, 'home.html'));
});

// Serve Windows Print Station Setup Downloader (.bat script)
app.get('/download/print-station', (req, res) => {
  const batScript = `@echo off
title PrintGoo Windows Print Station Installer
echo ========================================================
echo       PrintGoo Smart Print Station - Windows Setup
echo ========================================================
echâœ…
echo Installing PrintGoo Desktop App on your Windows PC...
echâœ…

set SCRIPT="%TEMP%\\CreatePrintGooShortcut.vbs"
echo Set oWS = WScript.CreateObject("WScript.Shell") > %SCRIPT%
echo sLinkFile = oWS.SpecialFolders("Desktop") ^& "\\PrintGoo Station.lnk" >> %SCRIPT%
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> %SCRIPT%
echo oLink.TargetPath = "https://www.printgoâœ…in" >> %SCRIPT%
echo oLink.Description = "PrintGoo Smart Print Desk" >> %SCRIPT%
echo oLink.Save >> %SCRIPT%
cscript /nologo %SCRIPT%
del %SCRIPT%

echâœ…
echo [SUCCESS] PrintGoo Desktop Shortcut created on your Desktop!
echo Launching PrintGoo Station...
start "" "msedge.exe" --app="https://www.printgoâœ…in" || start "" "chrome.exe" --app="https://www.printgoâœ…in" || start "" "https://www.printgoâœ…in"
exit
`;

  res.setHeader('Content-Disposition', 'attachment; filename="PrintGoo-Print-Station-Setup.bat"');
  res.setHeader('Content-Type', 'application/x-bat');
  res.send(batScript);
});

// Serve Master Admin Dashboard
app.get('/gamara-admin', (req, res) => {
  const adminPath = path.join(WEB_DIR, 'admin.html');
  if (fs.existsSync(adminPath)) {
    return res.sendFile(adminPath);
  }
  res.send('PrintGoo Master Admin Panel: admin.html not found.');
});

// Serve Shopkeeper Live Dashboard
app.get('/dashboard/:shop_slug?', (req, res) => {
  const dashPath = path.join(WEB_DIR, 'dashboard.html');
  if (fs.existsSync(dashPath)) {
    return res.sendFile(dashPath);
  }
  res.send('PrintGoo Shopkeeper Dashboard: dashboard.html not found.');
});

// Static files (disable index.html default to prevent override)
app.use(express.static(WEB_DIR, { index: false }));

// ---------------------------------------------------------------------
// REST API ROUTES
// ---------------------------------------------------------------------

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    activeJobs: jobs.size,
    timestamp: new Date().toISOString()
  });
});

// Get Shop details by slug
app.get('/api/shops/:shop_slug', (req, res) => {
  const slug = req.params.shop_slug.toLowerCase();
  let shop = shops[slug];

  // Auto-generate if new slug is queried
  if (!shop) {
    const formattedName = slug
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') + ' Xerox Center';

    shop = {
      name: formattedName,
      slug: slug,
      ownerName: 'Station Operator',
      address: 'Main Market Counter',
      phone: '+91 99095 77877',
      upiId: 'bmgamara@ybl',
      status: 'online',
      pricing: {
        bwSingle: 2.0,
        bwDouble: 3.0,
        colorSingle: 10.0,
        colorDouble: 15.0,
        legalMarkup: 1.5
      }
    };
    shops[slug] = shop;
  }

  res.json({ success: true, shop });
});

// ---------------------------------------------------------------------
// AUTHENTICATION & REGISTRATION APIS
// ---------------------------------------------------------------------

// 1. Shopkeeper Registration (Free Trial + Custom UPI)
app.post('/api/register', (req, res) => {
  const { shopName, ownerName, city, mobile, whatsapp, upiId, username, password } = req.body;

  if (!shopName || !ownerName || !city || !mobile || !username || !password) {
    return res.status(400).json({ success: false, error: 'àª¬àª§àª¾ àªœàª°à«‚àª°à«€ àª–àª¾àª¨àª¾ (Shop Name, Owner, City, Mobile, Username, Password) àª­àª°àªµàª¾ àª«àª°àªœàª¿àª¯àª¾àª¤ àª›à«‡.' });
  }

  const cleanUser = username.trim().toLowerCase();
  const slug = cleanUser.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shop';

  // Check if username or slug already exists
  if (shops[slug] || Object.values(shops).some(s => s.username && s.username.toLowerCase() === cleanUser)) {
    return res.status(400).json({ success: false, error: 'àª† Username àª…àª¥àªµàª¾ àª¦à«àª•àª¾àª¨ àªªàª¹à«‡àª²à«‡àª¥à«€ àª°àªœà«€àª¸à«àªŸàª° àª¥àª¯à«‡àª²à«€ àª›à«‡. àª•à«ƒàªªàª¾ àª•àª°à«€àª¨à«‡ àª¬à«€àªœà«àª‚ Username àªªàª¸àª‚àª¦ àª•àª°à«‹ àª…àª¥àªµàª¾ Login àª•àª°à«‹.' });
  }

  const now = new Date();
  const trialExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const newShop = {
    name: shopName.trim(),
    slug: slug,
    ownerName: ownerName.trim(),
    address: city.trim(),
    phone: mobile.trim(),
    whatsapp: (whatsapp || mobile).trim(),
    upiId: (upiId || '').trim(),
    username: cleanUser,
    password: password.trim(),
    status: 'online',
    createdAt: now.toISOString(),
    pricing: {
      bwSingle: 2.0,
      bwDouble: 3.0,
      colorSingle: 10.0,
      colorDouble: 15.0,
      legalMarkup: 1.5
    },
    subscription: {
      plan: '7-Day Free Trial',
      amount: 0,
      status: 'active',
      paidAt: now.toISOString(),
      validUntil: trialExpiry.toISOString()
    }
  };

  shops[slug] = newShop;
  saveShops(shops);

  console.log(`[Registration] New Shop Created: "${newShop.name}" (${slug}) by ${newShop.ownerName}, Phone: ${newShop.phone}, UPI: ${newShop.upiId}`);
  res.json({ success: true, shop: newShop, slug });
});

// 2. Shopkeeper Login Verification
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'àª•à«ƒàªªàª¾ àª•àª°à«€àª¨à«‡ Username àª…àª¨à«‡ Password àª¬àª‚àª¨à«‡ àª²àª–à«‹.' });
  }

  const q = username.trim().toLowerCase();
  const p = password.trim();

  // Find shop by username, slug, or mobile phone
  const shop = Object.values(shops).find(s => 
    (s.username && s.username.toLowerCase() === q) || 
    (s.slug && s.slug.toLowerCase() === q) || 
    (s.phone && s.phone.replace(/[^0-9]/g, '') === q.replace(/[^0-9]/g, ''))
  );

  if (!shop) {
    return res.status(404).json({
      success: false,
      error: 'àª† àª¦à«àª•àª¾àª¨ àª°àªœà«€àª¸à«àªŸàª° àª¥àª¯à«‡àª²à«€ àª¨àª¥à«€! àª•à«ƒàªªàª¾ àª•àª°à«€àª¨à«‡ à«­-àª¦àª¿àªµàª¸ àª«à«àª°à«€ àªŸà«àª°àª¾àª¯àª² àª®àª¾àªŸà«‡ àª¨àªµà«àª‚ àª°àªœà«€àª¸à«àªŸà«àª°à«‡àª¶àª¨ àª•àª°à«‹.'
    });
  }

  if (shop.password && shop.password !== p) {
    return res.status(401).json({
      success: false,
      error: 'àª–à«‹àªŸà«‹ àªªàª¾àª¸àªµàª°à«àª¡! àª•à«ƒàªªàª¾ àª•àª°à«€àª¨à«‡ àª¸àª¾àªšà«‹ àªªàª¾àª¸àªµàª°à«àª¡ àª¨àª¾àª–à«‹.'
    });
  }

  if (shop.status === 'suspended' || shop.status === 'blocked') {
    return res.status(403).json({
      success: false,
      error: 'àª¤àª®àª¾àª°à«àª‚ àªàª•àª¾àª‰àª¨à«àªŸ àª¹àª¾àª² àª¬àª‚àª§ (Suspended) àª›à«‡. àªàª¡àª®àª¿àª¨ àª¸àªªà«‹àª°à«àªŸ: +91 9909577877'
    });
  }

  console.log(`[Auth Login] Shop "${shop.name}" (${shop.slug}) logged in successfully.`);
  res.json({
    success: true,
    shop: {
      name: shop.name,
      slug: shop.slug,
      ownerName: shop.ownerName,
      address: shop.address,
      phone: shop.phone,
      whatsapp: shop.whatsapp,
      upiId: shop.upiId,
      subscription: shop.subscription
    }
  });
});

// ---------------------------------------------------------------------
// MASTER ADMIN APIS (/admin Control Room)
// ---------------------------------------------------------------------

// Admin Login with PIN
app.post('/api/admin/login', (req, res) => {
  const pin = String(req.body.pin || '').trim();
  if (pin === ADMIN_PIN) {
    return res.json({ success: true, message: 'Admin verified successfully' });
  }
  res.status(401).json({ success: false, error: 'àª–à«‹àªŸà«‹ àªàª¡àª®àª¿àª¨ PIN! àª¸àª¾àªšà«‹ PIN àª¨àª¾àª–à«‹.' });
});

// Admin Get All Shops & Stats
app.get('/api/admin/shops', (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ success: false, error: 'Unauthorized Admin Access' });
  }

  const allShops = Object.values(shops).map(s => {
    let daysLeft = 0;
    if (s.subscription && s.subscription.validUntil) {
      const ms = new Date(s.subscription.validUntil) - Date.now();
      daysLeft = Math.ceil(ms / (1000 * 60 * 60 * 24));
    }
    return {
      name: s.name,
      slug: s.slug,
      ownerName: s.ownerName,
      address: s.address,
      phone: s.phone,
      whatsapp: s.whatsapp,
      upiId: s.upiId,
      username: s.username,
      status: s.status,
      createdAt: s.createdAt,
      subscription: s.subscription,
      daysRemaining: daysLeft
    };
  });

  const totalShops = allShops.length;
  const activeTrials = allShops.filter(s => s.subscription?.plan?.includes('Trial') && s.daysRemaining > 0).length;
  const paidShops = allShops.filter(s => !s.subscription?.plan?.includes('Trial') && s.daysRemaining > 0).length;
  const totalRevenue = subscriptionsList.reduce((acc, sub) => acc + (sub.amount || 0), 0);

  res.json({
    success: true,
    stats: { totalShops, activeTrials, paidShops, totalRevenue },
    shops: allShops,
    subscriptions: subscriptionsList
  });
});

// Admin Manage Shop (Extend, Suspend, Activate, Delete)
app.post('/api/admin/shop-action', (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.body.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ success: false, error: 'Unauthorized Admin Access' });
  }

  const { slug, action } = req.body;
  if (!slug || !shops[slug]) {
    return res.status(404).json({ success: false, error: 'Shop not found' });
  }

  const shop = shops[slug];
  const now = new Date();

  if (action === 'extend_7') {
    const currentValid = (shop.subscription?.validUntil && new Date(shop.subscription.validUntil) > now) 
      ? new Date(shop.subscription.validUntil) 
      : now;
    const newValid = new Date(currentValid.getTime() + 7 * 24 * 60 * 60 * 1000);
    shop.subscription = {
      ...(shop.subscription || {}),
      plan: '7-Day Free Trial',
      status: 'active',
      validUntil: newValid.toISOString()
    };
    shop.status = 'online';
  } else if (action === 'extend_30') {
    const currentValid = (shop.subscription?.validUntil && new Date(shop.subscription.validUntil) > now) 
      ? new Date(shop.subscription.validUntil) 
      : now;
    const newValid = new Date(currentValid.getTime() + 30 * 24 * 60 * 60 * 1000);
    shop.subscription = {
      ...(shop.subscription || {}),
      plan: 'Monthly Plan',
      status: 'active',
      validUntil: newValid.toISOString()
    };
    shop.status = 'online';
  } else if (action === 'extend_365') {
    const currentValid = (shop.subscription?.validUntil && new Date(shop.subscription.validUntil) > now) 
      ? new Date(shop.subscription.validUntil) 
      : now;
    const newValid = new Date(currentValid.getTime() + 365 * 24 * 60 * 60 * 1000);
    shop.subscription = {
      ...(shop.subscription || {}),
      plan: 'Yearly Pro',
      status: 'active',
      validUntil: newValid.toISOString()
    };
    shop.status = 'online';
  } else if (action === 'suspend') {
    shop.status = 'suspended';
  } else if (action === 'activate') {
    shop.status = 'online';
    if (shop.subscription) shop.subscription.status = 'active';
  } else if (action === 'delete') {
    delete shops[slug];
  }

  saveShops(shops);
  res.json({ success: true, shop: shops[slug] });
});

// Admin Approve Subscription Payment (UTR Verification)
app.post('/api/admin/approve-utr', (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.body.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ success: false, error: 'Unauthorized Admin Access' });
  }

  const { utrIndex, slug } = req.body;
  if (typeof utrIndex === 'number' && subscriptionsList[utrIndex]) {
    const sub = subscriptionsList[utrIndex];
    sub.verifiedByAdmin = true;
    sub.verifiedAt = new Date().toISOString();
    
    const targetSlug = slug || sub.shopSlug;
    if (targetSlug && shops[targetSlug]) {
      const days = (sub.amount >= 1500) ? 365 : 30;
      const now = new Date();
      const currentValid = (shops[targetSlug].subscription?.validUntil && new Date(shops[targetSlug].subscription.validUntil) > now)
        ? new Date(shops[targetSlug].subscription.validUntil)
        : now;
      const newValid = new Date(currentValid.getTime() + days * 24 * 60 * 60 * 1000);
      shops[targetSlug].subscription = {
        plan: days === 365 ? 'Yearly Pro' : 'Monthly Pro',
        amount: sub.amount,
        utrNumber: sub.utrNumber,
        status: 'active',
        paidAt: now.toISOString(),
        validUntil: newValid.toISOString()
      };
      saveShops(shops);
    }
    saveSubscriptions(subscriptionsList);
    return res.json({ success: true, subscription: sub });
  }

  res.status(400).json({ success: false, error: 'Subscription entry not found.' });
});

// Update Shop details (name, city, upiId, phone, whatsapp, pricing) with instant JSON save
app.post('/api/shops/:shop_slug', (req, res) => {
  const slug = req.params.shop_slug.toLowerCase();
  if (!shops[slug]) {
    shops[slug] = {
      slug,
      name: slug.replace(/-/g, ' ').toUpperCase(),
      status: 'online',
      pricing: { bwSingle: 2, bwDouble: 3, colorSingle: 10, colorDouble: 15, legalMarkup: 1.5 }
    };
  }

  const { name, address, upiId, phone, whatsapp, pricing } = req.body;
  if (name) shops[slug].name = name;
  if (address) shops[slug].address = address;
  if (typeof upiId === 'string') shops[slug].upiId = upiId;
  if (phone) shops[slug].phone = phone;
  if (whatsapp) shops[slug].whatsapp = whatsapp;
  if (pricing) shops[slug].pricing = { ...shops[slug].pricing, ...pricing };
    if (req.body.autoDeleteTimer) shops[slug].autoDeleteTimer = req.body.autoDeleteTimer;

  saveShops(shops);
  console.log(`[Shop Config] Saved shop ${slug} to disk: Name="${shops[slug].name}", UPI="${shops[slug].upiId}"`);
  res.json({ success: true, shop: shops[slug] });
});

// Submit & Record Subscription Payment (Shopkeeper pays Admin) with instant JSON save
app.post('/api/subscriptions/:shop_slug', (req, res) => {
  const slug = req.params.shop_slug.toLowerCase();
  const { planName, amount, utrNumber, phone } = req.body;

  if (!shops[slug]) {
    shops[slug] = { slug };
  }

  const days = (amount >= 1500 || (planName && planName.toLowerCase().includes('yearly'))) ? 365 : 30;
  const now = new Date();
  const validUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const subRecord = {
    shopSlug: slug,
    shopName: shops[slug].name || slug,
    plan: planName || (days === 365 ? 'Yearly Pro' : 'Monthly Pro'),
    amount: amount || (days === 365 ? 1999 : 299),
    utrNumber: utrNumber || '',
    phone: phone || '',
    status: 'pending_verification',
    submittedAt: now.toISOString(),
    validUntil: validUntil.toISOString()
  };

  shops[slug].subscription = {
    plan: subRecord.plan,
    amount: subRecord.amount,
    utrNumber: subRecord.utrNumber,
    phone: subRecord.phone,
    status: 'active',
    paidAt: now.toISOString(),
    validUntil: validUntil.toISOString()
  };

  subscriptionsList.unshift(subRecord);
  saveSubscriptions(subscriptionsList);
  saveShops(shops);

  console.log(`[Subscription Payment Recorded] Shop ${slug}: â‚¹${subRecord.amount}, UTR: ${subRecord.utrNumber}`);
  res.json({ success: true, subscription: shops[slug].subscription });
});

// Toggle Station Online / Offline Status
app.post('/api/shops/:shop_slug/status', (req, res) => {
  const slug = req.params.shop_slug.toLowerCase();
  const { status } = req.body;

  if (!shops[slug]) {
    return res.status(404).json({ error: 'Shop not found' });
  }

  shops[slug].status = (status === 'offline') ? 'offline' : 'online';

  // Broadcast to shop room so all customers see live station status instantly
  iâœ…to(`shop_${slug}`).emit('station:status', {
    shopSlug: slug,
    status: shops[slug].status,
    timestamp: new Date().toISOString()
  });

  res.json({ success: true, shop: shops[slug] });
});

// Customer File Upload & Job Creation
app.post('/api/upload/:shop_slug', upload.single('file'), async (req, res) => {
  const slug = req.params.shop_slug.toLowerCase();
  const shop = shops[slug];

  if (!req.file) {
    return res.status(400).json({ error: 'Please choose a document to upload.' });
  }

  const uploadedFilePath = req.file.path;

  try {
    let totalPages = 1;
    const isPdf = req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf');

    if (isPdf && PDFDocument) {
      try {
        const fileBytes = fs.readFileSync(uploadedFilePath);
        const pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
        totalPages = pdfDoc.getPageCount() || 1;
      } catch (pdfErr) {
        // If password protected or inspect error, fallback to page count sent by client or 1
        console.warn('[PDF Inspection Warning]', pdfErr.message);
        totalPages = parseInt(req.body.clientPages, 10) || 1;
      }
    } else {
      // For images or fallback
      totalPages = parseInt(req.body.clientPages, 10) || 1;
    }

    // Extract print settings
    const copies = Math.max(1, parseInt(req.body.copies, 10) || 1);
    const colorMode = req.body.colorMode === 'color' ? 'color' : 'bw';
    const duplex = req.body.duplex === 'double' ? 'double' : 'single';
    const paperSize = req.body.paperSize === 'Legal' ? 'Legal' : 'A4';
    const paymentMode = req.body.paymentMode === 'upi' ? 'upi' : 'cash';

    // Pricing calculation
    const currentPricing = shop ? shop.pricing : {
      bwSingle: 2.0, bwDouble: 3.0, colorSingle: 10.0, colorDouble: 15.0, legalMarkup: 1.5
    };
    const calculation = calculateJobPrice({
      pages: totalPages,
      copies,
      colorMode,
      duplex,
      paperSize,
      pricing: currentPricing
    });

    const jobId = uuidv4();
    const token = getNextToken(slug);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RETENTION_MS);

    const job = {
      id: jobId,
      token,
      shopSlug: slug,
      fileName: req.file.originalname,
      storedFileName: req.file.filename,
      filePath: uploadedFilePath,
      fileSize: req.file.size,
      mimetype: req.file.mimetype,
      pages: totalPages,
      copies,
      colorMode,
      duplex,
      paperSize,
      paymentMode,
      paymentStatus: paymentMode === 'upi' ? 'paid' : 'pending',
      jobStatus: paymentMode === 'upi' ? 'queued' : 'waiting_cash', // 'waiting_cash' | 'queued' | 'printing' | 'completed' | 'cancelled'
      totalAmount: calculation.totalAmount,
      sheetsPerCopy: calculation.sheetsPerCopy,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      fileUrl: `/api/files/${req.file.filename}`
    };

    // Store in-memory
    jobs.set(jobId, job);

    // Multi-tenant WebSocket Routing: Dispatch new job to the specific shop's room
    iâœ…to(`shop_${slug}`).emit('job:new', job);

    console.log(`[New Job Queued] Token ${token} for shop '${slug}' - ${job.fileName} (${totalPages}p x ${copies}c) = â‚¹${job.totalAmount}`);

    res.status(201).json({
      success: true,
      message: 'Print job received successfully.',
      job
    });

  } catch (error) {
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      shredFile(uploadedFilePath);
    }
    console.error('[Upload Error]', error);
    res.status(500).json({ error: error.message || 'Internal server error while processing document.' });
  }
});

// List all active jobs for a shopkeeper's dashboard
app.get('/api/jobs/:shop_slug', (req, res) => {
  const slug = req.params.shop_slug.toLowerCase();
  const shopJobs = [];

  for (const job of jobs.values()) {
    if (job.shopSlug === slug && job.jobStatus !== 'cancelled') {
      shopJobs.push(job);
    }
  }

  // Sort descending by creation date (newest first)
  shopJobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ success: true, jobs: shopJobs });
});

// Get single job status (for customer tracking)
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or already purged' });
  }
  res.json({ success: true, job });
});

// Shopkeeper Action: "Collect & Print" for Cash Payment Approval
app.post('/api/jobs/:jobId/approve', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  job.paymentStatus = 'paid';
  job.jobStatus = 'printing';
  job.approvedAt = new Date().toISOString();

  // Notify shop dashboard and customer in real-time
  iâœ…to(`shop_${job.shopSlug}`).emit('job:updated', job);
  iâœ…to(`job_${job.id}`).emit('job:updated', job);

  console.log(`[Job Approved & Dispatched] Token ${job.token} - Cash collected, printing released.`);

  res.json({ success: true, message: 'Cash collected and print job approved.', job });
});

// Shopkeeper Action: Direct "Print" (already paid or re-printing)
app.post('/api/jobs/:jobId/print', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  job.jobStatus = 'printing';
  iâœ…to(`shop_${job.shopSlug}`).emit('job:updated', job);
  iâœ…to(`job_${job.id}`).emit('job:updated', job);

  res.json({ success: true, job });
});

// Shopkeeper Action: Mark Job Completed
app.post('/api/jobs/:jobId/complete', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  job.jobStatus = 'completed';
  job.completedAt = new Date().toISOString();

  // Zero-retention: clean file if requested or let it shred
  shredFile(job.filePath);
  job.filePath = null;

  iâœ…to(`shop_${job.shopSlug}`).emit('job:updated', job);
  iâœ…to(`job_${job.id}`).emit('job:updated', job);

  res.json({ success: true, message: 'Job marked completed and file securely shredded.', job });
});

// Shopkeeper Action: Cancel Job
app.post('/api/jobs/:jobId/cancel', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  job.jobStatus = 'cancelled';
  job.cancelledAt = new Date().toISOString();

  // Instant zero-retention shred
  shredFile(job.filePath);
  job.filePath = null;

  iâœ…to(`shop_${job.shopSlug}`).emit('job:updated', job);
  iâœ…to(`job_${job.id}`).emit('job:updated', job);

  console.log(`[Job Cancelled] Token ${job.token} cancelled and file deleted.`);

  res.json({ success: true, message: 'Job cancelled.', job });
});

// View / Download File for Printing
app.get('/api/files/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(UPLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or already purged under Zero-Retention Privacy policy.');
  }

  // Set appropriate headers so browsers display PDF in their built-in print viewer
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
  }

  res.sendFile(filePath);
});

// ---------------------------------------------------------------------
// REAL-TIME WEBSOCKET ROOM ENGINE
// ---------------------------------------------------------------------
iâœ…on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Shopkeeper joins multi-tenant shop room
  socket.on('shop:join', ({ shopSlug }) => {
    if (!shopSlug) return;
    const roomName = `shop_${shopSlug.toLowerCase()}`;
    socket.join(roomName);
    socket.shopSlug = shopSlug.toLowerCase();
    console.log(`[Dashboard Room] Socket ${socket.id} joined ${roomName}`);

    // Send current status of shop
    const shop = shops[socket.shopSlug];
    if (shop) {
      socket.emit('station:status', {
        shopSlug: socket.shopSlug,
        status: shop.status
      });
    }
  });

  // Customer tracks their specific job
  socket.on('job:watch', ({ jobId }) => {
    if (jobId) {
      socket.join(`job_${jobId}`);
      console.log(`[Customer Watch] Socket ${socket.id} watching job_${jobId}`);
    }
  });

  // Shopkeeper updates station online/offline status via socket
  socket.on('station:set_status', ({ shopSlug, status }) => {
    const slug = (shopSlug || socket.shopSlug || '').toLowerCase();
    if (shops[slug]) {
      shops[slug].status = status === 'offline' ? 'offline' : 'online';
      iâœ…to(`shop_${slug}`).emit('station:status', {
        shopSlug: slug,
        status: shops[slug].status
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ID: ${socket.id}`);
  });
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log('========================================================');
  console.log(`ðŸš€ PrintGoo Full-Stack SaaS Server Running on Port ${PORT}`);
  console.log(`ðŸ“± Customer Portal : http://localhost:${PORT}/q/patel-xerox`);
  console.log(`🖥️  Shop Dashboard  : http://localhost:${PORT}/dashboard/patel-xerox`);
  console.log(`ðŸ”’ Ephemeral Clean  : Active (Auto-purges files > 30 mins)`);
  console.log('========================================================');
});

module.exports = { app, server, io };


// ==========================================
// AUTO-DELETE PDF FILES BACKGROUND JOB
// ==========================================
setInterval(() => {
  const now = Date.now();
  let dbChanged = false;
  Object.values(shops).forEach(shop => {
    const timer = shop.autoDeleteTimer || 'never';
    if (timer === 'never') return;
    const msLimit = timer === '30m' ? 30 * 60 * 1000 : 60 * 60 * 1000;
    
    if (jobs[shop.slug]) {
      jobs[shop.slug].forEach(job => {
        // Auto-delete if it's completed or cancelled and older than the limit
        if ((job.status === 'completed' || job.status === 'cancelled') && !job.fileDeleted) {
           const jobAge = now - job.createdAt;
           if (jobAge > msLimit) {
              try { 
                fs.unlinkSync(path.join(__dirname, 'uploads', job.filename)); 
                console.log('[Auto-Delete] Deleted physical file ' + job.filename + ' for shop ' + shop.slug);
              } catch(e) {}
              job.fileDeleted = true; // Mark as deleted so we don't try again
              dbChanged = true;
           }
        }
      });
    }
  });
  if (dbChanged) saveJobs(jobs);
}, 2 * 60 * 1000); // Check every 2 mins


