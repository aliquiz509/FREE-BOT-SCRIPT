const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const {
    exec
} = require('child_process');
const { sms } = require("./msg");
const router = express.Router();
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
const pino = require('pino');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require('yt-search');
const { ytmp3, ytmp4 } = require('sadaslk-dlcore');
const os = require('os');
const fecth = require('node-fetch');
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);
const antiDeletePlugin = require('../inconnuboy/antidelete');
const emojiDlPlugin = require('../inconnuboy/emoji_dl');
const onceDlPlugin = require('../inconnuboy/once_dl');
const antiViewOncePlugin = require('../inconnuboy/antiviewonce');
const antilinkPlugin = require('../inconnuboy/antilink');
const welcomePlugin = require('../inconnuboy/welcome');
const cmd = require('./cmd');
const Group = require('./group');
  const images = [
    'https://i.postimg.cc/4xXj3T8R/file-00000000f890820e9ec3d21792b1cc8b.png',
    'https://i.postimg.cc/4xXj3T8R/file-00000000f890820e9ec3d21792b1cc8b.png'
  ]; 

Object.defineProperty(global, 'akira', {
    get: () => images[Math.floor(Math.random() * images.length)]
});

const {
    default: makeWASocket,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    fetchLatestBaileysVersion, 
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    extractMessageContent, 
    jidDecode,
    MessageRetryMap,
    jidNormalizedUser, 
    proto,
    getContentType,
    areJidsSameUser,
    generateWAMessage, 
    delay, 
    Browsers
} = require("baileys");

const config = {
    AUTO_VIEW_STATUS: 'false',
    AUTO_LIKE_STATUS: 'false',
	BUTTON_MODE: 'true',
    MODE: 'public',
    PREFIX: '.',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    AKIRA_IMG: 'https://i.postimg.cc/4xXj3T8R/file-00000000f890820e9ec3d21792b1cc8b.png',
    NEWSLETTER_JID: process.env.NEWSLETTER_JID || '',
    NEWSLETTER_LIST: process.env.NEWSLETTER_JID ? [process.env.NEWSLETTER_JID] : [],
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: process.env.OWNER_NUMBER || '',
    CHANNEL_LINK: process.env.CHANNEL_LINK || ''
};

const replyFq = (text) => reply(text);

if (!global.sadewVideoSearch) global.sadewVideoSearch = {};
if (!global.sadewMenuTracker) global.sadewMenuTracker = {};

const activeSockets = new Map();
const socketCreationTime = new Map();
const socketHandlersMap = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';

const SessionSchema = new mongoose.Schema({
    number: {
        type: String,
        unique: true,
        required: true
    },
    creds: {
        type: Object,
        required: true
    },
    config: {
        type: Object
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

const Session = mongoose.model('SessionNew', SessionSchema); 

async function connectMongoDB() {
    try {
        
const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) {
            console.error('MONGODB_URI is non configuré. Add it to your .env file.');
            process.exit(1);
        }
        await mongoose.connect(mongoUri, {
            bufferCommands: false,
            serverSelectionTimeoutMS: 5000 
        });
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection failed:', error);
        process.exit(1);
    }
}
connectMongoDB();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, {
        recursive: true
    });
}

function initialize() {
    activeSockets.clear();
    socketCreationTime.clear();
    console.log('Cleared active sockets and creation times on startup');
}

async function uploadToCatbox(stream, fileName) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', stream, fileName);

        const res = await axios.post(
            'https://catbox.moe/user/api.php',
            form,
            { headers: form.getHeaders(), timeout: 0 }
        );

        if (!res.data.startsWith('https://')) return null;
        return res.data.trim();
    } catch {
        return null;
    }
}

async function saveMediaToCatbox(msg) {
    try {
        const type = Object.keys(msg.message)[0];
        const mediaMap = {
            imageMessage: 'image',
            videoMessage: 'video',
            audioMessage: 'audio',
            documentMessage: 'document'
        };

        if (!mediaMap[type]) return null;

        const mediaMsg = msg.message[type];
        const size = mediaMsg.fileLength || 0;
        
        if (size > 100 * 1024 * 1024) return null;

        const stream = await downloadContentFromMessage(
            mediaMsg,
            mediaMap[type]
        );

        const ext =
            type === 'imageMessage' ? 'jpg' :
            type === 'videoMessage' ? 'mp4' :
            type === 'audioMessage' ? 'opus' :
            'bin';

        return await uploadToCatbox(stream, `${msg.key.id}.${ext}`);
    } catch {
        return null;
    }
}


async function cleanupInactiveSessions() {
    try {
        const sessions = await Session.find({}, 'number').lean();
        let cleanedCount = 0;

        for (const {
                number
            }
            of sessions) {
            const sanitizedNumber = number.replace(/[^0-9]/g, '');

            if (!activeSockets.has(sanitizedNumber) && !socketCreationTime.has(sanitizedNumber)) {
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

                if (fs.existsSync(sessionPath)) {
                    const stats = fs.statSync(sessionPath);
                    const timeSinceModified = Date.now() - stats.mtime.getTime();

                    if (timeSinceModified > 60 * 60 * 1000) {
                        console.log(`Cleaning up stale session: ${sanitizedNumber}`);
                        fs.removeSync(sessionPath);
                        cleanedCount++;
                    }
                }
            }
        }

        console.log(`Cleaned up ${cleanedCount} stale sessions`);
        return cleanedCount;
    } catch (error) {
        console.error('Cleanup error:', error);
        return 0;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const jid = message.key.remoteJid;

        if (jid !== config.NEWSLETTER_JID) return;

        try {
            const emojis = ['🎀', '🍬', '👽', '🌺', '🍓', '🍫', '🫐', '🥷'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            
            const messageId = message.key.server_id || message.newsletterServerId;

            if (!messageId) {
                console.warn('⚠️ No newsletterServerId found in message:', message);
                return;
            }

            const delayTime = Math.floor(Math.random() * 7000) + 3000; 
            console.log(`⏳ Channel Message Detected. Waiting ${delayTime/2000} seconds to react...`);
            await new Promise(resolve => setTimeout(resolve, delayTime));

            await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
            console.log(`✅ Reacted to official newsletter: ${jid}`);
        } catch (error) {
            console.error('⚠️ Newsletter reaction failed:', error.message);
        }
    });
}


async function autoReconnectOnStartup() {
    try {
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            console.log(`Loaded ${numbers.length} numbers from numbers.json`);
        }

        const sessions = await Session.find({}, 'number').lean();
        const mongoNumbers = sessions.map(s => s.number);
        numbers = [...new Set([...numbers, ...mongoNumbers])];

        if (numbers.length === 0) {
            console.log('No numbers found for auto-reconnect');
            return;
        }

        console.log(`Attempting to reconnect ${numbers.length} sessions...`);

        for (const number of numbers) {
            const sanitized = number.replace(/[^0-9]/g, '');
            if (activeSockets.has(sanitized)) {
                console.log(`Number ${sanitized} already connected, skipping`);
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };

            try {
                await EmpirePair(sanitized, mockRes);
                console.log(`✅ Initiated reconnect for ${sanitized}`);
            } catch (error) {
                console.error(`❌ Failed to reconnect ${sanitized}:`, error);
            }

            await delay(1500);
        }
    } catch (error) {
        console.error('Auto-reconnect on startup failed:', error);
    }
}

(async () => {
    await initialize();
    setTimeout(autoReconnectOnStartup, 5000); 
})();


function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

const fetchJson = async (url, options) => {
    try {
        options ? options : {}
        const res = await axios({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36'
            },
            ...options
        })
        return res.data
    } catch (err) {
        return err
    }
}

const runtime = (seconds) => {
	seconds = Number(seconds)
	var d = Math.floor(seconds / (3600 * 24))
	var h = Math.floor(seconds % (3600 * 24) / 3600)
	var m = Math.floor(seconds % 3600 / 60)
	var s = Math.floor(seconds % 60)
	var dDisplay = d > 0 ? d + (d == 1 ? ' day, ' : ' days, ') : ''
	var hDisplay = h > 0 ? h + (h == 1 ? ' hour, ' : ' hours, ') : ''
	var mDisplay = m > 0 ? m + (m == 1 ? ' minute, ' : ' minutes, ') : ''
	var sDisplay = s > 0 ? s + (s == 1 ? ' second' : ' seconds') : ''
	return dDisplay + hDisplay + mDisplay + sDisplay;
}

async function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
                
        const senderNumber = msg.key.participant ? msg.key.participant.split('@')[0] : msg.key.remoteJid.split('@')[0];
        const botNumber = jidNormalizedUser(socket.user.id).split('@')[0];
        const isReact = msg.message.reactionMessage;

        const sanitizedNumber = botNumber.replace(/[^0-9]/g, '');
        const sessionConfig = activeSockets.get(sanitizedNumber)?.config || config;
    });
} 

function setupAutoRestart(socket, number) {
    const id = number;
    let reconnecting = false;

    socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

        if (connection === 'open') {
            reconnecting = false;
            return;
        }

        if (connection !== 'close' || reconnecting) return;
        reconnecting = true;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.warn(`[${id}] Connection closed | code:`, statusCode);

        if (statusCode === 401) {
            await destroySocket(id);
            await deleteSession(id);
            return;
        }

        await delay(2000);
        await destroySocket(id);

        const mockRes = {
            headersSent: true,
            send() {},
            status() { return this }
        };

        try {
            await EmpirePair(id, mockRes);
        } catch (e) {
            console.error('Reconnect failed:', e);
        }

        reconnecting = false;
    });
}


async function destroySocket(id) {
    try {
        const data = activeSockets.get(id);
        if (data?.socket) {
            data.socket.ev.removeAllListeners();
            data.socket.ws?.close();
        }
    } catch (e) {
        console.error('Destroy socket error:', e);
    }

    activeSockets.delete(id);
    socketCreationTime.delete(id);
}

async function saveSession(number, creds) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate({
            number: sanitizedNumber
        }, {
            creds,
            updatedAt: new Date()
        }, {
            upsert: true
        });
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(creds, null, 2));
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
        }
        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }
        console.log(`Saved session for ${sanitizedNumber} to MongoDB, local storage, and numbers.json`);
    } catch (error) {
        console.error(`Failed to save session for ${sanitizedNumber}:`, error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({
            number: sanitizedNumber
        });
        if (!session) {

            return null;
        }
        if (!session.creds || !session.creds.me || !session.creds.me.id) {
            console.error(`Invalid session data for ${sanitizedNumber}`);
            await deleteSession(sanitizedNumber);
            return null;
        }
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(session.creds, null, 2));
        console.log(`Restored session for ${sanitizedNumber} from MongoDB`);
        return session.creds;
    } catch (error) {
        console.error(`Failed to restore session for ${number}:`, error);
        return null;
    }
}

