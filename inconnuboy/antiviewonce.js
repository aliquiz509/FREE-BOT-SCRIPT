const {
    downloadContentFromMessage,
    getContentType,
    jidNormalizedUser
} = require('baileys');
const mongoose = require('mongoose');

if (!global.antiViewOnceStates) global.antiViewOnceStates = new Map();
if (!global.antiViewOnceListeners) global.antiViewOnceListeners = new Map();

function unwrapMessage(message) {
    let current = message;
    let wasViewOnce = false;

    for (let i = 0; i < 5 && current; i++) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }
        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            wasViewOnce = true;
            continue;
        }
        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            wasViewOnce = true;
            continue;
        }
        if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
            wasViewOnce = true;
            continue;
        }
        break;
    }

    if (!current) return null;

    const type = getContentType(current);
    const media = current[type];

    if (!wasViewOnce && !media?.viewOnce) return null;
    if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(type)) return null;

    return { actualMessage: current, type, media };
}

async function downloadMedia(media, type) {
    const stream = await downloadContentFromMessage(media, type.replace('Message', ''));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function loadAntiViewOnceState(socketId) {
    try {
        const Session = mongoose.models.SessionNew;
        if (!Session) return false;

        const doc = await Session.findOne({ number: socketId }, 'config').lean();
        return doc?.config?.ANTI_VIEW_ONCE === 'true';
    } catch (error) {
        console.log(`⚠️ Impossible de charger l'état Anti-Vue Unique pour ${socketId} : ${error.message}`);
        return false;
    }
}

function initAntiViewOnce(socket) {
    try {
        if (!socket?.user?.id) return;

        const sessionJid = jidNormalizedUser(socket.user.id);
        const socketId = sessionJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

        if (global.antiViewOnceListeners.has(socketId)) return;

        global.antiViewOnceStates.set(socketId, false);

        loadAntiViewOnceState(socketId).then(enabled => {
            if (global.antiViewOnceStates.get(socketId) !== true) {
                global.antiViewOnceStates.set(socketId, enabled === true);
            }
        }).catch(() => {});

        const antiViewOnceListener = async ({ messages }) => {
            try {
                if (global.antiViewOnceStates.get(socketId) !== true) return;

                const msg = messages?.[0];
                if (!msg?.message || msg.key?.fromMe) return;
                if (msg.key?.remoteJid === 'status@broadcast') return;

                const extracted = unwrapMessage(msg.message);
                if (!extracted) return;

                const { type, media } = extracted;
                console.log(`👁️ Anti-Vue Unique : ${type} détecté pour ${socketId}`);

                let buffer;
                try {
                    buffer = await downloadMedia(media, type);
                } catch (error) {
                    console.log(`❌ Anti-Vue Unique : échec du téléchargement : ${error.message}`);
                    return;
                }

                if (!buffer?.length) {
                    console.log(`❌ Anti-Vue Unique : média vide ou inaccessible.`);
                    return;
                }

                const sender = msg.key.participant || msg.key.remoteJid;
                const senderTag = sender?.split('@')[0] || 'inconnu';
                const caption = media.caption || '';
                const prefix = `👁️ *Message Vue Unique converti en message normal*\n\n`;
                const senderLine = `👤 *Expéditeur :* @${senderTag}\n\n`;
                const footer = `> BY INCONNU BOY`;

                let content;

                if (type === 'imageMessage') {
                    content = {
                        image: buffer,
                        caption: prefix + (caption ? `📝 *Légende :* ${caption}\n\n` : '') + senderLine + footer,
                        mentions: [sender]
                    };
                } else if (type === 'videoMessage') {
                    content = {
                        video: buffer,
                        caption: prefix + (caption ? `📝 *Légende :* ${caption}\n\n` : '') + senderLine + footer,
                        mentions: [sender]
                    };
                } else if (type === 'audioMessage') {
                    content = {
                        audio: buffer,
                        mimetype: media.mimetype || 'audio/ogg; codecs=opus',
                        ptt: !!media.ptt
                    };
                } else if (type === 'documentMessage') {
                    content = {
                        document: buffer,
                        mimetype: media.mimetype || 'application/octet-stream',
                        fileName: media.fileName || `vue-unique-${Date.now()}.${media.fileName?.split('.').pop() || 'bin'}`,
                        caption: prefix + (caption ? `📝 *Légende :* ${caption}\n\n` : '') + senderLine + footer,
                        mentions: [sender]
                    };
                }

                if (!content) return;

                await socket.sendMessage(sessionJid, content);

                if (type === 'audioMessage') {
                    await socket.sendMessage(sessionJid, {
                        text: `${prefix}${senderLine}${footer}`,
                        mentions: [sender]
                    });
                }

                console.log(`✅ Anti-Vue Unique : ${type} envoyé dans la boîte du bot.`);
            } catch (error) {
                console.log(`❌ Erreur Anti-Vue Unique : ${error.message}`);
            }
        };

        socket.ev.on('messages.upsert', antiViewOnceListener);
        global.antiViewOnceListeners.set(socketId, { socket, listener: antiViewOnceListener });

        console.log(`👁️ Anti-Vue Unique initialisé pour ${socketId}`);
    } catch (error) {
        console.log(`❌ Erreur d'initialisation Anti-Vue Unique : ${error.message}`);
    }
}

module.exports = {
    name: 'antiviewonce',
    category: 5,
    description: 'Convertit automatiquement les messages Vue Unique en messages normaux',
    commands: ['antiviewonce', 'aviewonce', 'avo'],
    init: initAntiViewOnce,

    handler: async ({ socket, msg, sender, args, reply, isOwner, sessionConfig, activeSockets, botNumber }) => {
        try {
            const sessionJid = jidNormalizedUser(socket.user.id);
            const sessionNumber = sessionJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            const sanitizedNumber = (botNumber || sessionNumber).replace(/[^0-9]/g, '');
            const normalizedSender = (sender || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            const ownerAccess = isOwner === true || normalizedSender === sessionNumber;

            if (!ownerAccess) {
                return reply('❌ *Cette commande est réservée au propriétaire du bot.*');
            }

            const option = (args?.[0] || '').toLowerCase();
            const getState = () => global.antiViewOnceStates.get(sessionNumber) === true || global.antiViewOnceStates.get(sanitizedNumber) === true;

            if (!['on', 'off', 'status'].includes(option)) {
                return reply(
                    `*👁️ Anti-Vue Unique*\n\n` +
                    `📌 *État actuel :* ${getState() ? 'ON 🟢' : 'OFF 🔴'}\n\n` +
                    `Utilisation :\n` +
                    `• *.antiviewonce on* — Activer\n` +
                    `• *.antiviewonce off* — Désactiver\n` +
                    `• *.antiviewonce status* — Voir l'état`
                );
            }

            if (option === 'status') {
                return reply(
                    `*👁️ Statut Anti-Vue Unique*\n\n` +
                    `🛡️ *Système :* ${getState() ? 'Actif 🟢' : 'Inactif 🔴'}\n` +
                    `📥 *Conversion automatique :* ${getState() ? 'Activée' : 'Désactivée'}`
                );
            }

            const enabled = option === 'on';
            global.antiViewOnceStates.set(sessionNumber, enabled);
            global.antiViewOnceStates.set(sanitizedNumber, enabled);

            if (sessionConfig) sessionConfig.ANTI_VIEW_ONCE = enabled ? 'true' : 'false';

            const currentData = activeSockets?.get?.(sanitizedNumber);
            if (currentData) {
                currentData.config = sessionConfig;
                activeSockets.set(sanitizedNumber, currentData);
            }

            const Session = mongoose.models.SessionNew;
            if (Session) {
                await Session.findOneAndUpdate(
                    { number: sanitizedNumber },
                    { $set: { config: sessionConfig, updatedAt: new Date() } },
                    { upsert: true }
                );
            }

            return reply(
                enabled
                    ? `*👁️ Anti-Vue Unique ACTIVÉ 🟢*\n\nTous les messages Vue Unique reçus seront automatiquement convertis en messages normaux et envoyés dans votre boîte avec le bot.`
                    : `*👁️ Anti-Vue Unique DÉSACTIVÉ 🔴*\n\nLes messages Vue Unique ne seront plus convertis automatiquement.`
            );
        } catch (error) {
            console.log(`❌ Erreur de configuration Anti-Vue Unique : ${error.message}`);
            return reply(`❌ *Impossible de modifier Anti-Vue Unique.*\n${error.message}`);
        }
    }
};
