const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const qrcode = require('qrcode');
const fsExtra = require('fs-extra');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());

const corsOptions = {
    origin: '*', 
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', 
    allowedHeaders: ['Content-Type', 'Authorization'], 
};

app.use(cors(corsOptions));

let sock; // Socket instance for WhatsApp connection
let isLoggedIn = false; // Status login WhatsApp
let isLoggedOut = false; // Flag to track logout status

// Function to initialize WhatsApp connection
const startSock = async () => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth'); // Multi-file auth state
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // Disable QR code print in terminal
        });

        sock.ev.on('creds.update', saveCreds); // Save credentials when updated

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (connection === 'open') {
                isLoggedIn = true;
                isLoggedOut = false;
                console.log('WhatsApp connected');
            } else if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== 401);
                isLoggedIn = false;

                // Attempt reconnection only if logout was not initiated
                if (shouldReconnect && !isLoggedOut) {
                    console.log('Reconnecting WhatsApp...');
                    setTimeout(startSock, 5000); // Reconnect after 5 seconds
                } else if (isLoggedOut) {
                    console.log('Logged out, no reconnect attempt');
                }
            }

            // QR code will be handled only if WebSocket is active
            if (!isLoggedIn && qr && wsClient) {
                const qrCodeDataURL = await qrcode.toDataURL(qr); // Convert QR to Data URL
                wsClient.send(JSON.stringify({ qrCode: qrCodeDataURL })); // Send QR code to WebSocket client
            }
        });
    } catch (error) {
        console.error('Error starting WhatsApp socket:', error);
    }
};

// Start WhatsApp connection immediately when server starts
startSock();

let wsClient = null; // Store WebSocket client

// API Endpoint for sending message
app.post('/send-message', async (req, res) => {
    const { phoneNumber, message } = req.body;
    if (!sock) return res.status(500).json({ message: 'WhatsApp not connected' });

    try {
        const numberWithCountryCode = phoneNumber + '@s.whatsapp.net'; // Format WhatsApp number
        await sock.sendMessage(numberWithCountryCode, { text: message });
        res.json({ status: 'Message sent successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Failed to send message', error: err });
    }
});

app.get('/status', (req, res) => {
    res.json({ isLoggedIn });
});

app.get('/connect', (req, res) => {
    if (!isLoggedIn && !isLoggedOut) {  
        res.json({ message: 'Initializing WhatsApp connection' });
    } else if (isLoggedOut) {
        startSock(); // Reinitialize socket if previously logged out
        isLoggedOut = false;
        res.json({ message: 'Reinitializing WhatsApp connection' });
    } else {
        res.status(400).json({ message: 'Already logged in' });
    }
});

// API Endpoint for logging out and deleting session
app.post('/logout', (req, res) => {
    if (sock) {
        try {
            sock.logout();
            isLoggedIn = false;
            isLoggedOut = true;

            // Clear saved session data
            fsExtra.emptyDirSync(path.join(__dirname, 'auth')); // Ensure auth directory is cleared properly
            res.json({ message: 'Logged out successfully' });
        } catch (error) {
            console.error('Error during logout:', error);
            res.status(500).json({ message: 'Logout failed', error });
        }
    } else {
        res.status(400).json({ message: 'No active session found' });
    }
});

// Set up WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket connection to handle QR code sending
wss.on('connection', (ws) => {
    wsClient = ws; // Store WebSocket client reference
    if (!isLoggedIn) {
        console.log('WhatsApp not logged in, sending QR code');
    } else {
        ws.send(JSON.stringify({ status: 'Already logged in' }));
        ws.close(); // Close WebSocket if already logged in
    }

    ws.on('close', () => {
        wsClient = null; // Reset WebSocket client reference when closed
    });
});

// Start the server
server.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});

// Handle unhandled promise rejections globally
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
