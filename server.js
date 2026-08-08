import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'chips_database.json');

// --- DATABASE HELPER FUNCTIONS ---
const readDatabase = () => {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ chips: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
};

const writeDatabase = (data) => {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

// ===============================================================
// 1. CHIP REGISTRATION / PING ENDPOINT
// Called by Python Flashing Tool or ESP8266 on boot
// ===============================================================
app.post('/api/chips/ping', (req, res) => {
  try {
    const { chipName, chipPassword, ipAddress } = req.body;

    if (!chipName || !chipPassword) {
      return res.status(400).json({ success: false, error: 'Missing chipName or chipPassword' });
    }

    const db = readDatabase();
    const existingIndex = db.chips.findIndex((c) => c.chipName === chipName);

    const record = {
      chipName: chipName.trim(),
      chipPassword: chipPassword.trim(),
      ipAddress: ipAddress || 'unassigned',
      lastActive: new Date().toISOString()
    };

    if (existingIndex !== -1) {
      db.chips[existingIndex] = record;
    } else {
      db.chips.push(record);
    }

    writeDatabase(db);
    return res.json({ success: true, message: `Chip '${chipName}' registered/updated successfully.`, chip: record });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ===============================================================
// 2. DISPATCH COMMAND / PAYLOAD ENDPOINT
// Called by Web App or Client
// ===============================================================
app.post('/api/chips/dispatch', async (req, res) => {
  try {
    const { chipName, chipPassword, command, binPayload } = req.body;

    // Direct 2-Key Security Verification
    const db = readDatabase();
    const target = db.chips.find(
      (c) => c.chipName === chipName && c.chipPassword === chipPassword
    );

    if (!target) {
      return res.status(401).json({ success: false, error: 'Access Denied: Invalid Chip Name or Chip Password.' });
    }

    if (!target.ipAddress || target.ipAddress === 'unassigned') {
      return res.status(400).json({ success: false, error: 'Target chip has not reported a valid IP address yet.' });
    }

    // Relay action/command directly to the physical ESP8266
    const chipResponse = await axios.post(`http://${target.ipAddress}/execute`, {
      authSecret: chipPassword,
      command: command || 'TRIGGER',
      payload: binPayload || null
    }, { timeout: 8000 });

    return res.json({ success: true, message: 'Command delivered to chip!', chipStatus: chipResponse.data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed delivering command to chip.', details: err.message });
  }
});

// ===============================================================
// 3. HEALTH CHECK ENDPOINT (To keep Render awake)
// ===============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`⚡ Velocit Permanent Server live on port ${PORT}`);
});
