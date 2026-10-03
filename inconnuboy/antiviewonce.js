const {
    downloadContentFromMessage,
    getContentType,
    jidNormalizedUser
} = require('baileys');
const mongoose = require('mongoose');

if (!global.antiViewOnceStates) global.antiViewOnceStates = new Map();
if (!global.antiViewOnceListeners) global.antiViewOnceListeners = new Map();

const unwrapViewOnce = (message) => {
    if (!message) return null;

    if (message.viewOnceMessage?.message) {
        return message.viewOnceMessage.message;
    }

    if (message.viewOnceMessageV2?.message) {
        return message.viewOnceMessageV2.message;
    }

    if (message.viewOnceMessageV2Extension?.message) {
        return message.viewOnceMessageV2Extension.message;
    }

    if (
        message.imageMessage?.viewOnce ||
        message.videoMessage?.viewOnce ||
        message.audioMessage?.viewOnce
    ) {
        return message;
    }

    return null;
};

const getViewOnceMedia = (message) => {
    const actualMessage = unwrapViewOnce(message);
    if (!actualMessage) return null;

    const type = getContentType(actualMessage);
    if (!type) return null;

    if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(type)) {
        return null;
    }

    return {
        actualMessage,
        type,
        media: actualMessage[type]
    };
};

async function loadAntiViewOnceState(socketId) {
    try {
        const Session = mongoose.models.SessionNew;
        if (!Session) return false;

        const doc = await Session.findOne(
            { number: socketId },
            'config'
        ).lean();

        return doc?.config?.ANTI_VIEW_ONCE === 'true';
    } catch (error) {
        console.log(`⚠️ Impossible de charger l'état Anti-Vue Unique pour ${socketId} : ${error.message}`);
        return false;
    }
}

