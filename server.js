const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { mongoose, connectDatabase } = require('./db');

const app = express();

const config = {
  port: Number(process.env.PORT || 5000),
  jwtSecret: process.env.JWT_SECRET || '',
  masterUsername: process.env.MASTER_USERNAME || '',
  masterEmail: String(process.env.MASTER_EMAIL || '').trim().toLowerCase(),
  masterPassword: process.env.MASTER_PASSWORD || '',
  supermasterUsername: process.env.SUPERMASTER_USERNAME || 'admin',
  supermasterEmail: String(process.env.SUPERMASTER_EMAIL || 'supermaster@superwallet.local').trim().toLowerCase(),
  supermasterPassword: process.env.SUPERMASTER_PASSWORD || 'ChangeThisSuperMasterPassword123!',
  isProduction: process.env.NODE_ENV === 'production',
  bigBangApiKey: String(process.env.BIGBANG_API_KEY || '').trim(),
  bigBangWalletMode: String(process.env.BIGBANG_WALLET_MODE || 'disabled').trim().toLowerCase()
};

if (!config.jwtSecret) {
  throw new Error('JWT_SECRET is missing. Add it to the .env file before starting SuperWallet.');
}

if (config.isProduction && config.jwtSecret.includes('replace-this')) {
  throw new Error('Replace the example JWT_SECRET before using SuperWallet in production.');
}

app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

const BIGBANG_BASE = 'https://api.bigbangcasino.bet/api/v1';

async function bigBangRequest(endpoint, options = {}) {
  if (!config.bigBangApiKey) {
    throw errorWithStatus('BigBang API key is not configured. Add BIGBANG_API_KEY to .env.', 503);
  }
  const response = await fetch(BIGBANG_BASE + endpoint, {
    ...options,
    headers: {
      'X-API-Key': config.bigBangApiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok || payload.success === false) {
    const message = payload?.error?.message || `BigBang API request failed (${response.status}).`;
    throw errorWithStatus(message, response.status === 401 || response.status === 403 ? 502 : 502);
  }
  return payload;
}

const proofDir = path.join(__dirname, 'uploads', 'deposit-proofs');
fs.mkdirSync(proofDir, { recursive: true });
const proofStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, proofDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext) ? ext : '';
    cb(null, 'proof-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + safeExt);
  }
});
const proofUpload = multer({
  storage: proofStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      return cb(errorWithStatus('Proof must be JPG, PNG, WEBP or PDF.', 400));
    }
    cb(null, true);
  }
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.path === '/wallet/user' || req.path === '/wallet/balance') {
    const started = Date.now();
    res.on('finish', () => console.log(`[wallet-callback] ${req.method} ${req.path} status=${res.statusCode} ms=${Date.now() - started}`));
  }
  next();
});

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, minlength: 3, maxlength: 32, unique: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    password: { type: String, required: true, select: false },
    balance: { type: Number, default: 0, min: 0 },
    role: { type: String, enum: ['user', 'admin', 'superadmin'], default: 'user' },
    lastLoginAt: Date
  },
  { timestamps: true }
);

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'adjustment', 'game_bet', 'game_win', 'game_refund'], required: true },
    direction: { type: String, enum: ['credit', 'debit'], required: true },
    amount: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reference: { type: String, trim: true, maxlength: 100, default: '' },
    payoutDetails: { type: String, trim: true, maxlength: 160, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    reviewerNote: { type: String, trim: true, maxlength: 300, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    balanceAfter: Number,
    proofPath: { type: String, default: '' },
    proofOriginalName: { type: String, default: '' },
    proofMimeType: { type: String, default: '' },
    proofSize: { type: Number, default: 0 },
    provider: { type: String, default: '' },
    game: { type: String, default: '' },
    roundId: { type: String, default: '' },
    providerTransactionId: { type: String, default: '', index: true },
    currency: { type: String, default: 'INR' }
  },
  { timestamps: true }
);

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ providerTransactionId: 1 }, { unique: true, sparse: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Transaction =
  mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

function cleanText(value, maxLength = 160) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function cleanEmail(value) {
  return cleanText(value, 120).toLowerCase();
}

function cleanUsername(value) {
  return String(value || '').trim().slice(0, 32);
}

function internalEmailForUsername(username) {
  const safe = cleanUsername(username).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return `${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@local.superwallet`;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getCoinAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000000) {
    return null;
  }
  return amount;
}

function errorWithStatus(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    balance: user.balance,
    role: user.role,
    unlimited: user.role === 'superadmin',
    createdAt: user.createdAt
  };
}

