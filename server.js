const { 
  default: makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware configuration
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4000;
const API_SECRET = process.env.WA_API_SECRET || 'my_wa_secret_key_123';
const FBDB_URL = process.env.FBDB_URL ? process.env.FBDB_URL.replace(/\/$/, '') : null;

let sock;
let isConnected = false;

// ----------------------------------------------------
// FIREBASE REST API HELPERS (PUT, GET, DELETE)
// ----------------------------------------------------
async function dbPut(pathData, data) {
  if (!FBDB_URL) throw new Error('FBDB_URL process.env missing');
  return axios.put(`${FBDB_URL}/${pathData}.json`, data);
}

async function dbGet(pathData) {
  if (!FBDB_URL) throw new Error('FBDB_URL process.env missing');
  const res = await axios.get(`${FBDB_URL}/${pathData}.json`);
  return res.data;
}

async function dbDelete(pathData) {
  if (!FBDB_URL) throw new Error('FBDB_URL process.env missing');
  return axios.delete(`${FBDB_URL}/${pathData}.json`);
}

// ----------------------------------------------------
// SPAM DETECTION / RATE LIMITING SYSTEM (PER IP)
// ----------------------------------------------------
const ipRequestTracker = new Map();
const REQUEST_LIMIT = 3;         
const TIME_WINDOW_MS = 60 * 1000; 

function isSpamming(ip) {
  const now = Date.now();
  if (!ipRequestTracker.has(ip)) {
    ipRequestTracker.set(ip, [now]);
    return false;
  }

  const timestamps = ipRequestTracker.get(ip).filter(time => now - time < TIME_WINDOW_MS);
  
  if (timestamps.length >= REQUEST_LIMIT) {
    return true; 
  }

  timestamps.push(now);
  ipRequestTracker.set(ip, timestamps);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ipRequestTracker.entries()) {
    const validTimeStamps = timestamps.filter(t => now - t < TIME_WINDOW_MS);
    if (validTimeStamps.length === 0) {
      ipRequestTracker.delete(ip);
    } else {
      ipRequestTracker.set(ip, validTimeStamps);
    }
  }
}, 10 * 60 * 1000);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ----------------------------------------------------
// READ SESSION DIRECTLY FROM .ENV BASE64 STRING
// ----------------------------------------------------
function getEnvAuthCreds() {
  const base64String = process.env.WA_SESSION_BASE64;
  if (!base64String) {
    console.error('⚠️ WA_SESSION_BASE64 missing in .env!');
    return initAuthCreds();
  }
  try {
    const jsonString = Buffer.from(base64String, 'base64').toString('utf-8');
    return JSON.parse(jsonString, BufferJSON.reviver);
  } catch (e) {
    console.error('Failed to parse WA_SESSION_BASE64 from .env', e.message);
    return initAuthCreds();
  }
}

// Dynamic OTP Generator Helper
function generateOTP(digitCount) {
  const length = parseInt(digitCount) || 4;
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return Math.floor(min + Math.random() * (max - min + 1)).toString();
}

