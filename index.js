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

// In-Memory Multi-Tenant Store with default seed shops
const shops = {
  'gamara-enterprises': {
    name: 'GAMARA ENTERPRISES',
    slug: 'gamara-enterprises',
    ownerName: 'Gamara',
    address: 'Main Bazar, Radhanpur',
    phone: '+91 99095 77877',
    upiId: 'bmgamara@ybl',
    status: 'online', // 'online' | 'offline'
    pricing: {
      bwSingle: 2.0,     // ₹2 / page
      bwDouble: 3.0,     // ₹3 / sheet (2 pages)
      colorSingle: 10.0, // ₹10 / page
      colorDouble: 15.0, // ₹15 / sheet
      legalMarkup: 1.5   // extra ₹1.5 per sheet for Legal
    }
  },
  'demo': {
    name: 'PrintGoo Smart Print Station',
    slug: 'demo',
    ownerName: 'PrintGoo Counter',
    address: 'Station Road Counter #1',
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
  }
};

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

// Update Shop details (name, city, upiId, phone, whatsapp, pricing)
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
  if (upiId) shops[slug].upiId = upiId;
  if (phone) shops[slug].phone = phone;
  if (whatsapp) shops[slug].whatsapp = whatsapp;
  if (pricing) shops[slug].pricing = { ...shops[slug].pricing, ...pricing };

  console.log(`[Shop Config] Updated shop ${slug}: Name="${shops[slug].name}", UPI="${shops[slug].upiId}"`);
  res.json({ success: true, shop: shops[slug] });
});

// Submit & Record Subscription Payment (Shopkeeper pays Admin)
app.post('/api/subscriptions/:shop_slug', (req, res) => {
  const slug = req.params.shop_slug.toLowerCase();
  const { planName, amount, utrNumber, phone } = req.body;

  if (!shops[slug]) {
    shops[slug] = { slug };
  }

  const days = (amount >= 1500 || (planName && planName.toLowerCase().includes('yearly'))) ? 365 : 30;
  const now = new Date();
  const validUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  shops[slug].subscription = {
    plan: planName || (days === 365 ? 'Yearly Pro' : 'Monthly Pro'),
    amount: amount || (days === 365 ? 1999 : 299),
    utrNumber: utrNumber || '',
    phone: phone || '',
    status: 'active',
    paidAt: now.toISOString(),
    validUntil: validUntil.toISOString()
  };

  console.log(`[Subscription Activated] Shop ${slug} activated plan "${shops[slug].subscription.plan}" until ${validUntil.toDateString()}`);
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
  io.to(`shop_${slug}`).emit('station:status', {
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
    io.to(`shop_${slug}`).emit('job:new', job);

    console.log(`[New Job Queued] Token ${token} for shop '${slug}' - ${job.fileName} (${totalPages}p x ${copies}c) = ₹${job.totalAmount}`);

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
  io.to(`shop_${job.shopSlug}`).emit('job:updated', job);
  io.to(`job_${job.id}`).emit('job:updated', job);

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
  io.to(`shop_${job.shopSlug}`).emit('job:updated', job);
  io.to(`job_${job.id}`).emit('job:updated', job);

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

  io.to(`shop_${job.shopSlug}`).emit('job:updated', job);
  io.to(`job_${job.id}`).emit('job:updated', job);

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

  io.to(`shop_${job.shopSlug}`).emit('job:updated', job);
  io.to(`job_${job.id}`).emit('job:updated', job);

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
io.on('connection', (socket) => {
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
      io.to(`shop_${slug}`).emit('station:status', {
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
  console.log(`🚀 PrintGoo Full-Stack SaaS Server Running on Port ${PORT}`);
  console.log(`📱 Customer Portal : http://localhost:${PORT}/q/patel-xerox`);
  console.log(`🖥️  Shop Dashboard  : http://localhost:${PORT}/dashboard/patel-xerox`);
  console.log(`🔒 Ephemeral Clean  : Active (Auto-purges files > 30 mins)`);
  console.log('========================================================');
});

module.exports = { app, server, io };