function publicTransaction(transaction) {
  return {
    id: transaction._id.toString(),
    type: transaction.type,
    direction: transaction.direction,
    amount: transaction.amount,
    status: transaction.status,
    reference: transaction.reference,
    payoutDetails: transaction.payoutDetails,
    note: transaction.note,
    reviewerNote: transaction.reviewerNote,
    balanceAfter: transaction.balanceAfter,
    createdAt: transaction.createdAt,
    reviewedAt: transaction.reviewedAt,
    proofAvailable: Boolean(transaction.proofPath),
    proofOriginalName: transaction.proofOriginalName || '',
    proofMimeType: transaction.proofMimeType || ''
  };
}

function adminTransaction(transaction) {
  const user = transaction.user || {};
  return {
    ...publicTransaction(transaction),
    user: {
      id: user._id ? user._id.toString() : '',
      username: user.username || 'Unknown user'
    }
  };
}

function issueSession(user) {
  const token = jwt.sign(
    { sub: user._id.toString(), role: user.role },
    config.jwtSecret,
    { expiresIn: '12h' }
  );
  return { token, user: publicUser(user) };
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ message: 'Please log in to continue.' });
    }

    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ message: 'Your session is no longer valid.' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Master-admin access is required.' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ message: 'Super Master access is required.' });
  }
  next();
}

async function ensureSuperMaster() {
  const existing = await User.findOne({ username: config.supermasterUsername }).select('+password');
  if (existing) {
    let changed = false;
    if (existing.role !== 'superadmin') { existing.role = 'superadmin'; changed = true; }
    if (existing.username !== config.supermasterUsername) { existing.username = cleanText(config.supermasterUsername, 32); changed = true; }
    if (changed) { await existing.save(); console.log('Configured Admin account was updated.'); }
    return existing;
  }
  const password = await bcrypt.hash(config.supermasterPassword, 12);
  const user = await User.create({
    username: cleanText(config.supermasterUsername, 32),
    email: config.supermasterEmail || internalEmailForUsername(config.supermasterUsername),
    password,
    role: 'superadmin',
    balance: 0
  });
  console.log('Super Master account created.');
  return user;
}

async function pendingWithdrawalCoins(userId) {
  const result = await Transaction.aggregate([
    {
      $match: {
        user: new mongoose.Types.ObjectId(userId),
        type: 'withdrawal',
        status: 'pending'
      }
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  return result[0]?.total || 0;
}

function transactionDateFilter(query) {
  const filter = {};
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;

  if (from && !Number.isNaN(from.valueOf())) {
    filter.createdAt = { ...(filter.createdAt || {}), $gte: from };
  }
  if (to && !Number.isNaN(to.valueOf())) {
    to.setHours(23, 59, 59, 999);
    filter.createdAt = { ...(filter.createdAt || {}), $lte: to };
  }
  return filter;
}

async function ensureMasterAdmin() {
  if (!config.masterUsername || !config.masterPassword) {
    console.warn('Master admin was not created because MASTER_* values are missing in .env.');
    return;
  }

  const existing = await User.findOne({ username: config.masterUsername }).select('+password');
  if (existing) {
    let changed = false;
    if (existing.role !== 'admin') { existing.role = 'admin'; changed = true; }
    if (existing.username !== config.masterUsername) { existing.username = cleanText(config.masterUsername, 32); changed = true; }
    if (changed) { await existing.save(); console.log('Configured Master account was updated.'); }
    return;
  }

  const password = await bcrypt.hash(config.masterPassword, 12);
  await User.create({
    username: cleanText(config.masterUsername, 32),
    email: config.masterEmail || internalEmailForUsername(config.masterUsername),
    password,
    role: 'admin'
  });
  console.log('Master admin account created.');
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/client/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/master', (req, res) => {
  res.sendFile(path.join(__dirname, 'master.html'));
});

app.get('/supermaster', (req, res) => {
  res.sendFile(path.join(__dirname, 'supermaster.html'));
});

// Friendly URL for the top-level Admin panel.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'supermaster.html'));
});

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-login.html'));
});

app.get('/master/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'master-login.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'SuperWallet' });
});

app.post('/api/auth/signup', (_req, res) => {
  res.status(403).json({ message: 'Customer self-signup is disabled. Only Master or Admin can create customer IDs.' });
});