async function deleteSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.deleteOne({
            number: sanitizedNumber
        });
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
        }
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            let numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }

    } catch (error) {
        console.error(`Failed to delete session for ${number}:`, error);
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configDoc = await Session.findOne({ number: sanitizedNumber }, 'config');
        
        if (configDoc?.config) {
            return { ...config, ...configDoc.config };
        }
        return { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate({
            number: sanitizedNumber
        }, {
            config: newConfig,
            updatedAt: new Date()
        }, {
            upsert: true
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error(`Failed to update config for ${number}:`, error);
        throw error;
    }
}

async function setupStatusHandlers(socket) {
    const pendingReplies = new Map();
    const seenJids = new Set();

    socket.ev.on('messages.upsert', async ({
        messages
    }) => {
        const msg = messages[0];
        if (!msg?.key ||
            msg.key.remoteJid !== 'status@broadcast' ||
            !msg.key.participant ||
            msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const botJid = jidNormalizedUser(socket.user.id);
        if (msg.key.participant === botJid) return;

        const sanitizedNumber = botJid.split('@')[0].replace(/[^0-9]/g, '');
        const sessionConfig = activeSockets.get(sanitizedNumber)?.config || config;

        let statusViewed = false;

        try {

            if (sessionConfig.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        statusViewed = true;
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) {
                            console.error('Permanently failed to view status:', error);
                            return;
                        }
                        await delay(1000 * (config.MAX_RETRIES - retries + 1));
                    }
                }
            } else {

                statusViewed = true;
            }

            if (statusViewed && sessionConfig.AUTO_LIKE_STATUS === 'true') {
                const emojis = sessionConfig.AUTO_LIKE_EMOJI || ['🩸'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            msg.key.remoteJid, {
                                react: {
                                    text: randomEmoji,
                                    key: msg.key
                                }
                            }, {
                                statusJidList: [msg.key.participant]
                            }
                        );
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) {
                            console.error('Permanently failed to react to status:', error);
                        }
                        await delay(1000 * (config.MAX_RETRIES - retries + 1));
                    }
                }
            }

        } catch (error) {
            console.error('Unexpected error in status handler:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function EmpirePair(number, res) {
    console.log(`Initiating pairing/reconnect for ${number}`);
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    if (activeSockets.has(sanitizedNumber)) {
        try { activeSockets.get(sanitizedNumber).socket?.end?.(); } catch {}
        activeSockets.delete(sanitizedNumber);
    }

    await restoreSession(sanitizedNumber);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    try {
        const socket = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: "silent" }),
            browser: ['Ubuntu', 'Chrome', '120.0.0'], // Added browser spoofing
            printQRInTerminal: false,
            syncFullHistory: false,      // Stops downloading the entire old message history
            markOnlineOnConnect: false   // Reduces load while logging in
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        if (!socket._handlersAttached) {
            socket._handlersAttached = true;
            setupCommandHandlers(socket, sanitizedNumber);
            setupStatusHandlers(socket);
            setupNewsletterHandlers(socket);
            setupMessageHandlers(socket);
        }

        setupAutoRestart(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            const custom = "DUBED509";
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber, custom);
                    break;
                } catch (error) {
                    retries--;
                    if (retries === 0) throw error;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) res.send({ code });
        }

        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                const credsPath = path.join(sessionPath, 'creds.json');
                if (!fs.existsSync(credsPath)) return;
                const fileContent = await fs.readFile(credsPath, 'utf8');
                const creds = JSON.parse(fileContent);
                await saveSession(sanitizedNumber, creds);
            } catch {}
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connection opened for ${sanitizedNumber}`);

				await socket.sendPresenceUpdate('unavailable');
				
                try {
                    await delay(3000);

                    if (!socket.user?.id) {
                        console.error(`❌ socket.user is null after connection open for ${sanitizedNumber}`);
                        return;
                    }

                    const userJid = jidNormalizedUser(socket.user.id);
                    const freshConfig = await loadUserConfig(sanitizedNumber);

                    activeSockets.set(sanitizedNumber, { socket, config: freshConfig });
                    console.log(`📌 Socket registered in activeSockets for ${sanitizedNumber}`);
                    try { 
                    antiDeletePlugin.init(socket); 
                    console.log(`🛡️ Anti-Delete System Auto-Started successfully!`);
                    } catch(e) {
                    console.log(`❌ Anti-Delete Error:`, e.message);
                    }
                    try {
                        emojiDlPlugin.init(socket);
                        console.log(`📥 Emoji Downloader Auto-Started successfully!`);
                    } catch(e) {
                        console.log(`❌ Emoji DL Error:`, e.message);
                    }
                    try {
                        onceDlPlugin.init(socket);
                        console.log(`👁️ ViewOnce Downloader Auto-Started successfully!`);
                    } catch(e) {
                        console.log(`❌ ViewOnce DL Error:`, e.message);
                    }
                    try {
                        antiViewOncePlugin.init(socket);
                        console.log(`👁️ Anti-Vue Unique Auto-Started successfully!`);
                    } catch(e) {
                        console.log(`❌ Anti-Vue Unique Error:`, e.message);
                    }
                    try {
                        antilinkPlugin.init(socket);
                        console.log(`🔗 Antilink System Auto-Started successfully!`);
                    } catch(e) {
                        console.log(`❌ Antilink Error:`, e.message);
                    }
                    try {
                        welcomePlugin.init(socket);
                        console.log(`👋 Bienvenue/Goodbye System Auto-Started successfully!`);
                    } catch(e) {
                        console.log(`❌ Bienvenue/Goodbye Error:`, e.message);
                    }
                        
                        try {
                            const combinedList = [];
                            
                            if (config.NEWSLETTER_JID) {
                                combinedList.push(config.NEWSLETTER_JID);
                            }
                            
                            if (config.NEWSLETTER_LIST && Array.isArray(config.NEWSLETTER_LIST)) {
                                config.NEWSLETTER_LIST.forEach(jid => {
                                    if (!combinedList.includes(jid)) { 
                                        combinedList.push(jid);
                                    }
                                });
                            }
                        
                            console.log(`📌 Total Newsletters to follow (including Main): ${combinedList.length}`);
                        
                            for (const jid of combinedList) {
                                try {
                                    await socket.newsletterFollow(jid);
                                    
                                    if (jid === config.NEWSLETTER_JID) {
                                        console.log(`👑 Main Newsletter Followed Successfully: ${jid}`);
                                    } else {
                                        console.log(`✅ Extra Newsletter Followed: ${jid}`);
                                    }
                                    
                                    await delay(2000);
                                } catch (e) {
                                    console.log(`❌ Newsletter error for ${jid}:`, e.message);
                                }
                            }
                        } catch (newsletterError) {
                            console.error("Newsletter list error:", newsletterError);
                        }

                    console.log(`📌 Connection ready for ${sanitizedNumber}`);
                } catch (error) {
                    console.error('Error in connection open handler:', error.message);
                }
            }
            


            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 401) {
                    try { socket.end(); } catch {}
                    activeSockets.delete(sanitizedNumber);
                    socketCreationTime.delete(sanitizedNumber);
                    await deleteSession(sanitizedNumber);
                }
            }
        });

    } catch (error) {
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}
async function setupCommandHandlers(socket, number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    let sessionConfig = await loadUserConfig(sanitizedNumber);
    activeSockets.set(sanitizedNumber, { socket, config: sessionConfig });
        if (!socket.isSmartOverridden) {
            socket.originalSendMessage = socket.sendMessage;
            socket.sendMessage = async (jid, content, options) => {
                
                const currentConfig = activeSockets.get(sanitizedNumber)?.config || {};
                const botButtonMode = currentConfig.BUTTON_MODE || 'true'; // Default 'true'
                
                if (content.buttons && botButtonMode === 'false') {
                    
                    const isMainMenu = content.buttons.some(btn => btn?.buttonId && btn.buttonId.startsWith('.catmenu'));
                    
                    let finalOpts = { ...content };
                    delete finalOpts.buttons;     
                    delete finalOpts.headerType;

                    if (isMainMenu) {
                        return await socket.originalSendMessage(jid, finalOpts, options);
                    } else {
                        let fallbackText = (content.caption || content.text || "") + "\n\n*👇 Répondez avec le numéro souhaité ci-dessous :*\n\n";
                        let map = {};
                        content.buttons.forEach((btn, index) => {
                            let num = index + 1;
                            fallbackText += `*${num}.* ${btn.buttonText.displayText}\n`;
                            map[num.toString()] = btn.buttonId;
                        });
                        if (content.footer) fallbackText += `\n> ${content.footer}`;
                        
                        if (finalOpts.image) finalOpts.caption = fallbackText;
                        else if (finalOpts.video) finalOpts.caption = fallbackText;
                        else finalOpts.text = fallbackText;
                        
                        const sentMsg = await socket.originalSendMessage(jid, finalOpts, options);
                        global.btnFallbackTracker = global.btnFallbackTracker || {};
                        global.btnFallbackTracker[jid] = { msgId: sentMsg?.key?.id, map: map };
                        return sentMsg;
                    }
                }
                return await socket.originalSendMessage(jid, content, options);
            };
            socket.isSmartOverridden = true;
        }
    const recentCallers = new Set();

    socket.ev.on('messages.upsert', async ({ messages }) => {
        await socket.sendPresenceUpdate('unavailable');
        const msg = messages[0];
        if (!msg.message) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const m = sms(socket, msg);                                              
        const quoted = type == "extendedTextMessage" && msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
        
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || "") 
            : '';
     
        if (!body) return;
    
        const text = body;
        const sender = msg.key.remoteJid;

        const quotedStanzaIdBtn = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        if (quotedStanzaIdBtn && global.btnFallbackTracker && global.btnFallbackTracker[sender]) {
            if (global.btnFallbackTracker[sender].msgId === quotedStanzaIdBtn) {
                const mappedCmd = global.btnFallbackTracker[sender].map[text.trim()];
                if (mappedCmd) {
                    let fakeMsg = JSON.parse(JSON.stringify(msg));
                    fakeMsg.key.id = crypto.randomBytes(16).toString("hex").toUpperCase();
                    fakeMsg.message = { conversation: mappedCmd };
                    socket.ev.emit('messages.upsert', { messages: [fakeMsg], type: 'notify' });
                    delete global.btnFallbackTracker[sender];
                    return;
                }
            }
        }

        const isCmd = text.startsWith(sessionConfig.PREFIX || '!');
        const nowsender = msg.key.fromMe ?
            (socket.user.id.split(':')[0] + '@s.whatsapp.net') :
            (msg.key.participant || msg.key.remoteJid);

        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];

        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        const isAshuu = sender === `${config.OWNER_NUMBER}@s.whatsapp.net` ||
            jidNormalizedUser(socket.user.id) === sender;
        const isGroup = msg.key.remoteJid.endsWith('@g.us');

        if (!isOwner && sessionConfig.MODE === 'private') return;
        if (!isOwner && isGroup && sessionConfig.MODE === 'inbox') return;
        if (!isOwner && !isGroup && sessionConfig.MODE === 'groups') return;

        if (msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.quotedMessage) {
            const replyText = text.trim();
            const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            const quotedText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";
            const quotedStanzaId = msg.message.extendedTextMessage.contextInfo.stanzaId;

            if (
                global.sadewMenuTracker[sender] &&
                global.sadewMenuTracker[sender] === quotedStanzaId &&
                /^[1-9]$/.test(replyText)
            ) {
                const catNum = parseInt(replyText);
                const buttonMsg = cmd.buildCategoryButtonMessage(catNum);
                if (buttonMsg) {
                    return await socket.sendMessage(msg.key.remoteJid, buttonMsg, { quoted: msg });
                }
            }

            if (quotedText.includes("*🔍 RECHERCHE VIDÉO*") && /^[1-5]$/.test(replyText)) {
                if (global.sadewVideoSearch && global.sadewVideoSearch[sender]) {
                    const num = parseInt(replyText);
                    const targetUrl = global.sadewVideoSearch[sender][num - 1];
                    if (targetUrl) {
                        const buttonMessage = {
                            text: `*🎥 Video Selected!*\n\n🔗 ${targetUrl}\n\n> *Choisissez la qualité vidéo ci-dessous :*`,
                            footer: '•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴',
                            buttons: [
                                { buttonId: `.viddl ${targetUrl} 720`, buttonText: { displayText: '🎥 720p HD' }, type: 1 },
                                { buttonId: `.viddl ${targetUrl} 480`, buttonText: { displayText: '🎞️ 480p' }, type: 1 },
                                { buttonId: `.viddl ${targetUrl} 360`, buttonText: { displayText: '📱 360p' }, type: 1 },
                                { buttonId: `.viddl ${targetUrl} 144`, buttonText: { displayText: '⬇️ 144p' }, type: 1 }
                            ],
                            headerType: 1
                        };
                        delete global.sadewVideoSearch[sender];
                        return await socket.sendMessage(msg.key.remoteJid, buttonMessage, { quoted: msg });
                    }
                } else {
                    return await socket.sendMessage(msg.key.remoteJid, { text: "❌ *Veuillez relancer la recherche vidéo depuis le début.*" }, { quoted: msg });
                }
            }

            if (
                global.sadewSettingsTracker &&
                global.sadewSettingsTracker[sender] === quotedStanzaId &&
                /^[1-3]$/.test(replyText)
            ) {
                let newMode = '';
                if (replyText === '1') newMode = 'public';
                else if (replyText === '2') newMode = 'private';
                else if (replyText === '3') newMode = 'inbox';

                sessionConfig.MODE = newMode;
                
                const Session = mongoose.models.SessionNew;
                const sNum = botNumber.replace(/[^0-9]/g, '');
                if (activeSockets.has(sNum)) {
                    const currentData = activeSockets.get(sNum);
                    currentData.config = sessionConfig;
                    activeSockets.set(sNum, currentData);
                }
                await Session.findOneAndUpdate(
                    { number: sNum },
                    { config: sessionConfig, updatedAt: new Date() },
                    { upsert: true }
                );

                delete global.sadewSettingsTracker[sender];
                return await socket.sendMessage(msg.key.remoteJid, { text: `✅ *Mode du bot mis à jour : ${newMode.toUpperCase()}.*` }, { quoted: msg });
            }
if (global.cartoonNumHandler) {
    const handled = await global.cartoonNumHandler(msg, socket);
    if (handled) return;
}
            if (quotedText.includes("DUBED-MD RECHERCHE") && /^[0-9]+$/.test(replyText)) {
                if (global.xnxxContexts && global.xnxxContexts[sender]) {
                    try {
                        let context = global.xnxxContexts[sender];
                        let selectedNum = parseInt(replyText);
                        if (selectedNum >= 1 && selectedNum <= context.results.length) {
                            const selectedVideo = context.results[selectedNum - 1];
                            try { await socket.sendMessage(msg.key.remoteJid, { react: { text: '⏳', key: msg.key } }); } catch (_) {}
                            if (selectedVideo.thumbnail) {
                                try {
                                    await socket.sendMessage(msg.key.remoteJid, {
                                        image: { url: selectedVideo.thumbnail },
                                        caption: `📥 *Téléchargement de la vidéo n°${selectedNum} :* _${selectedVideo.title}_\n*La vidéo arrive bientôt, veuillez patienter…*`
                                    }, { quoted: msg });
                                } catch (_) {}
                            }
                            try {
                                const downloadApiUrl = `https://apis.davidcyril.name.ng/download/xnxx?url=${encodeURIComponent(selectedVideo.url)}`;
                                const downloadResponse = await axios.get(downloadApiUrl, { timeout: 30000 });
                                const dlData = downloadResponse.data?.result;
                                const directDownloadLink = dlData?.download?.high_quality || dlData?.download?.low_quality;
                                if (directDownloadLink) {
                                    await socket.sendMessage(msg.key.remoteJid, {
                                        video: { url: directDownloadLink },
                                        mimetype: 'video/mp4',
                                        caption: `🎬 *${selectedVideo.title || 'Video'}*\n⏱️ ${dlData?.duration || 'N/A'}\n\n> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`
                                    }, { quoted: msg });
                                    try { await socket.sendMessage(msg.key.remoteJid, { react: { text: '✅', key: msg.key } }); } catch (_) {}
                                } else {
                                    await socket.sendMessage(msg.key.remoteJid, { text: '❌ *Lien de téléchargement introuvable !*' }, { quoted: msg });
                                }
                            } catch (dlError) {
                                console.error('XNXX download error:', dlError.message);
                                await socket.sendMessage(msg.key.remoteJid, { text: '❌ *Échec du téléchargement. Réessayez plus tard.*' }, { quoted: msg });
                            }
                            delete global.xnxxContexts[sender];
                            return;
                        } else {
                            return await socket.sendMessage(msg.key.remoteJid, { text: `❌ *Numéro invalide ! Répondez avec un nombre entre 1 et ${context.results.length}.*` }, { quoted: msg });
                        }
                    } catch (xnxxErr) {
                        console.error('XNXX reply catcher error:', xnxxErr.message);
                        return await socket.sendMessage(msg.key.remoteJid, { text: '❌ *Une erreur est survenue. Réessayez.*' }, { quoted: msg });
                    }
                }
            }
        }
        if (!isCmd) return;

        const parts = text.slice((sessionConfig.PREFIX || '!').length).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        const match = text.slice((sessionConfig.PREFIX || '!').length).trim();

        const groupMetadata = isGroup ? await socket.groupMetadata(msg.key.remoteJid) : {};
        const participants = groupMetadata.participants || [];
        const groupAdmins = participants.filter((p) => p.admin).map((p) => p.id);

        const isBotAdmins = groupAdmins.includes(socket.user.id);
        const isAdmins = groupAdmins.includes(sender);

        const reply = async (text, options = {}) => {
            await socket.sendMessage(msg.key.remoteJid, {
                text,
                ...options
            }, {
                quoted: msg
            });
        };

