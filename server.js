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
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const API_SECRET = process.env.WA_API_SECRET || 'my_wa_secret_key_123';

let sock;
let isConnected = false;

// ----------------------------------------------------
// SPAM DETECTION / RATE LIMITING SYSTEM (PER IP)
// ----------------------------------------------------
const ipRequestTracker = new Map();
const REQUEST_LIMIT = 3;         // Continuous request limit per window
const TIME_WINDOW_MS = 60 * 1000; // 1 Minute window

function isSpamming(ip) {
  const now = Date.now();
  if (!ipRequestTracker.has(ip)) {
    ipRequestTracker.set(ip, [now]);
    return false;
  }

  // Filter timestamps within current 1-minute window
  const timestamps = ipRequestTracker.get(ip).filter(time => now - time < TIME_WINDOW_MS);
  
  if (timestamps.length >= REQUEST_LIMIT) {
    return true; // Spam detected
  }

  timestamps.push(now);
  ipRequestTracker.set(ip, timestamps);
  return false;
}

// Clean stale IP logs every 10 minutes to prevent memory leak
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

// Helper Delay Function
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
// UPDATED OTP SENDER API WITH ANTI-SPAM & 3-RETRY LOGIC
// ----------------------------------------------------
app.post('/send-otp', async (req, res) => {
  // 1. IP Anti-Spam Check
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (isSpamming(clientIp)) {
    console.warn(`⚠️ Spam attempt blocked from IP: ${clientIp}`);
    return res.status(429).json({ 
      ok: false, 
      message: 'Too many request attempts. Please wait 1 minute before trying again.' 
    });
  }

  const { phone, digit, message, secret } = req.body;

  // 2. Secret validation
  if (secret && secret !== API_SECRET) {
    return res.status(401).json({ ok: false, message: 'Unauthorized API Secret Key' });
  }

  if (!isConnected) {
    return res.status(503).json({ ok: false, message: 'WhatsApp Service is not connected yet.' });
  }

  if (!phone) {
    return res.status(400).json({ ok: false, message: 'Phone number is required' });
  }

  const generatedOtp = generateOTP(digit);
  const baseMessage = message || 'Your OTP code is:';
  const fullTextMessage = `${baseMessage} *${generatedOtp}*`;

  let cleanPhone = phone.toString().replace(/\D/g, '');
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }
  const jid = `${cleanPhone}@s.whatsapp.net`;

  // 3. Auto 3-Times Retry Loop Mechanism
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
        await sleep(1500); // Retry wait interval (1.5s)
      }
    }
  }

  // 4. Final Response Delivery
  if (sendSuccess) {
    return res.json({
      ok: true,
      otp: generatedOtp
    });
  } else {
    return res.status(500).json({ 
      ok: false, 
      message: 'Failed to send WhatsApp message after 3 retries', 
      error: lastError?.message || 'Unknown network error'
    });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp Microservice running on Port ${PORT}`);
});