function providerSignature(payload) {
  const base = String(payload.username ?? '') + String(payload.amount ?? '') + String(payload.game ?? '') + String(payload.game_category ?? '') + String(payload.transaction_id ?? '');
  return crypto.createHmac('sha256', config.bigBangApiKey).update(base).digest('hex');
}
function providerWalletEnabled() { return Boolean(config.bigBangApiKey && config.bigBangWalletMode === 'seamless'); }
app.get('/wallet/user', async (req, res, next) => {
  try {
    if (!providerWalletEnabled()) return res.status(503).json({ error: 'Seamless wallet is not enabled.' });
    const username = cleanUsername(req.query.username);
    const user = await User.findOne({ username, role: 'user' });
    if (!user) return res.status(404).json({ error: 'unknown user' });
    res.json({ username, balance: Number(user.balance).toFixed(2), Username: username, Balance: Number(user.balance), currency: 'INR' });
  } catch (error) { next(error); }
});
app.post('/wallet/balance', async (req, res, next) => {
  try {
    if (!providerWalletEnabled()) return res.status(503).json({ error: 'Seamless wallet is not enabled.' });
    const payload = req.body || {};
    const expected = providerSignature(payload);
    const provided = String(payload.signature || '');
    if (!provided || provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return res.status(401).json({ error: 'bad signature' });
    if (payload.sandbox) return res.json({ status: 'ok', balance: '100000.00' });
    const providerTransactionId = cleanText(payload.transaction_id, 160);
    const username = cleanUsername(payload.username);
    const amount = Number(payload.amount);
    if (!providerTransactionId || !username || !Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'invalid wallet movement' });
    const duplicate = await Transaction.findOne({ providerTransactionId });
    if (duplicate) return res.json({ status: 'ok', balance: Number(duplicate.balanceAfter || 0).toFixed(2), duplicate: true });
    const user = await User.findOne({ username, role: 'user' });
    if (!user) return res.status(404).json({ error: 'unknown user' });
    const roundedAmount = Math.round(amount * 100) / 100;
    const nextBalance = Math.round((Number(user.balance) + roundedAmount) * 100) / 100;
    if (nextBalance < 0) return res.status(400).json({ error: 'insufficient balance', balance: Number(user.balance).toFixed(2) });
    const updated = await User.findOneAndUpdate({ _id: user._id, balance: user.balance }, { $set: { balance: nextBalance } }, { new: true });
    if (!updated) return res.status(409).json({ error: 'balance changed, retry movement' });
    const type = payload.type === 'refund' ? 'game_refund' : roundedAmount < 0 ? 'game_bet' : 'game_win';
    try {
      await Transaction.create({ user: updated._id, type, direction: roundedAmount < 0 ? 'debit' : 'credit', amount: Math.abs(roundedAmount), status: 'approved', balanceAfter: updated.balance, provider: 'bigbang', game: cleanText(payload.game, 160), roundId: cleanText(payload.round_id, 160), providerTransactionId, currency: 'INR', note: `Provider ${payload.type || 'round'} settlement` });
    } catch (error) {
      await User.findByIdAndUpdate(updated._id, { $set: { balance: user.balance } });
      if (error?.code === 11000) { const row = await Transaction.findOne({ providerTransactionId }); return res.json({ status: 'ok', balance: Number(row?.balanceAfter || user.balance).toFixed(2), duplicate: true }); }
      throw error;
    }
    res.json({ status: 'ok', balance: Number(updated.balance).toFixed(2), Balance: Number(updated.balance) });
  } catch (error) { next(error); }
});

app.get('/api/games/catalog', requireAuth, async (req, res, next) => {
  try {
    const search = cleanText(req.query.search || '', 80);
    const provider = cleanText(req.query.provider || '', 80);
    const mode = ['standard', 'premium'].includes(String(req.query.mode || '').toLowerCase()) ? String(req.query.mode).toLowerCase() : 'standard';
    const params = new URLSearchParams({ type: mode, limit: '120' });
    if (search) params.set('search', search);
    if (provider) params.set('provider', provider);
    const payload = await bigBangRequest('/games?' + params.toString());
    res.json({ games: payload.data || [], pagination: payload.pagination || {} });
  } catch (error) { next(error); }
});

app.post('/api/games/launch-demo', requireAuth, async (req, res, next) => {
  try {
    const gameId = Number(req.body?.gameId);
    if (!Number.isInteger(gameId) || gameId < 1) {
      throw errorWithStatus('A valid game ID is required.', 400);
    }
    // Demo mode only: no SuperWallet balance or betting settlement is connected.
    const payload = await bigBangRequest('/games/launch', {
      method: 'POST',
      body: JSON.stringify({ game_id: gameId, demo: true, language: 'en', return_url: `${req.protocol}://${req.get('host')}/` })
    });
    res.json({ gameUrl: payload.data?.game_url || payload.game_url || '', gameName: payload.data?.game_name || payload.game_name || 'Game' });
  } catch (error) { next(error); }
});

