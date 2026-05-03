const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// The path where your session files will be stored
const DB_DIR = path.join(__dirname, 'database');

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static('public'));

// Route to serve the dynamic session page
app.get('/session/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'session.html'));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getSession = (id) => {
    try {
        const filePath = path.join(DB_DIR, `${id}.json`);
        if (!fs.existsSync(filePath)) return null;
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error(`[DB] Error reading session ${id}:`, err);
        return null;
    }
};

const saveSession = (id, session) => {
    try {
        const filePath = path.join(DB_DIR, `${id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
    } catch (err) {
        console.error(`[DB] Error writing session ${id}:`, err);
        throw err;
    }
};

// ─── API Routes ───────────────────────────────────────────────────────────────

/**
 * POST /api/sessions
 * Create a new contact collection session
 */
app.post('/api/sessions', (req, res) => {
    try {
        const { name, link = '', days = 0, hours = 0, minutes = 0, seconds = 0 } = req.body;

        // Validation
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Session name is required.' });
        }

        const totalMs = (
            (parseInt(days) * 24 * 60 * 60) +
            (parseInt(hours) * 60 * 60) +
            (parseInt(minutes) * 60) +
            parseInt(seconds)
        ) * 1000;

        if (isNaN(totalMs) || totalMs <= 0) {
            return res.status(400).json({ error: 'Duration must be greater than zero.' });
        }

        const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year cap
        if (totalMs > MAX_DURATION_MS) {
            return res.status(400).json({ error: 'Duration cannot exceed 1 year.' });
        }

        const unlockTime = Date.now() + totalMs;
        const sessionId = crypto.randomUUID();

        const session = {
            name: name.trim(),
            link: link.trim(),
            unlockTime,
            createdAt: new Date().toISOString(),
            contacts: []
        };
        saveSession(sessionId, session);

        console.log(`[Session] Created: "${name.trim()}" (ID: ${sessionId}), unlocks at ${new Date(unlockTime).toISOString()}`);
        res.status(201).json({ sessionId });

    } catch (error) {
        console.error('[Session] Create error:', error);
        res.status(500).json({ error: 'Failed to create session. Please try again.' });
    }
});

/**
 * GET /api/sessions/:id
 * Fetch session metadata (name, link, unlockTime)
 */
app.get('/api/sessions/:id', (req, res) => {
    try {
        const session = getSession(req.params.id);

        if (!session) {
            return res.status(404).json({ error: 'Session not found.' });
        }

        res.json({
            name: session.name,
            link: session.link,
            unlockTime: session.unlockTime,
            contactCount: session.contacts.length
        });

    } catch (error) {
        console.error('[Session] Fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch session.' });
    }
});

/**
 * POST /api/contacts/:id
 * Submit a contact to a session
 */
app.post('/api/contacts/:id', (req, res) => {
    try {
        const { name, phone } = req.body;
        const sessionId = req.params.id;

        // Validation
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Name is required.' });
        }
        if (!phone || typeof phone !== 'string' || !phone.trim().startsWith('+')) {
            return res.status(400).json({ error: 'Phone number must start with a + sign and include a country code.' });
        }

        const session = getSession(sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Session not found.' });
        }

        if (Date.now() >= session.unlockTime) {
            return res.status(403).json({ error: 'This session has closed. No more contacts can be added.' });
        }

        // Duplicate check (same phone in same session)
        const isDuplicate = session.contacts.some(c => c.phone === phone.trim());
        if (isDuplicate) {
            return res.status(409).json({ error: 'This phone number has already been submitted.' });
        }

        session.contacts.push({
            name: name.trim(),
            phone: phone.trim(),
            dateAdded: new Date().toISOString()
        });
        saveSession(sessionId, session);

        console.log(`[Contact] Saved "${name.trim()}" to session ${sessionId}`);
        res.status(201).json({ message: 'Contact saved successfully!' });

    } catch (error) {
        console.error('[Contact] Save error:', error);
        res.status(500).json({ error: 'Failed to save contact. Please try again.' });
    }
});

/**
 * GET /api/export-vcf/:id
 * Download all contacts as a .vcf file (only after unlock)
 */
app.get('/api/export-vcf/:id', (req, res) => {
    try {
        const sessionId = req.params.id;
        const session = getSession(sessionId);

        if (!session) {
            return res.status(404).send('Session not found.');
        }

        if (Date.now() < session.unlockTime) {
            const remaining = Math.ceil((session.unlockTime - Date.now()) / 1000);
            return res.status(403).send(`VCF export is locked. Please wait ${remaining} more second(s).`);
        }

        if (!session.contacts || session.contacts.length === 0) {
            return res.status(404).send('No contacts were collected for this session.');
        }

        // Build vCard 3.0 data
        let vcfData = '';
        session.contacts.forEach(contact => {
            const safeName = contact.name.replace(/[\\,;]/g, '\\$&');
            vcfData += 'BEGIN:VCARD\r\n';
            vcfData += 'VERSION:3.0\r\n';
            vcfData += `FN:${safeName}\r\n`;
            vcfData += `N:${safeName};;;\r\n`;
            vcfData += `TEL;TYPE=CELL:${contact.phone}\r\n`;
            if (contact.dateAdded) {
                vcfData += `NOTE:Added ${new Date(contact.dateAdded).toLocaleDateString()}\r\n`;
            }
            vcfData += 'END:VCARD\r\n';
        });

        const safeFilename = session.name.replace(/[^a-z0-9\-_\s]/gi, '').trim() || 'contacts';
        res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}_contacts.vcf"`);
        res.send(vcfData);

        console.log(`[Export] VCF downloaded for session "${session.name}" — ${session.contacts.length} contact(s)`);

    } catch (error) {
        console.error('[Export] Error:', error);
        res.status(500).send('Error generating VCF file.');
    }
});

/**
 * GET /api/sessions/:id/stats
 * Simple stats endpoint (contact count, time left)
 */
app.get('/api/sessions/:id/stats', (req, res) => {
    try {
        const session = getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found.' });

        const now = Date.now();
        res.json({
            name: session.name,
            contactCount: session.contacts.length,
            unlockTime: session.unlockTime,
            isUnlocked: now >= session.unlockTime,
            timeRemainingMs: Math.max(0, session.unlockTime - now)
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n✦ Emmy Henz VCF Server running → http://localhost:${PORT}\n`);
});