function getUptime() {
    let seconds = Math.floor(process.uptime());
    let d = Math.floor(seconds / (3600 * 24));
    let h = Math.floor((seconds % (3600 * 24)) / 3600);
    let m = Math.floor((seconds % 3600) / 60);
    let s = Math.floor(seconds % 60);

    let dDisplay = d > 0 ? `${d}d ` : "";
    let hDisplay = h > 0 ? `${h}h ` : "";
    let mDisplay = m > 0 ? `${m}m ` : "";
    let sDisplay = s > 0 ? `${s}s` : "0s";
    
    return dDisplay + hDisplay + mDisplay + sDisplay;
}
        
const ARABIAN_THUMB_G = 'https://i.postimg.cc/4xXj3T8R/file-00000000f890820e9ec3d21792b1cc8b.png';
const arabianCtxGlobal = {
  forwardingScore: 999,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid  : '1120363403408693274@newsletter',
    newsletterName : 'DUBED-MD',
    serverMessageId: 143,
  },
  externalAdReply: {
    title                 : '•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴',
    body                  : 'Bot WhatsApp premium',
    thumbnailUrl          : ARABIAN_THUMB_G,
    sourceUrl             : config.CHANNEL_LINK || 'https://github.com',
    mediaType             : 1,
    renderLargerThumbnail: true,
  },
};

  const ARABIAN_TITLE = 'DUBED-MD';
  const ARABIAN_SUB   = 'Bot WhatsApp premium';

  const arabianCtx = () => ({
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid  : "120363403408693274@newsletter",
      newsletterName : ARABIAN_TITLE,
      serverMessageId: 123,
    }
  });

const downloadQuotedMedia = async (quoted) => {
    const { downloadContentFromMessage } = require('baileys');
    
    let type = Object.keys(quoted)[0];
    let msg = quoted[type];

    if (!msg || !type) return null;

    const stream = await downloadContentFromMessage(msg, type.replace('Message', ''));
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    
    return { buffer };
};


  const sendReply = text => socket.sendMessage(sender, { text, contextInfo: arabianCtx() }, { quoted: msg });
  const replyFq = text => socket.sendMessage(sender, { text, contextInfo: arabianCtx() }, { quoted: fq });
        
        if (command.startsWith('catmenu')) {
            const catNum = parseInt(command.replace('catmenu', ''), 10);
            const buttonMsg = cmd.buildCategoryButtonMessage(catNum);
            if (buttonMsg) {
                return await socket.sendMessage(sender, buttonMsg, { quoted: msg });
            }
        }

try {       
            switch (command) {


        case 'menu':
        case 'list':
        case 'panel': {
      try { await socket.sendMessage(sender, { react: { text: '🩸', key: msg.key } }); } catch (_) {}
      
      const pushname = msg.pushName || 'Guest';
      const slDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
      const slTimeNow = moment().tz('Asia/Colombo').format('HH:mm:ss');
      const botName = 'DUBED-MD';
      const totalCmds = cmd.getTotalCommandCount();

      const headerBlock =
`*╭┈───〔 DUBED-MD 〕┈───⊷*
*├⬗ Utilisateur :* ${pushname}
*├⬗ Mode :* ${sessionConfig.MODE || "public"}
*├⬗ Date :* ${slDate}
*├⬗ Heure :* ${slTimeNow}
*├⬗ Temps actif :* ${getUptime()}
*├⬗ Commandes :* ${totalCmds}
*├⬗ Préfixe :* ${sessionConfig.PREFIX || "."}
*╰───────────────────⊷*`;

      const categoryBlocks = Object.keys(cmd.SADEW_CATEGORIES)
          .map(num => cmd.buildCategoryBlock(parseInt(num)))
          .filter(Boolean)
          .join('\n\n');

      const menuText =
`${headerBlock}

${categoryBlocks}

> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

      let menuImageUrl = akira; // Default image
      if (sessionConfig.CUSTOM_LOGOS && sessionConfig.CUSTOM_LOGOS.length > 0) {
          const randomIndex = Math.floor(Math.random() * sessionConfig.CUSTOM_LOGOS.length);
          menuImageUrl = sessionConfig.CUSTOM_LOGOS[randomIndex];
      }
      const sentMenu = await socket.sendMessage(sender, {
        image: { url: menuImageUrl },
        caption: menuText,
        contextInfo: arabianCtx()
      }, { quoted: msg });

      if (sentMenu?.key?.id) {
          global.sadewMenuTracker[sender] = sentMenu.key.id;
      }

      break;
        }                    

        case 'pair': {
      try { await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } }); } catch (_) {}

      const targetNumber = (args[0] || '').replace(/[^0-9]/g, '');

      if (!targetNumber || targetNumber.length < 8) {
          return reply(
              `\`『 🔗 PAIR 』\`\n` +
              `╭───────────────────⊷\n` +
              `*┋ ▸ Veuillez fournir un numéro valide.*\n` +
              `*┋ ▸ Exemple : .pair 15551234567*\n` +
              `╰───────────────────⊷`
          );
      }

      if (targetNumber === sanitizedNumber) {
          return reply(
              `\`『 🔗 PAIR 』\`\n` +
              `╭───────────────────⊷\n` +
              `*┋ ▸ Ce numéro correspond déjà à la session active du bot.*\n` +
              `*┋ ▸ Utilisez un autre numéro pour effectuer l'association.*\n` +
              `╰───────────────────⊷`
          );
      }

      await reply(
          `\`『 🔗 PAIR 』\`\n` +
          `╭───────────────────⊷\n` +
          `*┋ ▸ Génération du code d'association pour ${targetNumber}…*\n` +
          `*┋ ▸ Cela n'affectera aucun autre bot actuellement actif.*\n` +
          `╰───────────────────⊷`
      );

      const fakeRes = {
          headersSent: false,
          status() { return this; },
          send: async (payload) => {
              fakeRes.headersSent = true;
              const code = payload && payload.code;
              if (code) {
                  await socket.sendMessage(sender, {
                      text:
                          `\`『 ✅ CODE D'ASSOCIATION 』\`\n` +
                          `╭───────────────────⊷\n` +
                          `*┋ ▸ Numéro :* ${targetNumber}\n` +
                          `*┋ ▸ Code :* ${code}\n` +
                          `╰───────────────────⊷\n\n` +
                          `Ouvrez WhatsApp ➜ Appareils connectés ➜ Associer avec un numéro de téléphone, puis saisissez ce code.\n\n` +
                          `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`,
                      contextInfo: arabianCtx()
                  }, { quoted: msg });
              } else {
                  await socket.sendMessage(sender, {
                      text: `❌ *Impossible de générer un code d'association pour ${targetNumber}. Veuillez réessayer.*`
                  }, { quoted: msg });
              }
          }
      };

      try {
          await EmpirePair(targetNumber, fakeRes);
      } catch (e) {
          await socket.sendMessage(sender, {
              text: `❌ *Erreur lors de l'association de ${targetNumber} :* ${e.message}`
          }, { quoted: msg });
      }

      break;
        }

      
    case 'ping': {
      try { await socket.sendMessage(sender, { react: { text: '☘️', key: msg.key } }); } catch (_) {}
      const start = Date.now();
      const ms    = Date.now() - start;

      await socket.sendMessage(sender, {
        text: `🏓 Pong ! ${ms} ms`
      }, { quoted: msg });

      break;
    }

