import a, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from 'whaileys';
const makeWASocket = a.default;
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import readline from 'readline';
import pino from 'pino';
import fs from 'fs/promises';
import path, { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import axios from 'axios';

import PerformanceOptimizer from './utils/performanceOptimizer.js';
import RentalExpirationManager from './utils/rentalExpirationManager.js';
import { loadMsgBotOn } from './utils/database.js';
import { buildUserId } from './utils/helpers.js';

// Necessário para salvar QR
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Diretório onde o QR será salvo
const QR_DIR = path.join(__dirname, "..", "database", "qr-code");

let baileysVersionCache = null;
let baileysVersionCacheTime = 0;
const BAILEYS_VERSION_CACHE_TTL = 60 * 60 * 1000;

async function fetchBaileysVersionFromGitHub() {
    const now = Date.now();
    if (baileysVersionCache && (now - baileysVersionCacheTime) < BAILEYS_VERSION_CACHE_TTL) {
        return baileysVersionCache;
    }
    try {
        const response = await axios.get('https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/src/Defaults/baileys-version.json');
        baileysVersionCache = { version: response.data.version };
        baileysVersionCacheTime = now;
        return baileysVersionCache;
    } catch {
        const fallback = await fetchLatestBaileysVersion();
        baileysVersionCache = fallback;
        baileysVersionCacheTime = now;
        return fallback;
    }
}

class MessageQueue {
    constructor(maxWorkers = 4, batchSize = 10, messagesPerBatch = 2) {
        this.queue = [];
        this.maxWorkers = maxWorkers;
        this.batchSize = batchSize;
        this.messagesPerBatch = messagesPerBatch;
        this.activeWorkers = 0;
        this.isProcessing = false;
        this.stats = {
            totalProcessed: 0,
            totalErrors: 0,
            startTime: Date.now(),
        };
    }

    async add(message, processor) {
        return new Promise((resolve, reject) => {
            this.queue.push({ message, processor, resolve, reject });
            if (!this.isProcessing) this.startProcessing();
        });
    }

    startProcessing() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        this.processQueue();
    }

    async processQueue() {
        while (this.isProcessing && this.queue.length > 0) {
            const batch = this.queue.splice(0, this.messagesPerBatch);
            await Promise.all(batch.map(item => item.processor(item.message).then(item.resolve).catch(item.reject)));
        }
        this.isProcessing = false;
    }
}

const messageQueue = new MessageQueue(8, 10, 2);

const configPath = path.join(__dirname, "config.json");
let config;

try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
} catch (err) {
    console.error("Erro ao carregar config:", err);
    process.exit(1);
}

const indexModule = (await import('./index.js')).default ?? (await import('./index.js'));

const performanceOptimizer = new PerformanceOptimizer();
const rentalExpirationManager = new RentalExpirationManager(null, {
    checkInterval: '0 */6 * * *',
    warningDays: 3,
    finalWarningDays: 1,
    cleanupDelayHours: 24,
    enableNotifications: true,
    enableAutoCleanup: true,
});

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, '..', 'database', 'qr-code');

// ------------ 🔧 FUNÇÃO PRINCIPAL DO BOT ------------
async function createBotSocket(authDir) {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchBaileysVersionFromGitHub();

    const Sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false, // ⚠️ Não mostrar QR no terminal
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, NodeCache)
        },
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false
    });

    Sock.ev.on('creds.update', saveCreds);

    Sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect, qr } = update;

        // ------------------ ⚠️ QR Code editado aqui ------------------
        if (qr && !Sock.authState.creds.registered && !config.codeMode) {
            try {
                await fs.mkdir(QR_DIR, { recursive: true });

                const qrFile = path.join(QR_DIR, "qr.txt");

                await fs.writeFile(qrFile, qr, "utf8");

                console.log("📄 QR CODE GERADO E SALVO EM:");
                console.log(qrFile);
                console.log("➡️ Baixe esse arquivo no Koyeb e me envie aqui para gerar a imagem do QR.");
            } catch (e) {
                console.error("❌ Erro ao salvar QR:", e.message);
            }
        }
        // -------------------------------------------------------------

        if (connection === "open") {
            console.log("Bot conectado!");
        }

        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("Conexão fechada, tentando reconectar...");
            await createBotSocket(AUTH_DIR);
        }
    });

    return Sock;
}

startNazu();
async function startNazu() {
    await createBotSocket(AUTH_DIR);
}

export { rentalExpirationManager, messageQueue };