async function connectToWhatsApp() {
  try {
    const creds = getEnvAuthCreds();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds,
        keys: {
          get: async () => ({}),
          set: async () => {}
        }
      },
      browser: ['Ubuntu', 'Chrome', '110.0.5563.64']
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed (status code: ${statusCode}). Reconnecting...`);
        
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.error('❌ Session Logged Out. Please generate new WA_SESSION_BASE64 in Termux.');
        }
      } else if (connection === 'open') {
        isConnected = true;
        console.log('✅ WHATSAPP CONNECTED INSTANTLY VIA .ENV SESSION ID!');
      }
    });

  } catch (err) {
    console.error('Initialization Error:', err.message);
  }
}

connectToWhatsApp();

// Static & Docs Routing
app.get('/', (req, res) => {
  let baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  let url = baseUrl + '/docs';
  res.redirect(url);
});

app.get('/docs', (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.sendFile(path.join(__dirname, "public/docs.html"));
});

// API Health Endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, connected: isConnected });
});

// ----------------------------------------------------
// OTP SENDER API WITH FIREBASE STORE & 5-MIN EXPIRY
// ----------------------------------------------------
app.post('/send-otp', async (req, res) => {
  const { number, phone, digit, message, secret, req_verify, key } = req.body || {};
  if (key && key !== process.env.API_SECRET) {
  return res.status(401).json({ ok: false, message: 'Unauthorized API Secret Key' });
  }
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (isSpamming(clientIp)) {
    console.warn(`⚠️ Spam attempt blocked from IP: ${clientIp}`);
    return res.status(429).json({ 
      ok: false, 
      message: 'Too many request attempts. Please wait 1 minute before trying again.' 
    });
  }

  // Support both 'number' and 'phone' keys
  const targetNumber = number || phone;

  if (secret && secret !== API_SECRET) {
    return res.status(401).json({ ok: false, message: 'Unauthorized API Secret Key' });
  }

  if (!isConnected) {
    return res.status(503).json({ ok: false, message: 'WhatsApp Service is not connected yet.' });
  }

  if (!targetNumber) {
    return res.status(400).json({ ok: false, message: 'Phone/Number is required' });
  }

  const generatedOtp = generateOTP(digit);
  const baseMessage = message || 'Your OTP code is:';
  const fullTextMessage = `${baseMessage} *${generatedOtp}*`;

  let cleanPhone = targetNumber.toString().replace(/\D/g, '');
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }
  const jid = `${cleanPhone}@s.whatsapp.net`;

  // Auto 3-Times Retry Loop Mechanism
  const MAX_RETRIES = 3;
  let attempt = 0;
  let sendSuccess = false;
  let lastError = null;

  while (attempt < MAX_RETRIES && !sendSuccess) {
    try {
      attempt++;
      console.log(`🚀 Sending attempt ${attempt}/${MAX_RETRIES} to +${cleanPhone}...`);
      
      await sock.sendMessage(jid, { text: fullTextMessage });
      sendSuccess = true;
      console.log(`📩 OTP (${generatedOtp}) sent successfully to +${cleanPhone}`);

    } catch (err) {
      lastError = err;
      console.error(`⚠️ Attempt ${attempt} failed: ${err.message}`);
      
      if (attempt < MAX_RETRIES) {
        await sleep(1500);
      }
    }
  }

  if (sendSuccess) {
    // 5 minutes expiry calculation (Current time + 5 mins in ms)
    const expiresAt = Date.now() + 5 * 60 * 1000;

    // Firebase Database URL structure: otps/<cleanPhone> -> OTP Code & Expiry
    if (FBDB_URL) {
      try {
        await dbPut(`otps/${cleanPhone}`, {
          otp: generatedOtp.toString(),
          expiresAt: expiresAt
        });
      } catch (dbErr) {
        console.error('❌ Firebase DB Save Error:', dbErr.message);
      }
    }

    // req_verify true -> response OTP show korbe na
    if (req_verify === true) {
      return res.json({ ok: true });
    } else {
      return res.json({
        ok: true,
        otp: generatedOtp
      });
    }
  } else {
    return res.status(500).json({ 
      ok: false, 
      message: 'Failed to send WhatsApp message after 3 retries', 
      error: lastError?.message || 'Unknown network error'
    });
  }
});

// ----------------------------------------------------
// OTP VERIFY API
// ----------------------------------------------------
app.post('/verify-otp', async (req, res) => {
  const { number, phone, otp } = req.body || {};
  const targetNumber = number || phone;

  if (!targetNumber || !otp) {
    return res.status(400).json({ ok: false, message: 'Number and OTP are required' });
  }

  let cleanPhone = targetNumber.toString().replace(/\D/g, '');
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }

  try {
    // Firebase theke data direct fetch (GET)
    const record = await dbGet(`otps/${cleanPhone}`);

    if (!record) {
      return res.status(400).json({ verified: false, message: 'OTP not found or expired' });
    }

    // Expiry check (5 min passed or not)
    if (Date.now() > record.expiresAt) {
      await dbDelete(`otps/${cleanPhone}`); // Expired record deleted
      return res.status(400).json({ verified: false, message: 'OTP has expired' });
    }

    // Match check
    if (record.otp.toString() === otp.toString()) {
      // Correct Match hole DB clean process (DELETE)
      await dbDelete(`otps/${cleanPhone}`);
      return res.json({ verified: true });
    } else {
      return res.status(400).json({ verified: false, message: 'Invalid OTP' });
    }

  } catch (err) {
    console.error('❌ Verify OTP Error:', err.message);
    return res.status(500).json({ verified: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp Microservice running on Port ${PORT}`);
});