case 'alive': {
    try { await socket.sendMessage(sender, { react: { text: '🍓', key: msg.key } }); } catch (_) {}
    const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    await socket.sendMessage(sender, {
        image: { url: akira },
        caption: `*╭━━〔 ✦ DUBED-MD ✦ 〕━━╮*\n┃ 🟢 *Statut :* Opérationnel\n┃ ⏱️ *Temps actif :* ${hours}h ${minutes}m ${seconds}s\n╰━━━━━━━━━━━━━━━━━━━━━━╯`,
        contextInfo: arabianCtx()
    }, { quoted: msg });

    break;
}



    case 'system': {
      try { await socket.sendMessage(sender, { react: { text: '🛸', key: msg.key } }); } catch (_) {}

      const uptime = getUptime();
      const ramUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
      const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
      const nodeVersion = process.version;
      const platform = os.platform();
      
      const slDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
      const slTimeNow = moment().tz('Asia/Colombo').format('HH:mm:ss');

      const sysInfo = `*🩸 DUBED-MD 🩸*\n\n` +
              `┃ ✨ *Informations système*\n` +
                      `┃ *TEMPS ACTIF :* ${uptime}\n` +
                      `┃ *UTILISATION RAM :* ${ramUsage} MB / ${totalRam} GB\n` +
                      `┃ *VERSION NODE :* ${nodeVersion}\n` +
                      `┃ *PLATEFORME :* ${platform}\n` +
                      `┃ *DATE :* ${slDate}\n` +
                      `┃ *HEURE :* ${slTimeNow}\n` +
              `┗━━━━━°⌜ \`DUBED-MD\` ⌟°━━━━━┛\n\n` +
                      `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

      await socket.sendMessage(sender, {
        image: { url: akira },
        caption: sysInfo,
        contextInfo: arabianCtx()
      }, { quoted: msg });

      break;
    }


case 'song':
case 'ytmp3':
case 'music':
case 'yta': {
    try {
        const query = args.join(' ');
        if (!query) return reply("🎵 *Veuillez fournir le nom d'une chanson ou un lien YouTube !*\n💡 Example: `.song master sir` or `.song <youtube link>`");

        try { await socket.sendMessage(sender, { react: { text: '🔎', key: msg.key } }); } catch (_) {}

        const API_TOKEN = "VK4fry";
        const YT_SEARCH_API = "https://whiteshadow-x-api.onrender.com/api/search/yt";
        const YT_DOWNLOAD_API = "https://whiteshadow-x-api.onrender.com/api/download/ytmp3";

        let youtubeUrl = null;
        let songTitle = "DUBED-MD Audio";

        const regex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[^\s?#]+)/i;
        const match = query.match(regex);

        if (match) {
            youtubeUrl = match[0].trim();
            reply("🔗 _Lien YouTube détecté. Récupération des données en cours…_");
        } else {
            reply(`🔍 _Recherche YouTube pour : « ${query} »…_`);
            const searchRes = await axios.get(`${YT_SEARCH_API}?q=${encodeURIComponent(query)}&apitoken=${API_TOKEN}`);
            
            if (searchRes.data && searchRes.data.success && searchRes.data.result.length > 0) {
                youtubeUrl = searchRes.data.result[0].url;
                songTitle = searchRes.data.result[0].title || songTitle;
            }
        }

        if (!youtubeUrl) {
            try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (_) {}
            return reply("❌ *Erreur :* Impossible de trouver la chanson ou la vidéo.");
        }

        reply("Extraction du MP3 haute qualité en 320 kb/s…_");
        
        let audioDownloadUrl = null;
        const dlRes = await axios.get(`${YT_DOWNLOAD_API}?url=${encodeURIComponent(youtubeUrl)}&quality=320&apitoken=${API_TOKEN}`);

        if (dlRes.data && dlRes.data.success && dlRes.data.result) {
            audioDownloadUrl = dlRes.data.result.download_url;
            songTitle = dlRes.data.result.title || songTitle;
        }

        if (!audioDownloadUrl) {
            try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (_) {}
            return reply("❌ *Erreur :* Impossible de récupérer l’audio en raison d’une indisponibilité du serveur.");
        }

        try { await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } }); } catch (_) {}

        const captionMsg = `*╭━━〔 ✦ DUBED-MD • MUSIQUE ✦ 〕━━╮*\n\n📌 *Titre :* ${songTitle}\n💿 *Qualité :* 320 kb/s — Haute qualité\n🚀 *Statut :* Téléchargement en cours…\n\n> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;
        await reply(captionMsg);

        const cleanFileName = songTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".mp3";
        
        await socket.sendMessage(sender, {
            audio: { url: audioDownloadUrl },
            mimetype: 'audio/mpeg',
            fileName: cleanFileName,
            ptt: false
        }, { quoted: msg });

        try { await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } }); } catch (_) {}

    } catch (e) {
        console.log("SONG CMD ERROR:", e);
        try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (_) {}
        reply("❌ * Erreur interne :* " + e.message);
    }
    break;
}

                    