function initAntiViewOnce(socket) {
    try {
        if (!socket || !socket.user || !socket.user.id) return;

        const sessionJid = jidNormalizedUser(socket.user.id);
        const socketId = sessionJid.split('@')[0];

        if (global.antiViewOnceListeners.has(socketId)) {
            return;
        }

        global.antiViewOnceStates.set(socketId, false);

        // Charger l'état sauvegardé sans bloquer l'initialisation du socket.
        loadAntiViewOnceState(socketId).then((enabled) => {
            global.antiViewOnceStates.set(socketId, enabled);
        }).catch(() => {});

        const antiViewOnceListener = async (chatUpdate) => {
            try {
                if (!global.antiViewOnceStates.get(socketId)) return;

                const msg = chatUpdate?.messages?.[0];
                if (!msg || !msg.message || msg.key?.fromMe) return;
                if (msg.key?.remoteJid === 'status@broadcast') return;

                const mediaInfo = getViewOnceMedia(msg.message);
                if (!mediaInfo) return;

                const { type, media } = mediaInfo;
                if (!media) return;

                const mediaType = type.replace('Message', '');
                let buffer = Buffer.alloc(0);

                try {
                    const stream = await downloadContentFromMessage(media, mediaType);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                } catch (downloadError) {
                    console.log(`❌ Erreur de récupération du message Vue Unique : ${downloadError.message}`);
                    return;
                }

                if (!buffer.length) return;

                const caption = media.caption || '';
                const sender = msg.key.participant || msg.key.remoteJid;

                let content;

                if (type === 'imageMessage') {
                    content = {
                        image: buffer,
                        caption: caption
                            ? `👁️ *Message Vue Unique converti en message normal*\n\n📝 *Légende :* ${caption}\n\n👤 *Expéditeur :* @${sender.split('@')[0]}\n\n> BY INCONNU BOY`
                            : `👁️ *Message Vue Unique converti en message normal*\n\n👤 *Expéditeur :* @${sender.split('@')[0]}\n\n> BY INCONNU BOY`,
                        mentions: [sender]
                    };
                } else if (type === 'videoMessage') {
                    content = {
                        video: buffer,
                        caption: caption
                            ? `👁️ *Vidéo Vue Unique convertie en vidéo normale*\n\n📝 *Légende :* ${caption}\n\n👤 *Expéditeur :* @${sender.split('@')[0]}\n\n> BY INCONNU BOY`
                            : `👁️ *Vidéo Vue Unique convertie en vidéo normale*\n\n👤 *Expéditeur :* @${sender.split('@')[0]}\n\n> BY INCONNU BOY`,
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
                        fileName: media.fileName || `message-vue-unique-${Date.now()}`,
                        caption: caption || '👁️ Message Vue Unique converti en document normal'
                    };
                }

                if (!content) return;

                await socket.sendMessage(sessionJid, content);

                console.log(`👁️ Anti-Vue Unique : message reçu de ${sender.split('@')[0]} et converti en message normal.`);
            } catch (error) {
                console.log(`❌ Erreur Anti-Vue Unique : ${error.message}`);
            }
        };

        socket.ev.on('messages.upsert', antiViewOnceListener);
        global.antiViewOnceListeners.set(socketId, {
            socket,
            listener: antiViewOnceListener
        });

        console.log(`👁️ Anti-Vue Unique initialisé pour ${socketId} — état : OFF par défaut`);
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
            if (!isOwner) {
                return reply('❌ *Cette commande est réservée au propriétaire du bot.*');
            }

            const sanitizedNumber = (botNumber || socket.user.id).replace(/[^0-9]/g, '');
            const option = (args?.[0] || '').toLowerCase();

            if (!['on', 'off', 'status'].includes(option)) {
                const current = global.antiViewOnceStates.get(sanitizedNumber) === true ? 'ON 🟢' : 'OFF 🔴';
                return reply(
                    `*👁️ Anti-Vue Unique*\n\n` +
                    `📌 *État actuel :* ${current}\n\n` +
                    `Utilisation :\n` +
                    `• *.antiviewonce on* — Activer\n` +
                    `• *.antiviewonce off* — Désactiver\n` +
                    `• *.antiviewonce status* — Voir l'état`
                );
            }

            if (option === 'status') {
                const enabled = global.antiViewOnceStates.get(sanitizedNumber) === true;
                return reply(
                    `*👁️ Statut Anti-Vue Unique*\n\n` +
                    `🛡️ *Système :* ${enabled ? 'Actif 🟢' : 'Inactif 🔴'}\n` +
                    `📥 *Conversion automatique :* ${enabled ? 'Activée' : 'Désactivée'}`
                );
            }

            const enabled = option === 'on';
            global.antiViewOnceStates.set(sanitizedNumber, enabled);

            if (sessionConfig) {
                sessionConfig.ANTI_VIEW_ONCE = enabled ? 'true' : 'false';
            }

            const currentData = activeSockets?.get?.(sanitizedNumber);
            if (currentData) {
                currentData.config = sessionConfig;
                activeSockets.set(sanitizedNumber, currentData);
            }

            const Session = mongoose.models.SessionNew;
            if (Session) {
                await Session.findOneAndUpdate(
                    { number: sanitizedNumber },
                    {
                        $set: {
                            config: sessionConfig,
                            updatedAt: new Date()
                        }
                    },
                    { upsert: true }
                );
            }

            return reply(
                enabled
                    ? `*👁️ Anti-Vue Unique ACTIVÉ 🟢*\n\nTous les messages Vue Unique reçus seront automatiquement convertis en messages normaux et envoyés dans votre conversation avec le bot.`
                    : `*👁️ Anti-Vue Unique DÉSACTIVÉ 🔴*\n\nLes messages Vue Unique ne seront plus convertis automatiquement.`
            );
        } catch (error) {
            console.log(`❌ Erreur de configuration Anti-Vue Unique : ${error.message}`);
            return reply(`❌ *Impossible de modifier Anti-Vue Unique.*\n${error.message}`);
        }
    }
};