app.post('/api/games/launch', requireAuth, async (req, res, next) => {
  try {
    if (!providerWalletEnabled()) throw errorWithStatus('Live games are disabled until BIGBANG_API_KEY and BIGBANG_WALLET_MODE=seamless are configured.', 503);
    const gameId = Number(req.body?.gameId);
    if (!Number.isInteger(gameId) || gameId < 1) throw errorWithStatus('A valid game ID is required.', 400);
    await bigBangRequest('/users/create', { method: 'POST', body: JSON.stringify({ user_token: req.user.username, username: req.user.username, country: 'IN' }) });
    const payload = await bigBangRequest('/games/launch', { method: 'POST', body: JSON.stringify({ game_id: gameId, user_token: req.user.username, demo: false, language: 'en', return_url: `${req.protocol}://${req.get('host')}/` }) });
    res.json({ gameUrl: payload.data?.game_url || payload.game_url || '', gameName: payload.data?.game_name || payload.game_name || 'Game', mode: 'live' });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 32);
    const password = String(req.body.password || '');
    const user = await User.findOne({ username }).select('+password');

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw errorWithStatus('Username or password is incorrect.', 401);
    }

    user.lastLoginAt = new Date();
    await user.save();
    const session = issueSession(user);
    res.json({ message: 'Welcome back, ' + user.username + '!', ...session });
  } catch (error) {
    next(error);
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/wallet', requireAuth, async (req, res, next) => {
  try {
    const pendingWithdrawals = await pendingWithdrawalCoins(req.user._id);
    res.json({
      balance: req.user.balance,
      pendingWithdrawals,
      availableBalance: Math.max(req.user.balance - pendingWithdrawals, 0)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/wallet/transactions', requireAuth, async (req, res, next) => {
  try {
    const transactions = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ transactions: transactions.map(publicTransaction) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/wallet/requests', requireAuth, proofUpload.single('proof'), async (req, res, next) => {
  try {
    const type = cleanText(req.body.type, 20);
    const amount = getCoinAmount(req.body.amount);
    const reference = cleanText(req.body.reference, 100);
    const payoutDetails = cleanText(req.body.payoutDetails, 160);
    const note = cleanText(req.body.note, 300);

    if (!['deposit', 'withdrawal'].includes(type)) {
      throw errorWithStatus('Choose either a deposit or a withdrawal request.');
    }
    if (!amount) {
      throw errorWithStatus('Enter a whole-number coin amount between 1 and 10,000,000.');
    }
    if (type === 'deposit' && reference.length < 4) {
      throw errorWithStatus('Add the payment reference or UTR number for this deposit.');
    }
    if (type === 'deposit' && !req.file) {
      throw errorWithStatus('Upload the payment proof for this deposit.');
    }
    if (type === 'withdrawal' && req.file) {
      throw errorWithStatus('Proof upload is only required for deposits.');
    }
    if (type === 'withdrawal' && payoutDetails.length < 3) {
      throw errorWithStatus('Add the UPI ID or payout details for this withdrawal.');
    }

    if (type === 'withdrawal') {
      const pending = await pendingWithdrawalCoins(req.user._id);
      const available = req.user.balance - pending;
      if (amount > available) {
        throw errorWithStatus(
          'You can request up to ' + Math.max(available, 0) + ' coins after pending withdrawals.',
          422
        );
      }
    }

    const transaction = await Transaction.create({
      user: req.user._id,
      type,
      direction: type === 'deposit' ? 'credit' : 'debit',
      amount,
      status: 'pending',
      reference,
      payoutDetails,
      note,
      proofPath: type === 'deposit' && req.file ? req.file.path : '',
      proofOriginalName: type === 'deposit' && req.file ? cleanText(req.file.originalname, 180) : '',
      proofMimeType: type === 'deposit' && req.file ? req.file.mimetype : '',
      proofSize: type === 'deposit' && req.file ? req.file.size : 0
    });

    res.status(201).json({
      message: 'Your request was sent to the master admin for review.',
      transaction: publicTransaction(transaction)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/transactions/:id/proof', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw errorWithStatus('This transaction ID is not valid.');
    }
    const transaction = await Transaction.findById(req.params.id).select('type proofPath proofOriginalName proofMimeType');
    if (!transaction || transaction.type !== 'deposit' || !transaction.proofPath) {
      throw errorWithStatus('Payment proof was not found.', 404);
    }
    if (!fs.existsSync(transaction.proofPath)) {
      throw errorWithStatus('Payment proof file is missing from the server.', 404);
    }
    res.setHeader('Content-Type', transaction.proofMimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(transaction.proofOriginalName || 'payment-proof').replace(/[^a-zA-Z0-9._-]/g, '_') + '"');
    return res.sendFile(path.resolve(transaction.proofPath));
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/summary', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [userCount, pendingCount, pendingWithdrawals, approvedTotals] = await Promise.all([
      User.countDocuments({ role: 'user' }),
      Transaction.countDocuments({ status: 'pending' }),
      Transaction.aggregate([
        { $match: { status: 'pending', type: 'withdrawal' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { status: 'approved' } },
        { $group: { _id: '$direction', total: { $sum: '$amount' } } }
      ])
    ]);

    const credits = approvedTotals.find((item) => item._id === 'credit')?.total || 0;
    const debits = approvedTotals.find((item) => item._id === 'debit')?.total || 0;
    res.json({
      userCount,
      pendingCount,
      pendingWithdrawalCoins: pendingWithdrawals[0]?.total || 0,
      issuedCoins: credits - debits,
      masterBalance: req.user.balance
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/transactions', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const filter = transactionDateFilter(req.query);
    const status = cleanText(req.query.status, 20);
    const search = cleanText(req.query.search, 100).toLowerCase();
    const requestedLimit = Number(req.query.limit || 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
      : 100;

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      filter.status = status;
    }

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'username');

    const filtered = search
      ? transactions.filter((transaction) => {
          const user = transaction.user || {};
          const haystack = [
            user.username,
            transaction.type,
            transaction.reference,
            transaction.note
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(search);
        })
      : transactions;

    res.json({ transactions: filtered.map(adminTransaction) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const search = cleanText(req.query.search, 100);
    const filter = { role: { $in: ['user', 'admin'] } };
    if (search) {
      filter.username = { $regex: search, $options: 'i' };
    }
    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .select('username balance role createdAt');

    res.json({ users: users.map(publicUser) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/reports', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const range = transactionDateFilter(req.query);
    const [byStatus, approvedByType, userCount] = await Promise.all([
      Transaction.aggregate([
        { $match: range },
        { $group: { _id: '$status', count: { $sum: 1 }, coins: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { ...range, status: 'approved' } },
        { $group: { _id: '$type', count: { $sum: 1 }, coins: { $sum: '$amount' } } }
      ]),
      User.countDocuments({})
    ]);

    const getTotal = (items, key, field) =>
      items.find((item) => item._id === key)?.[field] || 0;

    res.json({
      users: userCount,
      requests: {
        pending: getTotal(byStatus, 'pending', 'count'),
        approved: getTotal(byStatus, 'approved', 'count'),
        rejected: getTotal(byStatus, 'rejected', 'count')
      },
      approvedCoins: {
        deposits: getTotal(approvedByType, 'deposit', 'coins'),
        withdrawals: getTotal(approvedByType, 'withdrawal', 'coins'),
        adjustments: getTotal(approvedByType, 'adjustment', 'coins')
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/wallet', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    res.json({ balance: req.user.balance, role: req.user.role, username: req.user.username });
  } catch (error) { next(error); }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || '');
    const initialBalance = Number(req.body.initialBalance || 0);

    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw errorWithStatus('Username must be 3-32 characters and use only letters, numbers, dot, underscore or hyphen.');
    if (password.length < 8) throw errorWithStatus('Password must have at least 8 characters.');
    if (!Number.isSafeInteger(initialBalance) || initialBalance < 0 || initialBalance > 1000000000) {
      throw errorWithStatus('Initial coins must be a whole number between 0 and 1,000,000,000.');
    }
    if (await User.exists({ username })) throw errorWithStatus('That username is already in use.', 409);
    if (initialBalance > req.user.balance) throw errorWithStatus('Master does not have enough coins for this starting balance.', 422);

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await User.create({ username, email: internalEmailForUsername(username), password: hashedPassword, role: 'user', balance: 0 });

    if (initialBalance > 0) {
      const debitedMaster = await User.findOneAndUpdate(
        { _id: req.user._id, balance: { $gte: initialBalance } },
        { $inc: { balance: -initialBalance } },
        { new: true }
      );
      if (!debitedMaster) {
        await User.deleteOne({ _id: user._id });
        throw errorWithStatus('Master does not have enough coins for this starting balance.', 422);
      }
      const creditedUser = await User.findByIdAndUpdate(user._id, { $inc: { balance: initialBalance } }, { new: true });
      await Transaction.create({
        user: user._id, type: 'deposit', direction: 'credit', amount: initialBalance, status: 'approved',
        note: 'Initial coins assigned by master while creating account', reviewerNote: 'Master account creation',
        reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: creditedUser.balance
      });
      await Transaction.create({
        user: req.user._id, type: 'adjustment', direction: 'debit', amount: initialBalance, status: 'approved',
        note: 'Coins transferred to newly created customer ' + username, reviewerNote: 'Master-to-customer transfer',
        reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: debitedMaster.balance
      });
    }

    res.status(201).json({ message: 'Customer account created successfully.', user: publicUser(await User.findById(user._id)) });
  } catch (error) { next(error); }
});

app.post('/api/admin/customer-transfer', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const amount = getCoinAmount(req.body.amount);
    const direction = cleanText(req.body.direction, 10);
    const note = cleanText(req.body.note, 300);
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username) || !amount || !['credit', 'debit'].includes(direction)) {
      throw errorWithStatus('Enter a valid customer username, coin amount, and transfer type.');
    }
    if (note.length < 3) throw errorWithStatus('Write a short reason for every coin transfer.');
    const customer = await User.findOne({ username, role: 'user' });
    if (!customer) throw errorWithStatus('Customer account was not found.', 404);

    if (direction === 'credit') {
      const master = await User.findOneAndUpdate(
        { _id: req.user._id, balance: { $gte: amount } },
        { $inc: { balance: -amount } }, { new: true }
      );
      if (!master) throw errorWithStatus('Master does not have enough coins.', 422);
      const updatedCustomer = await User.findByIdAndUpdate(customer._id, { $inc: { balance: amount } }, { new: true });
      if (!updatedCustomer) {
        await User.findByIdAndUpdate(req.user._id, { $inc: { balance: amount } });
        throw errorWithStatus('Customer balance update failed. No coins were moved.', 500);
      }
      await Transaction.create({ user: customer._id, type: 'adjustment', direction: 'credit', amount, status: 'approved', note, reviewerNote: 'Master credit to customer', reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: updatedCustomer.balance });
      await Transaction.create({ user: req.user._id, type: 'adjustment', direction: 'debit', amount, status: 'approved', note: 'Transfer to customer ' + username + ': ' + note, reviewerNote: 'Master transfer out', reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: master.balance });
      return res.json({ message: 'Coins added to customer.', customer: publicUser(updatedCustomer), masterBalance: master.balance });
    }

    const updatedCustomer = await User.findOneAndUpdate(
      { _id: customer._id, balance: { $gte: amount } },
      { $inc: { balance: -amount } }, { new: true }
    );
    if (!updatedCustomer) throw errorWithStatus('Customer does not have enough coins.', 422);
    const master = await User.findByIdAndUpdate(req.user._id, { $inc: { balance: amount } }, { new: true });
    await Transaction.create({ user: customer._id, type: 'adjustment', direction: 'debit', amount, status: 'approved', note, reviewerNote: 'Master withdrawal from customer', reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: updatedCustomer.balance });
    await Transaction.create({ user: req.user._id, type: 'adjustment', direction: 'credit', amount, status: 'approved', note: 'Received from customer ' + username + ': ' + note, reviewerNote: 'Master transfer in', reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: master.balance });
    res.json({ message: 'Coins withdrawn from customer and returned to master.', customer: publicUser(updatedCustomer), masterBalance: master.balance });
  } catch (error) { next(error); }
});

app.post('/api/superadmin/users', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || '');
    const initialBalance = Number(req.body.initialBalance || 0);
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw errorWithStatus('Username must be 3-32 characters and use only letters, numbers, dot, underscore or hyphen.');
    if (password.length < 8) throw errorWithStatus('Password must have at least 8 characters.');
    if (!Number.isSafeInteger(initialBalance) || initialBalance < 0 || initialBalance > 1000000000) throw errorWithStatus('Initial coins must be a whole number between 0 and 1,000,000,000.');
    if (await User.exists({ username })) throw errorWithStatus('That username is already in use.', 409);
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await User.create({ username, email: internalEmailForUsername(username), password: hashedPassword, role: 'user', balance: initialBalance });
    if (initialBalance > 0) {
      await Transaction.create({
        user: user._id, type: 'adjustment', direction: 'credit', amount: initialBalance, status: 'approved',
        note: 'Initial coins assigned by Admin while creating customer ID', reviewerNote: 'Admin customer creation',
        reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: initialBalance
      });
    }
    res.status(201).json({ message: 'Customer ID created successfully.', user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/superadmin/master-transfer', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    const direction = cleanText(req.body.direction, 10);
    const note = cleanText(req.body.note, 300);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000000) throw errorWithStatus('Enter a whole-number coin amount between 1 and 1,000,000,000,000.');
    if (!['credit', 'debit'].includes(direction)) throw errorWithStatus('Choose credit or debit.');
    if (note.length < 3) throw errorWithStatus('Write a short reason for the Super Master transfer.');
    const master = await User.findOne({ username: config.masterUsername, role: 'admin' });
    if (!master) throw errorWithStatus('Configured master account was not found.', 404);
    const updated = direction === 'credit'
      ? await User.findByIdAndUpdate(master._id, { $inc: { balance: amount } }, { new: true })
      : await User.findOneAndUpdate({ _id: master._id, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { new: true });
    if (!updated) throw errorWithStatus('Master does not have enough coins for that debit.', 422);
    await Transaction.create({ user: master._id, type: 'adjustment', direction, amount, status: 'approved', note, reviewerNote: 'Super Master transfer', reviewedBy: req.user._id, reviewedAt: new Date(), balanceAfter: updated.balance });
    res.json({ message: direction === 'credit' ? 'Coins added to Master.' : 'Coins removed from Master.', master: publicUser(updated) });
  } catch (error) { next(error); }
});


app.get('/api/superadmin/user-management', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const search = cleanText(req.query.search, 100);
    const filter = { role: 'user' };
    if (search) {
      filter.username = { $regex: search, $options: 'i' };
    }

    const customers = await User.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .select('username balance role createdAt');

    const ids = customers.map((u) => u._id);
    const movementRows = ids.length
      ? await Transaction.aggregate([
          {
            $match: {
              user: { $in: ids },
              type: 'adjustment',
              status: 'approved',
              reviewerNote: { $in: ['Master credit to customer', 'Master withdrawal from customer'] }
            }
          },
          {
            $group: {
              _id: { user: '$user', reviewerNote: '$reviewerNote' },
              amount: { $sum: '$amount' }
            }
          }
        ])
      : [];

    const movementMap = new Map();
    for (const row of movementRows) {
      const id = row._id.user.toString();
      const item = movementMap.get(id) || { credit: 0, debit: 0 };
      if (row._id.reviewerNote === 'Master credit to customer') item.credit += row.amount;
      if (row._id.reviewerNote === 'Master withdrawal from customer') item.debit += row.amount;
      movementMap.set(id, item);
    }

    const rows = customers.map((customer, index) => {
      const movement = movementMap.get(customer._id.toString()) || { credit: 0, debit: 0 };
      // Generic credit-ledger P/L: customer debit/outflow is positive for the upline;
      // customer credit/inflow is negative for the upline.
      const uplinePL = movement.debit - movement.credit;
      const pointsWL = -uplinePL;
      return {
        id: customer._id.toString(),
        serial: index + 1,
        username: customer.username,
        email: customer.email,
        type: 'User',
        balance: customer.balance,
        downlineBalance: 0,
        pointsWL,
        uplinePL,
        bonusRedeemed: 0,
        affCommission: 0,
        expenses: 0,
        createdAt: customer.createdAt
      };
    });

    const totals = rows.reduce((acc, row) => {
      acc.availableBalance += row.balance;
      acc.downlineBalance += row.downlineBalance;
      acc.pointsWL += row.pointsWL;
      acc.uplinePL += row.uplinePL;
      acc.bonusRedeemed += row.bonusRedeemed;
      acc.affCommission += row.affCommission;
      acc.expenses += row.expenses;
      return acc;
    }, { availableBalance: 0, downlineBalance: 0, pointsWL: 0, uplinePL: 0, bonusRedeemed: 0, affCommission: 0, expenses: 0 });

    res.json({ rows, totals, count: rows.length });
  } catch (error) {
    next(error);
  }
});

app.get('/api/superadmin/transactions', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const master = await User.findOne({ username: config.masterUsername, role: 'admin' }).select('_id');
    if (!master) return res.json({ transactions: [] });
    const transactions = await Transaction.find({ user: master._id }).sort({ createdAt: -1 }).limit(500).populate('user', 'username');
    res.json({ transactions: transactions.map(adminTransaction) });
  } catch (error) { next(error); }
});

app.get('/api/superadmin/summary', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const [master, userCount, pending, customerCoins] = await Promise.all([
      User.findOne({ username: config.masterUsername, role: 'admin' }).select('username balance'),
      User.countDocuments({ role: 'user' }),
      Transaction.countDocuments({ status: 'pending' }),
      User.aggregate([
        { $match: { role: 'user' } },
        { $group: { _id: null, total: { $sum: '$balance' } } }
      ])
    ]);
    res.json({ unlimited: true, master: master ? publicUser(master) : null, userCount, pending, customerCoins: customerCoins[0]?.total || 0 });
  } catch (error) { next(error); }
});