case 'video':
case 'ytmp4':
case 'playvid': {
    try {
        const query = args.join(' ');
        if (!query) return reply("🎥 *Veuillez fournir le nom d'une vidéo ou un lien YouTube !*");

        try { await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } }); } catch (_) {}

        const API_TOKEN = "VK4fry";
        const YT_SEARCH_API = "https://whiteshadow-x-api.onrender.com/api/search/yt";
        
        const isUrl = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[^\s?#]+)/i.test(query);

        if (isUrl) {
            const url = query.match(/(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[^\s?#]+)/i)[0];
            const buttonMessage = {
                text: `*🎥 Lien vidéo détecté !*\n\n🔗 ${url}\n\n> *Choisissez la qualité vidéo ci-dessous :*`,
                footer: '•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴',
                buttons: [
                    { buttonId: `.viddl ${url} 720`, buttonText: { displayText: '🎥 720p HD' }, type: 1 },
                    { buttonId: `.viddl ${url} 480`, buttonText: { displayText: '🎞️ 480p' }, type: 1 },
                    { buttonId: `.viddl ${url} 360`, buttonText: { displayText: '📱 360p' }, type: 1 },
                    { buttonId: `.viddl ${url} 144`, buttonText: { displayText: '⬇️ 144p' }, type: 1 }
                ],
                headerType: 1
            };
            return await socket.sendMessage(sender, buttonMessage, { quoted: msg });
        }

        const searchRes = await axios.get(`${YT_SEARCH_API}?q=${encodeURIComponent(query)}&apitoken=${API_TOKEN}`);
        if (!searchRes.data || !searchRes.data.success || !searchRes.data.result || searchRes.data.result.length === 0) {
            return reply("❌ *Impossible de trouver une vidéo.*");
        }

        const topResults = searchRes.data.result.slice(0, 5); 
        let listText = `*🔍RECHERCHE VIDÉO*\n\n`;
        
        global.sadewVideoSearch[sender] = topResults.map(v => v.url);
        
        topResults.forEach((v, index) => {
            listText += `*${index + 1}.* ${v.title}\n⏱️ Durée : ${v.duration || "N/A"}\n\n`;
        });
        
        listText += `> *Répondez à ce message avec le numéro (1, 2, 3…) de la vidéo souhaitée.* (Aucun préfixe nécessaire)`;

        await socket.sendMessage(sender, { text: listText }, { quoted: msg });

    } catch (e) {
        console.log("VIDEO CMD ERROR:", e);
        reply("❌ *ERREUR : veuillez réessayer plus tard !*");
    }
    break;
}


case 'viddl': {
    let inputPath, outputPath;
    try {
        if (!args[0] || !args[1]) return;
        const url = args[0];
        const quality = args[1];

        try { await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } }); } catch (_) {}
        reply(`Téléchargement et conversion de la vidéo ${quality}p…_`);

        let downloadUrl = "";
        let videoTitle = "Sadew-MD Video";

        try {
            const zantaApiUrl = `https://api.zanta-mini.store/api/ytdl?apiKey=zan_FIAO7Ayh_eo1vllkep6&url=${encodeURIComponent(url)}&type=mp4&quality=${quality}`;
            const res1 = await axios.get(zantaApiUrl);
            if (res1.data && res1.data.success && res1.data.result && res1.data.result.download_url) {
                downloadUrl = res1.data.result.download_url;
                videoTitle = res1.data.result.title || videoTitle;
            } else {
                throw new Error("Primary API Failed");
            }
        } catch (err1) {
            try {
                const dxzApiUrl = `https://ytdl-new-dxz.vercel.app/api/ytmp4?url=${encodeURIComponent(url)}&quality=${quality}`;
                const res2 = await axios.get(dxzApiUrl);
                if (res2.data) {
                    downloadUrl = res2.data.video_url || res2.data.download_url || res2.data.url;
                    videoTitle = res2.data.title || videoTitle;
                }
            } catch (err2) {
                console.log("[SADEW-MD] All APIs Failed.");
            }
        }

        if (!downloadUrl) return reply("❌ *Erreur : impossible d'obtenir le lien de la vidéo !*");

        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');

        const tempId = crypto.randomBytes(4).toString('hex');
        inputPath = path.join(__dirname, `input_${tempId}.mp4`);
        outputPath = path.join(__dirname, `output_${tempId}.mp4`);

        const response = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        reply("⚙️ _Préparation de la vidéo pour WhatsApp…_");

        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-c:v libx264',       // Video codec required by WhatsApp
                    '-c:a aac',           // Audio codec required by WhatsApp
                    '-preset ultrafast',  // Convert quickly
                    '-crf 28',            // Balance out the quality
                    '-movflags +faststart' // So it can start playing right away
                ])
                .save(outputPath)
                .on('end', resolve)
                .on('error', (err) => {
                    console.error("FFMPEG ERROR:", err);
                    reject(err);
                });
        });

        const slDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
        const slTimeNow = moment().tz('Asia/Colombo').format('HH:mm:ss');

        let caption = `*DUBED-MD*\n\n` +
                      `🎬 *Titre :* ${videoTitle}\n` +
                      `📺 *Qualité :* ${quality}p\n` +
                      `__________________________\n\n` +
                      `📅 *Date :* ${slDate} | ⌚ *Heure :* ${slTimeNow}\n\n` +
                      `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        await socket.sendMessage(sender, {
            video: fs.readFileSync(outputPath),
            mimetype: 'video/mp4',
            caption: caption,
            fileName: `Sadew_Video_${quality}p.mp4`
        }, { quoted: msg });

        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

        try { await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } }); } catch (_) {}

    } catch (e) {
        console.log("VIDDL CMD ERROR:", e);
        reply("❌ *ERREUR : impossible de télécharger cette vidéo !*");
        
        const fs = require('fs');
        try {
            if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (err) {}
    }
    break;
}
                    
case 'fb':
case 'facebook': {
    try {
        const query = args.join(' ');
        if (!query) return reply("🔗 *Envoyez-moi un lien vidéo !*");
        
        if (!query.includes('facebook.com') && !query.includes('fb.watch')) {
            return reply("❌ *Ce lien Facebook n'est pas valide !*");
        }

        try { await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } }); } catch (_) {}

        const fbRes = await axios.get(`https://www.movanest.xyz/v2/fbdown?url=${encodeURIComponent(query)}`);
        
        if (!fbRes.data.status || !fbRes.data.results.length) {
            return reply("❌ *Impossible de récupérer le lien vidéo !*");
        }

        const videoData = fbRes.data.results[0];
        const videoUrl = videoData.hdQualityLink || videoData.normalQualityLink; 
        const quality = videoData.hdQualityLink ? 'High Definition (HD)' : 'Standard (SD)';

        const response = await axios.get(videoUrl, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        const videoBuffer = Buffer.from(response.data);
        const fileSizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(2);

        const slDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
        const slTimeNow = moment().tz('Asia/Colombo').format('HH:mm:ss');

        const caption = `*DUBED-MD*\n\n` +
                        `🎬 *Titre :* ${videoData.title !== "No video title" ? videoData.title : 'Facebook Video'}\n` +
                        `⏱️ *Durée :* ${videoData.duration}\n` +
                        `📺 *Qualité :* ${quality}\n` +
                        `⚖️ *Taille :* ${fileSizeMB} Mo\n` +
                        `__________________________\n\n` +
                        `📅 *Date :* ${slDate} | ⌚ *Heure :* ${slTimeNow}\n\n` +
                        `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        await socket.sendMessage(sender, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            caption: caption,
            fileName: `fb_video_${slTimeNow}.mp4`
        }, { quoted: msg });

        try { await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } }); } catch (_) {}

    } catch (e) {
        console.log("FB CMD ERROR:", e);
        reply("❌ *Erreur de l'API !*");
        try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (_) {}
    }
    break;
}


case 'tiktok':
case 'tt': {
    try {
        const query = args.join(' ');
        if (!query) return reply("🔗 *Envoyez-moi un lien TikTok !*");
        
        const tiktokRegex = /(tiktok\.com|vt\.tiktok\.com)/;
        if (!tiktokRegex.test(query)) {
            return reply("❌ *Ce lien TikTok n'est pas valide !*");
        }

        try { await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } }); } catch (_) {}

        const https = require("https");
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });

        const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(query)}`;
        const response = await axios.get(apiUrl, { httpsAgent, timeout: 15000 });
        const data = response.data;

        if (!data || !data.data) {
            return reply("❌ *Impossible de récupérer la vidéo !*");
        }

        const videoUrl = data.data.hdplay || data.data.play;
        if (!videoUrl) throw new Error("No video URL found.");

        const isHD = data.data.hdplay ? "High Quality (HD) ✅" : "Normal Quality ⚠️";
        const title = data.data.title || "TikTok Video";

        const videoStream = await axios.get(videoUrl, {
            httpsAgent,
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        
        const videoBuffer = Buffer.from(videoStream.data);
        const fileSizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(2);

        const slDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
        const slTimeNow = moment().tz('Asia/Colombo').format('HH:mm:ss');

        const caption = `*DUBED-MD*\n\n` +
                        `*TITLE :* ${title}\n` +
                        `*QUALITY :* ${isHD}\n` +
                        `⚖️ *Taille :* ${fileSizeMB} Mo\n` +
                        `🔖 *Filigrane :* Non\n` +
                        `__________________________\n\n` +
                        `📅 *Date :* ${slDate} | ⌚ *Heure :* ${slTimeNow}\n\n` +
                        `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        if (videoBuffer.length > 40 * 1024 * 1024) {
            await socket.sendMessage(sender, {
                document: videoBuffer,
                mimetype: "video/mp4",
                fileName: `tiktok_HD_${slTimeNow}.mp4`,
                caption: caption
            }, { quoted: msg });
        } else {
            await socket.sendMessage(sender, {
                video: videoBuffer,
                mimetype: 'video/mp4',
                caption: caption,
                fileName: `tiktok_HD_${slTimeNow}.mp4`
            }, { quoted: msg });
        }

        try { await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } }); } catch (_) {}

    } catch (e) {
        console.log("TIKTOK CMD ERROR:", e);
        let errorMsg = e.message.includes("timeout")
            ? "❌ *Timeout:* Server took too long."
            : "❌ *Une erreur inattendue est survenue.*";
        reply(errorMsg);
        try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (_) {}
    }
    break;
}  
case 'ttp': {
    try {
        const axios = require("axios");
        const fs = require("fs/promises");
        const path = require("path");
        const os = require("os");
        const { spawn } = require("child_process");
        const moment = require('moment-timezone');
        
        const ffmpegPath = require('ffmpeg-static'); 

        let query = args.join(' ');
        if (!query && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation) {
            query = msg.message.extendedTextMessage.contextInfo.quotedMessage.conversation;
        } else if (!query && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text) {
            query = msg.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage.text;
        }

        const extractUrl = (text) => {
            const match = String(text || "").match(/https?:\/\/[^\s]+/i);
            return match ? match[0].replace(/[),.]+$/, "") : "";
        };
        
        const tiktokUrl = extractUrl(query);
        const quality = /\b(normal|sd|720)\b/i.test(query) ? "normal" : "hd";

        if (!tiktokUrl) return reply("🎥 *Veuillez fournir un lien vers un diaporama photo TikTok !*");
        if (!/tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com/i.test(tiktokUrl)) {
            return reply("❌ *Ce lien TikTok n'est pas valide !*");
        }

        try { await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } }); } catch (_) {}
        reply("📥 _Préparation de la vidéo photo TikTok… veuillez patienter. ⏳_");

        const TIKWM_API = "https://www.tikwm.com/api/";
        const MAX_IMAGES = 30;
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        
        const buildTikwmUrl = (url) => (!url ? "" : /^https?:\/\//i.test(url) ? url : `https://www.tikwm.com${url.startsWith("/") ? "" : "/"}${url}`);
        
        const fetchTikwmData = async (url) => {
            for (let i = 1; i <= 3; i++) {
                try {
                    const res = await axios.get(TIKWM_API, { params: { url, hd: 1 }, headers: { "User-Agent": "Mozilla/5.0" }});
                    if (res.data?.code === 0) return res.data;
                } catch (e) { if (i < 3) await sleep(2000); }
            }
            throw new Error("Could not fetch data from the TikTok API.");
        };

        const pickImages = (data) => {
            const root = data?.data || {};
            const lists = [root.images, root.image_post?.images];
            const set = new Set();
            for (const list of lists) {
                if (Array.isArray(list)) list.forEach(img => {
                    if (typeof img === 'string') set.add(buildTikwmUrl(img));
                    else if (img?.url || img?.display_image) set.add(buildTikwmUrl(img.url || img.display_image));
                });
            }
            return [...set].slice(0, MAX_IMAGES);
        };

        const downloadBuffer = async (url, isAudio = false) => {
            const res = await axios.get(url, { responseType: "arraybuffer", headers: { "User-Agent": "Mozilla/5.0" } });
            return { buffer: Buffer.from(res.data), type: isAudio ? ".mp3" : ".jpg" };
        };

        const getAudioDuration = (audioPath) => {
            return new Promise((resolve) => {
                const child = spawn(ffmpegPath, ["-i", audioPath]);
                let output = "";
                child.stderr.on("data", d => output += d);
                child.on("close", () => {
                    const match = output.match(/Durée : (\d{2}):(\d{2}):(\d{2}\.\d+)/);
                    if (match) {
                        const hours = parseInt(match[1], 10);
                        const minutes = parseInt(match[2], 10);
                        const seconds = parseFloat(match[3]);
                        resolve((hours * 3600) + (minutes * 60) + seconds);
                    } else {
                        resolve(15); 
                    }
                });
                child.on("error", () => resolve(15));
            });
        };

        const runCommand = (cmd, args) => {
            return new Promise((resolve, reject) => {
                const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
                let out = ""; child.stdout.on("data", d => out += d);
                let err = ""; child.stderr.on("data", d => err += d);
                
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    reject(new Error("FFmpeg Process Timeout! The process got stuck."));
                }, 180000);

                child.on("close", code => {
                    clearTimeout(timer);
                    code === 0 ? resolve(out) : reject(new Error(`FFmpeg Failed: ${err.slice(-500)}`));
                });
                child.on("error", (e) => {
                    clearTimeout(timer);
                    reject(new Error(`FFmpeg error: ${e.message}`));
                });
            });
        };

        const createVideo = async (imagePaths, audioPath, outPath, qlty) => {
            const profile = qlty === "hd" ? { w: 720, h: 1280 } : { w: 720, h: 1280 };
            const scaleFilter = `scale=${profile.w}:${profile.h}:force_original_aspect_ratio=decrease,pad=${profile.w}:${profile.h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;

            const listPath = path.join(path.dirname(outPath), "images.txt");
            let listBody = "";

            if (imagePaths.length === 1) {
                listBody += `file '${imagePaths[0].replace(/\\/g, "/")}'\n`;
                listBody += `duration 600.000\n`; 
                listBody += `file '${imagePaths[0].replace(/\\/g, "/")}'\n`;
            } else {
                let audioDuration = await getAudioDuration(audioPath);
                if (!audioDuration || audioDuration <= 0) audioDuration = 15; 
                
                const eachDuration = audioDuration / imagePaths.length;
                for (let i = 0; i < imagePaths.length; i++) {
                    listBody += `file '${imagePaths[i].replace(/\\/g, "/")}'\n`;
                    if (i === imagePaths.length - 1) {
                        listBody += `duration 600.000\n`; 
                    } else {
                        listBody += `duration ${eachDuration.toFixed(3)}\n`;
                    }
                }
                listBody += `file '${imagePaths[imagePaths.length - 1].replace(/\\/g, "/")}'\n`;
            }

            await fs.writeFile(listPath, listBody);

            await runCommand(ffmpegPath, [
                "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-i", audioPath,
                "-vf", scaleFilter,
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
                "-c:a", "aac", "-shortest", "-fflags", "+genpts", "-movflags", "+faststart", outPath
            ]);
            return profile;
        };

        const result = await fetchTikwmData(tiktokUrl);
        const images = pickImages(result);
        const audioUrl = buildTikwmUrl(result.data?.music_info?.play || result.data?.music);
        
        if (!images.length || !audioUrl) throw new Error("This is not a photo slideshow, or the audio could not be fetched.");

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sadew-ttp-"));
        let finalVideoBuffer;
        let videoMeta;

        try {
            const imagePaths = [];
            for (let i = 0; i < images.length; i++) {
                const img = await downloadBuffer(images[i], false);
                const p = path.join(tmpDir, `img${i}${img.type}`);
                await fs.writeFile(p, img.buffer);
                imagePaths.push(p);
            }
            const aud = await downloadBuffer(audioUrl, true);
            const audPath = path.join(tmpDir, `aud${aud.type}`);
            await fs.writeFile(audPath, aud.buffer);

            const outPath = path.join(tmpDir, "out.mp4");
            videoMeta = await createVideo(imagePaths, audPath, outPath, quality);
            finalVideoBuffer = await fs.readFile(outPath);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }

        const slDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
        const slTimeNow = moment().tz('Asia/Colombo').format('HH:mm:ss');
        const fileSizeMB = (finalVideoBuffer.length / (1024 * 1024)).toFixed(2);

        const caption = `*╭━━〔 ✦ DUBED-MD ✦ 〕━━╮*\n\n` +
                        `🎬 *Titre :* Vidéo photo TikTok\n` +
                        `📸 *Images :* ${images.length}\n` +
                        `📺 *Qualité :* ${videoMeta.w}x${videoMeta.h}\n` +
                        `⚖️ *Taille :* ${fileSizeMB} Mo\n` +
                        `__________________________\n\n` +
                        `📅 *Date :* ${slDate} | ⌚ *Heure :* ${slTimeNow}\n\n` +
                        `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        try { await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } }); } catch (_) {}

        await socket.sendMessage(sender, {
            video: finalVideoBuffer,
            mimetype: 'video/mp4',
            caption: caption,
            fileName: `Sadew_TikTok_${slTimeNow}.mp4`
        }, { quoted: msg });

        try { await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } }); } catch (_) {}

    } catch (e) {
        console.log("TTP CMD ERROR:", e);
        reply(`❌ *ERREUR :* ${e.message || "Unknown error"}\n\nVeuillez essayer avec un autre lien !`);
        try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (_) {}
    }
    break;
}

