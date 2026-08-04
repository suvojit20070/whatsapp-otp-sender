const { 
  default: makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const API_SECRET = process.env.WA_API_SECRET || 'my_wa_secret_key_123';

let sock;
let isConnected = false;

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
  const length = parseInt(digitCount) || 4; // Default to 4 digits if not provided
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

app.get('/', (req, res) => {
  let url = process.env.BASE_URL + '/docs';
  res.redirect(url);
});

app.get('/docs', (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.sendFile(path.join(__dirname, "public/docs.html"));
});

// API Endpoints
app.get('/health', (req, res) => {
  res.json({ ok: true, connected: isConnected });
});

// ----------------------------------------------------
// UPDATED OTP SENDER API
// ----------------------------------------------------
app.post('/send-otp', async (req, res) => {
  const { phone, digit, message, secret } = req.body;

  // Optional Security Secret Validation
  if (secret && secret !== API_SECRET) {
    return res.status(401).json({ ok: false, message: 'Unauthorized API Secret Key' });
  }

  if (!isConnected) {
    return res.status(503).json({ ok: false, message: 'WhatsApp Service is not connected yet.' });
  }

  if (!phone) {
    return res.status(400).json({ ok: false, message: 'Phone number is required' });
  }

  try {
    // Generate OTP based on requested digit count (e.g. 4)
    const generatedOtp = generateOTP(digit);

    // Prepare full text message
    const baseMessage = message || 'Your OTP code is:';
    const fullTextMessage = `${baseMessage} *${generatedOtp}*`;

    let cleanPhone = phone.toString().replace(/\D/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = '91' + cleanPhone; // Auto prepend country code
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: fullTextMessage });

    console.log(`📩 OTP (${generatedOtp}) sent to +${cleanPhone}`);

    // Return the response as requested
    return res.json({
      ok: true,
      otp: generatedOtp
    });

  } catch (error) {
    console.error('Sending Error:', error.message);
    return res.status(500).json({ ok: false, message: 'Failed to send WhatsApp message', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp Microservice running on Port ${PORT}`);
});