app.post('/api/admin/change-password', requireAuth, (req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ message: 'Staff access is required.' });
  next();
}, async (req, res, next) => {
  try {
    const oldPassword = String(req.body.oldPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 8) throw errorWithStatus('New password must have at least 8 characters.');
    const user = await User.findById(req.user._id).select('+password');
    if (!user || !(await bcrypt.compare(oldPassword, user.password))) throw errorWithStatus('Current password is incorrect.', 401);
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: 'Master password changed successfully.' });
  } catch (error) { next(error); }
});

app.patch('/api/admin/transactions/:id/review', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const action = cleanText(req.body.action, 10);
    const reviewerNote = cleanText(req.body.reviewerNote, 300);

    if (!mongoose.isValidObjectId(id)) {
      throw errorWithStatus('This request ID is not valid.');
    }
    if (!['approve', 'reject'].includes(action)) {
      throw errorWithStatus('Choose approve or reject.');
    }

    const transaction = await Transaction.findOne({ _id: id, status: 'pending' });
    if (!transaction) {
      throw errorWithStatus('This request has already been reviewed.', 409);
    }

    if (action === 'reject') {
      transaction.status = 'rejected';
      transaction.reviewerNote = reviewerNote || 'Rejected by master admin';
      transaction.reviewedBy = req.user._id;
      transaction.reviewedAt = new Date();
      await transaction.save();
      return res.json({ message: 'Request rejected. No coins were moved.' });
    }

    if (transaction.type !== 'deposit' && transaction.type !== 'withdrawal') {
      throw errorWithStatus('Only deposit and withdrawal requests can be reviewed.');
    }
    const customer = await User.findById(transaction.user);
    if (!customer || customer.role !== 'user') throw errorWithStatus('Customer account was not found.', 404);
    let updatedUser;
    let masterAfter;
    if (transaction.type === 'deposit') {
      const master = await User.findOneAndUpdate(
        { _id: req.user._id, balance: { $gte: transaction.amount } },
        { $inc: { balance: -transaction.amount } }, { new: true }
      );
      if (!master) {
        transaction.status = 'rejected';
        transaction.reviewerNote = 'Rejected: master does not have enough coins.';
        transaction.reviewedBy = req.user._id;
        transaction.reviewedAt = new Date();
        await transaction.save();
        throw errorWithStatus('Master does not have enough coins to approve this deposit.', 422);
      }
      updatedUser = await User.findByIdAndUpdate(customer._id, { $inc: { balance: transaction.amount } }, { new: true });
      masterAfter = master.balance;
      if (!updatedUser) {
        await User.findByIdAndUpdate(req.user._id, { $inc: { balance: transaction.amount } });
        throw errorWithStatus('Customer balance update failed. No coins were moved.', 500);
      }
    } else {
      updatedUser = await User.findOneAndUpdate(
        { _id: customer._id, balance: { $gte: transaction.amount } },
        { $inc: { balance: -transaction.amount } }, { new: true }
      );
      if (!updatedUser) {
        transaction.status = 'rejected';
        transaction.reviewerNote = 'Rejected: customer does not have enough coins.';
        transaction.reviewedBy = req.user._id;
        transaction.reviewedAt = new Date();
        await transaction.save();
        throw errorWithStatus('Customer does not have enough coins for this withdrawal.', 422);
      }
      const master = await User.findByIdAndUpdate(req.user._id, { $inc: { balance: transaction.amount } }, { new: true });
      masterAfter = master.balance;
    }

    transaction.status = 'approved';
    transaction.reviewerNote = reviewerNote || 'Approved by master admin';
    transaction.reviewedBy = req.user._id;
    transaction.reviewedAt = new Date();
    transaction.balanceAfter = updatedUser.balance;
    await transaction.save();
    await Transaction.create({
      user: req.user._id,
      type: 'adjustment',
      direction: transaction.type === 'deposit' ? 'debit' : 'credit',
      amount: transaction.amount,
      status: 'approved',
      note: 'Counter-entry for customer ' + customer.username + ' request ' + transaction.type,
      reviewerNote: 'Master request settlement',
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      balanceAfter: masterAfter
    });

    res.json({
      message: 'Request approved and the wallet balance was updated.',
      transaction: publicTransaction(transaction)
    });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ message: 'This page or API route does not exist.' });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'Proof file must be 5 MB or smaller.' });
    return res.status(400).json({ message: 'Payment proof upload failed.' });
  }
  if (error.name === 'ValidationError') {
    return res.status(400).json({ message: 'Please check the information you entered.' });
  }
  if (error.code === 11000) {
    return res.status(409).json({ message: 'That username is already in use.' });
  }
  return res.status(error.status || 500).json({
    message: error.status ? error.message : 'Something went wrong. Please try again.'
  });
});

async function startServer() {
  await connectDatabase();
  await ensureSuperMaster();
  await ensureMasterAdmin();
  app.listen(config.port, '0.0.0.0', () => {
    console.log('SuperWallet is running at http://localhost:' + config.port);
  });
}

startServer().catch((error) => {
  console.error('SuperWallet could not start:', error.message);
  process.exit(1);
});