case 'ai':
case 'cuty': {
    try { await socket.sendMessage(sender, { react: { text: '🍫', key: msg.key } }); } catch (_) {}
    const { NiyoXClient } = require("niyox");
    const title = "DUBED-MD • ASSISTANT";
    const footer = "> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*";

    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: "Allez-y, écrivez-moi quelque chose. Je suis prêt à vous répondre. ✨" }, { quoted: msg });
    }

    const prompt = `Tu es un ami chaleureux, bienveillant et naturel qui discute avec quelqu’un sur WhatsApp. Réponds toujours en français naturel et professionnel, avec un ton humain, amical et décontracté. Si le message contient uniquement des emojis, tu peux répondre uniquement avec des emojis. Tiens compte du contexte de la conversation et réponds de manière adaptée. Limite tes réponses à 300 caractères. Évite les salutations génériques et les formulations de support client. Ton nom est DUBED-MD. Si quelqu’un demande qui t’a créé, réponds : •!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴. Message de l’utilisateur : ${q}`;

    try {
        const client = new NiyoXClient({ sessionId: sender, timeout: 15000 });
        const response = await client.chat(prompt);

        const aiResponse = response?.result;

        if (!aiResponse) {
            return await socket.sendMessage(sender, { text: "❌ Désolé, une erreur inattendue est survenue." }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            image: { url: akira },
            caption: `${title}\n\n${aiResponse}\n\n${footer}`,
            contextInfo: arabianCtx() 
        }, { quoted: msg });

    } catch (err) {
        console.error("NiyoX Error:", err.message);
        await socket.sendMessage(sender, { text: "❌ Veuillez patienter un instant avant de réessayer." }, { quoted: msg });
    }
    break;
}

case 'darkai':
case 'wormgpt': {
    try {
        const query = args.join(' ');
        if (!query) return reply("❌ *Veuillez saisir une question ou une commande.*\n\n💡 Exemple : `.darkai votre demande`");

        const from = msg.key.remoteJid;

        await socket.sendMessage(from, { react: { text: '💀', key: msg.key } });
        let initialMsg = await socket.sendMessage(from, { text: '👾 *Traitement en cours…* ⏳' }, { quoted: msg });

        const WOLF_API_KEY = "wxa_f_4e840b5e42";
        const targetUrl = `https://apis.xwolf.space/api/ai/wormgpt?q=${encodeURIComponent(query)}&key=${WOLF_API_KEY}`;
        
        const response = await axios.get(targetUrl, { timeout: 40000 });

        if (response.data) {
            const aiReply = response.data.result || response.data.response || response.data.reply;

            if (aiReply) {
                const finalMessage = `*ORION DARK GPT*\n\n` +
                                     `${aiReply}\n\n` +
                                     `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

                await socket.sendMessage(from, {
                    text: finalMessage,
                    edit: initialMsg.key
                });
                
                await socket.sendMessage(from, { react: { text: '✅', key: msg.key } });

            } else {
                await socket.sendMessage(from, { 
                    text: `❌ *Réponse brute de WormGPT :*\n\n${JSON.stringify(response.data, null, 2)}`,
                    edit: initialMsg.key
                });
            }
        } else {
            await socket.sendMessage(from, { 
                text: "❌ *Erreur :* l’API a renvoyé une réponse vide.",
                edit: initialMsg.key
            });
            await socket.sendMessage(from, { react: { text: '❌', key: msg.key } });
        }

    } catch (e) {
        console.log("WORM-GPT ERROR:", e);
        try { 
            await socket.sendMessage(msg.key.remoteJid, { text: `❌ *Erreur de l’API WormGPT :* ${e.message}` });
            await socket.sendMessage(msg.key.remoteJid, { react: { text: '❌', key: msg.key } }); 
        } catch (_) {}
    }
    break;
}
					
        
case 'vv': {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted) return reply(`Répondez à un média à vue unique avec *.vv*`);
      try {
        const media = await downloadQuotedMedia(quoted);
        if (!media?.buffer) return reply('Impossible de télécharger ce média.');
        const qt = MEDIA_TYPES.find(t => quoted[t]);
        
        if (qt === 'imageMessage') {
          await socket.sendMessage(sender, { image: media.buffer, caption: 'Vue unique récupérée 👀', contextInfo: arabianCtx() }, { quoted: msg });
        } else if (qt === 'videoMessage') {
          await socket.sendMessage(sender, { video: media.buffer, caption: 'Vue unique récupérée 👀', contextInfo: arabianCtx() }, { quoted: msg });
        } else if (qt === 'audioMessage') {
          await socket.sendMessage(sender, { audio: media.buffer, mimetype: media.mime || 'audio/mpeg', ptt: quoted.audioMessage?.ptt, contextInfo: arabianCtx() }, { quoted: msg });
        } else if (qt === 'stickerMessage') {
          await socket.sendMessage(sender, { sticker: media.buffer, contextInfo: arabianCtx() }, { quoted: msg });
        } else {
          await socket.sendMessage(sender, { document: media.buffer, mimetype: media.mime || 'application/octet-stream', fileName: media.fileName || 'file', contextInfo: arabianCtx() }, { quoted: msg });
        }
        
        try { await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } }); } catch (_) {}
      } catch (e) { await reply(`Échec : ${e.message}`); }
      break;
    }


    case 'active': {
      if (!isOwner && !isDevUser) return reply('Cette commande est réservée au propriétaire ou au développeur.');
      
      const sockets = typeof activeSockets !== 'undefined' ? activeSockets : new Map();
      const nums = Array.from(sockets.keys());
      
      const responseText = `*↳ ❝ [ACTIVE SESSIONS] ¡! ❞*\n\n` +
                           `> *\`📡 𝙲𝙾𝚄𝙽𝚃 :\`* ${nums.length}\n\n` +
                           `${nums.map((n, i) => `> *\`${i + 1}.\`* +${n}`).join('\n')}\n\n` +
                           `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;
                           
      await reply(responseText);
      break;
    }
case 'xnxx':
case 'xxx': {
    try {
        const query = args.join(' ');
        if (!query) return await socket.sendMessage(sender, { text: '🔗 *Envoyez-moi une recherche !*\n\nExemple : `.xnxx votre recherche`' }, { quoted: msg });

        try { await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } }); } catch (_) {}

        if (!global.xnxxContexts) global.xnxxContexts = {};

const searchApiUrl = `https://api.zanta-mini.store/api/xnxx/search?apiKey=zan_FIAO7Ayh_eo1vllkep6&url=${encodeURIComponent(query)}`;
        
        let searchResponse;
        try {
            searchResponse = await axios.get(searchApiUrl, { timeout: 15000 });
        } catch (apiErr) {
            console.error('XNXX search API error:', apiErr.message);
            return await socket.sendMessage(sender, { text: "❌ *Échec de la recherche : erreur de l'API. Réessayez plus tard.*" }, { quoted: msg });
        }

        const results = searchResponse.data?.results || [];
        
        if (!results || !results.length) {
            return await socket.sendMessage(sender, { text: '🤷‍♀️ *Aucun résultat trouvé pour :* ' + query }, { quoted: msg });
        }

        global.xnxxContexts[sender] = { results: results.slice(0, 15) };

        let listText = `*🔍 RECHERCHE*\n*🔎 Recherche :* _${query}_\n*📊 Résultats :* ${Math.min(results.length, 15)}\n\n`;

        results.slice(0, 15).forEach((video, idx) => {
            listText += `*${idx + 1}.* ${video.title || 'No title'}\n\n`;
        });

        listText += `\n*📩 Répondez avec le numéro de la liste ci-dessus (1-${Math.min(results.length, 15)}) pour télécharger.*\n\n> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        await socket.sendMessage(sender, { text: listText }, { quoted: msg });
        try { await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } }); } catch (_) {}

    } catch (err) {
        console.error('XNXX command error:', err.message);
        try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (_) {}
        await socket.sendMessage(sender, { text: '❌ *Échec de la recherche.*' }, { quoted: msg });
    }
    break;
}

    case 'npm': {
      const pkg = args[0]?.trim();
      if (!pkg) return reply(`Utilisation : .npm <package>`);
      
      try {
        const res = await axios.get(`https://registry.npmjs.org/${pkg}`, { timeout: 10000 });
        const d = res.data;
        
        const npmInfo = `*↳ ❝ [DUBED-MD] ¡! ❞*\n` +
                        `⊹₊⟡⋆ 𝗡𝗮𝗺𝗲 - ${d.name} 𝜗𝜚⋆\n\n` +
                        `> *\`📦 𝚅𝙴𝚁𝚂𝙸𝙾𝙽 :\`* ${d['dist-tags']?.latest || 'N/A'}\n` +
                        `> *\`📝 𝙳𝙴𝚂𝙲 :\`* ${(d.description || 'N/A').slice(0, 100)}\n` +
                        `> *\`👤 𝙰𝚄𝚃𝙷𝙾𝚁 :\`* ${d.author?.name || 'N/A'}\n` +
                        `> *\`📄 𝙻𝙸𝙲𝙴𝙽𝚂𝙴 :\`* ${d.license || 'N/A'}\n` +
                        `> *\`🔗 𝙻𝙸𝙽𝙺 :\`* https://npmjs.com/package/${d.name}\n\n` +
                        `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        await socket.sendMessage(sender, { 
          image: { url: akira },
          caption: npmInfo, 
          contextInfo: typeof arabianCtx === 'function' ? arabianCtx() : {} 
        }, { quoted: msg });

      } catch (e) { 
        await reply(`Package introuvable : ${pkg}`); 
      }
      break;
    }





                    

case 'gimg':
case 'img': {
  const q = args.join(' ').trim();
  if (!q) return reply(`Utilisation : .gimg <recherche>`);
  try {
    await socket.sendMessage(sender, {
      react: { text: '🖼️', key: msg.key }
    });
  } catch (_) {}

  try {
    const res = await axios.get(
      `https://www.movanest.xyz/v2/pinterest?query=${encodeURIComponent(q)}&pageSize=10`
    );

    if (res.data && res.data.results && res.data.results.length > 0) {
      const random =
        res.data.results[
          Math.floor(Math.random() * res.data.results.length)
        ];

      const imgUrl = random.image;
      await socket.sendMessage(
        sender,
        {
          image: { url: imgUrl },
          caption:
`*DUBED-MD IMGS*

*₊❏❜ ⋮ 🔍 Search:* ${q}

> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`
        },
          { quoted: msg }
      );
    } else {
      await reply(`Impossible de trouver ce contenu !`);
    }
  } catch (e) {
    console.error(e);
    await reply(`Échec de la recherche d'images :\n${e.message}`);
  }
  break;
}


    case 'getdp':
    case 'pfp': {
      try {
        const qCtx = msg.message?.extendedTextMessage?.contextInfo;
        let target;
        if (qCtx?.mentionedJid?.[0]) {
          target = qCtx.mentionedJid[0];
        } else if (qCtx?.participant) {
          target = qCtx.participant;
        } else if (args[0]?.replace(/[^0-9]/g, '')) {
          target = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        } else {
          target = sender;
        }

        let dpUrl;
        try {
          dpUrl = await socket.profilePictureUrl(target, 'image');
        } catch (e) {
          return reply('Photo de profil indisponible ou protégée par les paramètres de confidentialité.');
        }

        await socket.sendMessage(sender, { 
          image: { url: dpUrl }, 
          caption: `*↳ ❝ [🩸 DUBED-MD 🩸] ¡! ❞*\n\n📷 Profile picture of @${target.split('@')[0]}`, 
          mentions: [target] 
        }, { quoted: msg });

      } catch (err) {
        console.error(err);
        reply('Une erreur inattendue est survenue.');
      }
      break;
    }


    case 'tagall': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      try {
        const gm       = await socket.groupMetadata(sender);
        const ps       = gm.participants || [];
        const admins   = ps.filter(p => p.admin);
        const userJid  = msg.key.participant || sender;
        const tm       = args.join(' ').trim() || '*Attention everyone!*';
        const mentions = [...ps.map(p => p.id), userJid];

        let text = `╭─⊹₊⟡⋆『 \`𝐓𝐚𝐠 𝐀𝐥𝐥\` 』𖤐.ᐟ\n` +
                   `┊ ☘️⋆: 𝙶𝚁𝙾𝚄𝙿   ${gm.subject}\n` +
                   `┊ ☘️⋆: 𝙼𝙴𝙼𝙱𝙴𝚁𝚂 ${ps.length}\n` +
                   `┊ ☘️⋆: 𝙰𝙳𝙼𝙸𝙽𝚂  ${admins.length}\n` +
                   `┊ ☘️⋆ : 𝚄𝚂𝙴𝚁    @${userJid.split('@')[0]}\n` +
                   `╰──────────────────<𝟑 .ᐟ\n\n` +
                   `*┃* ${tm}\n*┃*\n`;
        for (const p of ps) text += `*┃* @${p.id.split('@')[0]}\n`;
        text += `╰──────────────────<𝟑 .ᐟ\n\n> BY •!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴`;
        await socket.sendMessage(sender, { text, mentions }, { quoted: msg });
      } catch (e) { await reply(`Échec de la mention de tous les membres : ${e.message}`); }
      break;
    }

    case 'hidetag': {
      if (!isGroup) return reply('*Cette commande fonctionne uniquement dans les groupes.*');
      try {
        const gm = await socket.groupMetadata(sender);
        await socket.sendMessage(sender, { text: args.join(' ').trim() || '*🗣️ Attention à tous !*', mentions: gm.participants.map(p => p.id) }, { quoted: msg });
      } catch (e) { await reply(`*Échec de la mention silencieuse : ${e.message}*`); }
      break;
    }

case 'add': {
    if (!isOwner) {
        return await socket.sendMessage(sender, {
            text: '👥 Cette commande est réservée au propriétaire du bot.'
        }, { quoted: msg });
    }

   if (!isGroup) {
        return await socket.sendMessage(sender, {
            text: '👥 Cette commande fonctionne uniquement dans un groupe.'
        }, { quoted: msg });
    }

    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || '';

    const number = q.trim().replace(/[^0-9]/g, '');
    if (!number) {
        return await socket.sendMessage(sender, { 
            text: '*❗ Veuillez fournir un numéro de téléphone !* \n📋 Example: .add 55xxxxxxx' 
        });
    }

    try {
        await socket.sendMessage(sender, { react: { text: '➕', key: msg.key } });

        const userJid = number + '@s.whatsapp.net';
        await socket.groupParticipantsUpdate(msg.key.remoteJid, [userJid], 'add');

        await socket.sendMessage(sender, { 
            text: `*✅ Successfully added +${number} to the group!*` 
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (err) {
        console.error('Add Error:', err);
        await socket.sendMessage(sender, { 
            text: `*❌ Impossible d'ajouter le membre !*\n*Raison :* ${err.message}` 
        });
    }
    break;
}

    case 'kick':
    case 'remove': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      const qCtx   = msg.message?.extendedTextMessage?.contextInfo;
      const target = qCtx?.participant || (args[0]?.replace(/[^0-9]/g,'') ? args[0].replace(/[^0-9]/g,'') + '@s.whatsapp.net' : null);
      if (!target) return reply(`Répondez au message d’un utilisateur ou utilisez : ${sessionConfig.PREFIX || '!'}kick <number>`);
      try { await socket.groupParticipantsUpdate(sender, [target], 'remove'); await reply(`✅ Utilisateur ${target.split('@')[0]} retiré avec succès.`); }
      catch (e) { await reply(`Échec de l'expulsion : ${e.message}`); }
      break;
    }

    case 'bio':
    case 'setbio': {
      const text = args.join(' ').trim();
      if (!text) return reply(`Utilisation : ${sessionConfig.PREFIX || '!'}bio <texte>`);
      try { await socket.updateProfileStatus(text); await reply(`✅ Bio mise à jour : ${text}`); }
      catch (e) { await reply(`Échec : ${e.message}`); }
      break;
    }

                                                
    case 'tagadmin': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      try {
        const gm       = await socket.groupMetadata(sender);
        const admins   = gm.participants.filter(p => p.admin);
        if (!admins.length) return reply('Aucun administrateur trouvé dans ce groupe.');
        const userJid  = msg.key.participant || sender;
        const tm        = args.join(' ').trim() || '*Attention admins!*';
        const mentions  = [...admins.map(p => p.id), userJid];

        let text = `╭─⊹₊⟡⋆『 \`𝐀𝐝𝐦𝐢𝐧 𝐓𝐚𝐠\` 』𖤐.ᐟ\n` +
                   `┊ ☘️⋆ : 𝙶𝚁𝙾𝚄𝙿   ${gm.subject}\n` +
                   `┊ ☘️⋆ : 𝙼𝙴𝙼𝙱𝙴𝚁𝚂 ${gm.participants.length}\n` +
                   `┊ ☘️⋆ : 𝙰𝙳𝙼𝙸𝙽𝚂  ${admins.length}\n` +
                   `┊ ☘️⋆ : 𝚄𝚂𝙴𝚁    @${userJid.split('@')[0]}\n` +
                   `╰──────────────────<𝟑 .ᐟ\n\n` +
                   `*┃* ${tm}\n*┃*\n`;
        for (const p of admins) text += `*┃* @${p.id.split('@')[0]}\n`;
        text += `╰──────────────────<𝟑 .ᐟ\n\n> BY •!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴`;
        await socket.sendMessage(sender, { text, mentions }, { quoted: msg });
      } catch (e) { await replyFq(`tagadmin failed: ${e.message}`); }
      break;
    }

    case 'promote': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      const qCtxP   = msg.message?.extendedTextMessage?.contextInfo;
      const targetP = qCtxP?.participant || (args[0]?.replace(/[^0-9]/g,'') ? args[0].replace(/[^0-9]/g,'') + '@s.whatsapp.net' : null);
      if (!targetP) return reply(`Répondez au message d’un utilisateur ou utilisez : ${sessionConfig.PREFIX || '!'}promote <number>`);
      try {
        await socket.groupParticipantsUpdate(sender, [targetP], 'promote');
        await reply(`✅ @${targetP.split('@')[0]} a été promu administrateur.`);
      } catch (e) { await reply(`Échec de la promotion : ${e.message}`); }
      break;
    }

    case 'demote': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      const qCtxD   = msg.message?.extendedTextMessage?.contextInfo;
      const targetD = qCtxD?.participant || (args[0]?.replace(/[^0-9]/g,'') ? args[0].replace(/[^0-9]/g,'') + '@s.whatsapp.net' : null);
      if (!targetD) return reply(`Répondez au message d’un utilisateur ou utilisez : ${sessionConfig.PREFIX || '!'}demote <number>`);
      try {
        await socket.groupParticipantsUpdate(sender, [targetD], 'demote');
        await reply(`✅ @${targetD.split('@')[0]} n'est plus administrateur.`);
      } catch (e) { await reply(`Échec de la rétrogradation : ${e.message}`); }
      break;
    }

    case 'lockgroup': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      try {
        await socket.groupSettingUpdate(sender, 'announcement');
        await reply('🔒 Groupe verrouillé — seuls les administrateurs peuvent envoyer des messages.');
      } catch (e) { await replyFq(`Lock failed: ${e.message}`); }
      break;
    }

    case 'unlockgroup': {
      if (!isGroup) return replyFq('Cette commande fonctionne uniquement dans les groupes.');
      try {
        await socket.groupSettingUpdate(sender, 'not_announcement');
        await reply('🔓 Groupe déverrouillé — tous les membres peuvent envoyer des messages.');
      } catch (e) { await reply(`Échec du déverrouillage : ${e.message}`); }
      break;
    }

    case 'mute': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      const durStr = (args[0] || '').toLowerCase();
      const durMap = { '1h': 3600, '6h': 21600, '1d': 86400, '7d': 604800 };
      const secs   = durMap[durStr];
      if (!secs) return reply(`Utilisation : .mute <1h|6h|1d|7d>`);
      try {
        await socket.groupSettingUpdate(sender, 'announcement');
        await reply(`🔇 Groupe mis en sourdine pendant *${durStr}*. Utilisez *.unmute* pour rétablir les messages plus tôt.`);
        setTimeout(async () => {
          try { await socket.groupSettingUpdate(sender, 'not_announcement'); } catch (_) {}
        }, secs * 1000);
      } catch (e) { await reply(`Échec de la mise en sourdine : ${e.message}`); }
      break;
    }

    case 'unmute': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      try {
        await socket.groupSettingUpdate(sender, 'not_announcement');
        await reply('🔊 Groupe réactivé — tous les membres peuvent envoyer des messages.');
      } catch (e) { await reply(`Échec de la réactivation : ${e.message}`); }
      break;
    }

    case 'groupinfo': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      try {
        const gm      = await socket.groupMetadata(sender);
        const total   = gm.participants.length;
        const admCnt  = gm.participants.filter(p => p.admin).length;
        const created = gm.creation ? new Date(gm.creation * 1000).toLocaleDateString() : 'Unknown';
        await reply(
          `*GROUP INFO*\n\n` +
          `❏ ⋮ *\`𝙽𝙰𝙼𝙴 :\`* ${gm.subject}\n` +
          `❏ ⋮ *\`𝙹𝙸𝙳 :\`* ${gm.id}\n` +
          `❏ ⋮ *\`𝙳𝙴𝚂𝙲 :\`* ${(gm.desc || 'None').slice(0, 100)}\n` +
          `❏ ⋮ *\`𝙼𝙴𝙼𝙱𝙴𝚁𝚂 :\`* ${total}\n` +
          `❏ ⋮ *\`𝙰𝙳𝙼𝙸𝙽𝚂 :\`* ${admCnt}\n` +
          `❏ ⋮ *\`𝙲𝚁𝙴𝙰𝚃𝙴𝙳 :\`* ${created}\n\n` +
          `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`
        );
      } catch (e) { await reply(`Échec des informations du groupe : ${e.message}`); }
      break;
    }

    case 'setname': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      const newName = args.join(' ').trim();
      if (!newName) return reply(`Utilisation : .setname <nouveau nom>`);
      try {
        await socket.groupUpdateSubject(sender, newName);
        await reply(`✅ Nom du groupe modifié : *${newName}*`);
      } catch (e) { await reply(`Échec du changement de nom : ${e.message}`); }
      break;
    }

    case 'setdesc': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      const newDesc = args.join(' ').trim();
      if (!newDesc) return reply(`Utilisation : .setdesc <description>`);
      try {
        await socket.groupUpdateDescription(sender, newDesc);
        await reply(`✅ Description du groupe mise à jour.`);
      } catch (e) { await reply(`Échec de la modification de la description : ${e.message}`); }
      break;
    }


case 'seticon': {
    if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
    
    const groupId = msg.key.remoteJid; 

    const quotedIcon = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedIcon?.imageMessage) return reply(`Répondez à une image avec *.seticon*`);

    try {
        const media = await downloadQuotedMedia(quotedIcon);
        
        if (!media || !media.buffer) return reply("Impossible de télécharger l’image.");

        await socket.updateProfilePicture(groupId, media.buffer);
        
        await reply('✅ Icône du groupe mise à jour avec succès.');
    } catch (e) { 
        console.log(e);
        await reply(`Échec de la modification de l'icône : ${e.message}`); 
    }
    break;
}
                    

    case 'linkgroup': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      try {
        const code = await socket.groupInviteCode(sender);
        await reply(`🔗 *Lien d'invitation du groupe :*\nhttps://chat.whatsapp.com/${code}`);
      } catch (e) { await reply(`Échec de la génération du lien : ${e.message}`); }
      break;
    }

    case 'revokelink': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      try {
        const newCode = await socket.groupRevokeInvite(sender);
        await reply(`✅ Lien d'invitation révoqué.\n🔗 *Nouveau lien :*\nhttps://chat.whatsapp.com/${newCode}`);
      } catch (e) { await reply(`Échec de la révocation du lien : ${e.message}`); }
      break;
    }

    case 'leave': {
      if (!isGroup) return reply('Cette commande fonctionne uniquement dans les groupes.');
      if (!isOwner && !isSessionOwner && !isDevUser) return reply('Seul le propriétaire peut faire quitter le bot.');
      try {
        await reply('👋 Au revoir ! Le bot quitte le groupe…');
        await delay(1500);
        await socket.groupLeave(sender);
      } catch (e) { await reply(`Échec du départ du groupe : ${e.message}`); }
      break;
    }


case 'hentai': {
  try {
    await socket.sendMessage(sender, {
      react: { text: '🔞', key: msg.key }
    });
  } catch (_) {}

  try {
    const response = await axios.get('https://www.movanest.xyz/v2/hentai?query=random');
    const data = response.data;

    if (data && data.status && data.result && data.result.length > 0) {
      const results = data.result;
      const randomVideo = results[Math.floor(Math.random() * results.length)];
      
      const videoUrl = randomVideo.video_1 || randomVideo.video_2;
      if (!videoUrl) return reply("Aucune vidéo disponible !");

      await socket.sendMessage(
        sender, 
        {
          video: { url: videoUrl },
          caption:
`*DOWNLOAD HENTAI*

*❏ ⋮ Title:* ${randomVideo.title}
*❏ ⋮ Category:* ${randomVideo.category}
*❏ ⋮ Views:* ${randomVideo.views_count}

> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`
        }, 
        { quoted: msg }
      );
    } else {
      await reply("Erreur du serveur ! Veuillez réessayer plus tard.");
    }

  } catch (error) {
    console.error(error);
    await reply(`Erreur de l'API :\n${error.message}`);
  }
  break;
}


case 'styletext':
case 'fancy':
case 'fancytext': {
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || '';

    const textToStyle = q.replace(/^[^\s]+\s+/, '').trim();

    if (!textToStyle || textToStyle === '') {
        return await socket.sendMessage(sender, { 
            text: '*❓ Texte manquant.*\n📋 Exemple : .styletext Hello World' 
        });
    }

    try {
        await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });

        const response = await axios.get(`https://www.movanest.xyz/v2/fancytext?word=${encodeURIComponent(textToStyle)}`);
        
        if (!response.data.status) {
            throw new Error('API processing failed');
        }

        const results = response.data.results;
        
        let styledMsg = `*✨ STYLES DE TEXTE*\n\n`;
        styledMsg += `*Original :* ${textToStyle}\n\n`;
        styledMsg += `*┏━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┓*\n`;

        results.slice(0, 25).forEach((styledText, index) => {
            styledMsg += `*┃ ${index + 1}.* ${styledText}\n`;
        });
        
        styledMsg += `*┗━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┛*\n\n`;
        styledMsg += `> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        await socket.sendMessage(sender, { 
            image: { url: akira }, 
            text: styledMsg
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (err) {
        console.error('StyleText API Error:', err);
        await socket.sendMessage(sender, { 
            text: `*❌ Une erreur inattendue est survenue. Réessayez.*` 
        });
    }
    break;
}



                case 'owner': {
    const ownerNum = config.OWNER_NUMBER ? `+${config.OWNER_NUMBER}` : 'non configuré';
    const ownerName = '•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴';
    
    await socket.sendMessage(sender, { react: { text: '🥷', key: msg.key } });

    await socket.sendMessage(sender, {
        image: { url: akira }, 
        contacts: {
            displayName: ownerName,
            contacts: [{
                vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${ownerName}\nORG: DUBED-MD;\nTEL;type=CELL;type=VOICE;waid=${ownerNum.slice(1)}:${ownerNum}\nEND:VCARD`
            }]
        }
    });

    await socket.sendMessage(sender, {
        text: `*[•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴]*\n\n₊❏ ⋮👤 Nom : ${ownerName}\n₊❏ ⋮ 📞 Numéro : ${ownerNum}\n\n> *DUBED-MD*`,
        contextInfo: {
            mentionedJid: [`${ownerNum.slice(1)}@s.whatsapp.net`]
        }
    }, {
        quoted: msg
    });

    break;
                }


case 'lvcal': {
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || '';

    const parts = q.trim().split('&');
    if (parts.length !== 2) {
        return await socket.sendMessage(sender, { 
            text: '*❗ Veuillez fournir deux noms !*\n📋 Exemple : .lvcal John & Jane' 
        });
    }

    try {
        await socket.sendMessage(sender, { react: { text: '💕', key: msg.key } });

        const name1 = parts[0].trim();
        const name2 = parts[1].trim();
        
        const combined = name1.toLowerCase() + name2.toLowerCase();
        let hash = 0;
        for (let i = 0; i < combined.length; i++) {
            hash = combined.charCodeAt(i) + ((hash << 5) - hash);
        }
        const percentage = Math.abs(hash % 101);

        let hearts = '';
        if (percentage >= 90) hearts = '💖💖💖💖💖';
        else if (percentage >= 70) hearts = '💖💖💖💖';
        else if (percentage >= 50) hearts = '💖💖💖';
        else if (percentage >= 30) hearts = '💖💖';
        else hearts = '💖';

        let shipText = `*╭━━〔 ✦ DUBED-MD ✦ 〕━━╮*\n\n`;
        shipText += `👤 *${name1}* 💑 *${name2}*\n\n`;
        shipText += `${hearts}\n`;
        shipText += `*Compatibilité :* ${percentage}%\n\n`;
        
        if (percentage >= 80) shipText += `*Compatibilité parfaite ! 🔥💕*`;
        else if (percentage >= 60) shipText += `*Excellente alchimie ! ✨💝*`;
        else if (percentage >= 40) shipText += `*Belle compatibilité ! 💫💓*`;
        else if (percentage >= 20) shipText += `*Encore un peu d'efforts ! 🤔💔*`;
        else shipText += `*Ce n'est peut-être pas le bon match ! 😢💔*`;
        
        shipText += `\n\n> *•!¡゜⃝𝙈𝙧•𝘼𝙡𝙚𝙭⍣⃝✨⍣🌴*`;

        await socket.sendMessage(sender, { text: shipText }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (err) {
        console.error('Ship Error:', err);
        await socket.sendMessage(sender, { text: '*❌ Le calcul de compatibilité a échoué !*' });
    }
    break;
}


case 'hack': {
    try {
        const from = msg.key.remoteJid; 
        const steps = [
            ' *DUBED-MD • Démarrage du test…*',
            '`Initialisation des outils…` 🛠️',
            '`Connexion au serveur distant…` 🌐',
            '```[##] 20%``` ⏳',
            '```[####] 40%``` ⏳',
            '```[######] 60%``` ⏳',
            '```[########] 80%``` ⏳',
            '```[##########] 100%``` ✅',
            '🔒 *Test terminé avec succès !* 🔓',
            '*DUBED-MD • Opération terminée 🎭*',
        ];

        await socket.sendMessage(from, { react: { text: '💀', key: msg.key } });

        let initialMsg = await socket.sendMessage(from, { text: steps[0] }, { quoted: msg });

        for (let i = 1; i < steps.length; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000)); 

            await socket.sendMessage(from, {
                text: steps[i],
                edit: initialMsg.key,
                contextInfo: typeof arabianCtx === 'function' ? arabianCtx() : {} 
            });
        }

    } catch (e) {
        console.log(e);
        reply(`❌ *❌ Erreur !* ${e.message}`);
    }
    break;
}

} 

const plugin = cmd.findPluginForCommand(command);
if (plugin) {
    try {
        await plugin.handler({ socket, msg, sender, command, args, reply, m, quoted, isOwner, isGroup, botNumber, senderNumber, metaQuote: msg, sessionConfig, activeSockets });
    } catch (pluginErr) {
        console.error(`Plugin ${plugin.name} error:`, pluginErr.message);
    }
}

        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                text: `❌ ERREUR\nUne erreur est survenue : ${error.message}`,
            });
        }
    });
}

router.get('/', async (req, res) => {
    const { number } = req.query;

    if (!number) {
        return res.status(400).send({
            error: 'Number parameter is required'
        });
    }
    
    if (activeSockets.size >= 77) {
        return res.status(429).send({ 
            status: 'limit_reached',
            message: 'Active connections limit reached. Please try again in 1 hour.'
        });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitizedNumber)) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});


router.get('/active', (req, res) => {
    console.log('Active sockets:', Array.from(activeSockets.keys()));
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'dtz-mini-bot-session'}`);
});

module.exports = router;
