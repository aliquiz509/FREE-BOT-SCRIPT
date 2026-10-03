const {
    getContentType,
    jidNormalizedUser,
    downloadContentFromMessage
} = require('baileys');

const mongoose = require('mongoose');

/* =========================================================
 * ETATS GLOBAUX
 * ========================================================= */

if (!global.antiViewOnceStates) {
    global.antiViewOnceStates = new Map();
}

if (!global.antiViewOnceListeners) {
    global.antiViewOnceListeners = new Map();
}

/* =========================================================
 * INSPECTION DU MESSAGE VIEW ONCE
 * ========================================================= */

function inspectViewOnceMessage(msg) {
    if (!msg) return null;

    const rootMessage = msg.message;
    const key = msg.key || {};

    let current = rootMessage;
    let wrapper = null;
    let isViewOnce = false;

    if (key.isViewOnce === true) {
        isViewOnce = true;
        wrapper = 'key.isViewOnce';
    }

    for (let i = 0; i < 8 && current; i++) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            if (!wrapper) wrapper = 'ephemeralMessage';
            continue;
        }

        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            isViewOnce = true;
            wrapper = 'viewOnceMessage';
            continue;
        }

        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            isViewOnce = true;
            wrapper = 'viewOnceMessageV2';
            continue;
        }

        if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
            isViewOnce = true;
            wrapper = 'viewOnceMessageV2Extension';
            continue;
        }

        break;
    }

    if (current) {
        const type = getContentType(current);
        const media = type ? current[type] : null;

        if (media?.viewOnce === true) {
            isViewOnce = true;
            if (!wrapper) wrapper = `${type}.viewOnce`;
        }

        if (isViewOnce && type && media) {
            return {
                detected: true,
                type,
                media,
                message: current,
                wrapper
            };
        }
    }

    if (isViewOnce) {
        return {
            detected: true,
            type: null,
            media: null,
            message: current,
            wrapper: wrapper || 'key.isViewOnce'
        };
    }

    return null;
}

/* =========================================================
 * LABEL DU TYPE DE MEDIA
 * ========================================================= */

function getMediaLabel(type) {
    switch (type) {
        case 'imageMessage': return 'Image';
        case 'videoMessage': return 'Vidéo';
        case 'audioMessage': return 'Audio';
        case 'documentMessage': return 'Document';
        default: return type || 'Inconnu';
    }
}

/* =========================================================
 * TELECHARGEMENT DU MEDIA
 * ========================================================= */

async function downloadViewOnceMedia(media, type) {
    /*
     * Détermine le "streamType" attendu par Baileys
     * selon le type de média.
     */
    let streamType;

    switch (type) {
        case 'imageMessage':
            streamType = 'image';
            break;
        case 'videoMessage':
            streamType = 'video';
            break;
        case 'audioMessage':
            streamType = 'audio';
            break;
        case 'documentMessage':
            streamType = 'document';
            break;
        default:
            throw new Error(`Type de média non supporté : ${type}`);
    }

    const stream = await downloadContentFromMessage(
        media,
        streamType
    );

    let buffer = Buffer.from([]);

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }

    return buffer;
}

/* =========================================================
 * CHARGEMENT ETAT DEPUIS MONGODB
 * ========================================================= */

async function loadAntiViewOnceState(socketId) {
    try {
        const Session = mongoose.models.SessionNew;
        if (!Session) return false;

        const doc = await Session
            .findOne({ number: socketId }, 'config')
            .lean();

        return doc?.config?.ANTI_VIEW_ONCE === 'true';

    } catch (error) {
        console.log(
            `[ANTI-VIEW-ONCE] Erreur chargement état : ${error.message}`
        );
        return false;
    }
}

/* =========================================================
 * ENVOI DU MEDIA DANS L'INBOX
 * ========================================================= */

async function sendMediaToInbox(socket, inboxJid, msg, info, buffer) {
    const remoteJid = msg?.key?.remoteJid || 'inconnu';

    const participant =
        msg?.key?.participant ||
        msg?.participant ||
        remoteJid;

    const senderNumber =
        participant
            ?.split('@')[0]
            ?.split(':')[0]
            ?.replace(/[^0-9]/g, '') ||
        'inconnu';

    const typeLabel = getMediaLabel(info?.type);

    let discussion = 'Conversation privée';
    if (remoteJid === 'status@broadcast') {
        discussion = 'Statut WhatsApp';
    } else if (remoteJid?.endsWith('@g.us')) {
        discussion = 'Groupe';
    }

    /*
     * Légende / texte joint au média original.
     */
    const caption =
        info?.media?.caption ||
        '';

    const headerText =
        `╭━━〔 👁️ VUE UNIQUE CAPTURÉE 〕━━╮\n` +
        `┃\n` +
        `┃ 📷 Type : ${typeLabel}\n` +
        `┃ 💬 Discussion : ${discussion}\n` +
        `┃ 👤 Expéditeur : @${senderNumber}\n` +
        `┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━╯`;

    /*
     * Prépare le contenu à envoyer selon le type.
     */
    const mediaPayload = {};

    if (info.type === 'imageMessage') {
        mediaPayload.image = buffer;
        mediaPayload.caption = `${headerText}\n\n${caption}`.trim();
        mediaPayload.mimetype =
            info.media?.mimetype || 'image/jpeg';
    } else if (info.type === 'videoMessage') {
        mediaPayload.video = buffer;
        mediaPayload.caption = `${headerText}\n\n${caption}`.trim();
        mediaPayload.mimetype =
            info.media?.mimetype || 'video/mp4';
        mediaPayload.gifPlayback =
            info.media?.gifPlayback || false;
    } else if (info.type === 'audioMessage') {
        /*
         * Pour l'audio, on envoie d'abord un message texte,
         * puis l'audio.
         */
        await socket.sendMessage(
            inboxJid,
            {
                text: headerText,
                mentions:
                    participant && participant !== 'inconnu'
                        ? [participant]
                        : []
            }
        );

        mediaPayload.audio = buffer;
        mediaPayload.mimetype =
            info.media?.mimetype || 'audio/ogg; codecs=opus';
        mediaPayload.ptt =
            info.media?.ptt || false;
    } else if (info.type === 'documentMessage') {
        mediaPayload.document = buffer;
        mediaPayload.mimetype =
            info.media?.mimetype ||
            'application/octet-stream';
        mediaPayload.fileName =
            info.media?.fileName || 'document';
        mediaPayload.caption = headerText;
    } else {
        throw new Error(
            `Type non supporté pour envoi : ${info.type}`
        );
    }

    /*
     * Ajoute les mentions si nécessaire (image/vidéo/document).
     */
    if (
        info.type !== 'audioMessage' &&
        participant &&
        participant !== 'inconnu'
    ) {
        mediaPayload.mentions = [participant];
    }

    await socket.sendMessage(inboxJid, mediaPayload);
}

/* =========================================================
 * NOTIFICATION ERREUR
 * ========================================================= */

async function sendErrorNotification(socket, inboxJid, msg, info, error) {
    const remoteJid = msg?.key?.remoteJid || 'inconnu';

    const participant =
        msg?.key?.participant ||
        msg?.participant ||
        remoteJid;

    const senderNumber =
        participant
            ?.split('@')[0]
            ?.split(':')[0]
            ?.replace(/[^0-9]/g, '') ||
        'inconnu';

    const typeLabel = getMediaLabel(info?.type);

    const realError =
        error?.message ||
        String(error) ||
        'Erreur inconnue';

    const notification =
        `╭━━〔 ❌ ANTI-VUE UNIQUE 〕━━╮\n` +
        `┃\n` +
        `┃ Impossible de traiter\n` +
        `┃ le message Vue Unique.\n` +
        `┃\n` +
        `┃ 📷 Type : ${typeLabel}\n` +
        `┃ 👤 Expéditeur : @${senderNumber}\n` +
        `┃\n` +
        `┃ ⚠️ Erreur :\n` +
        `┃ ${realError}\n` +
        `┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━╯`;

    try {
        await socket.sendMessage(inboxJid, {
            text: notification,
            mentions:
                participant && participant !== 'inconnu'
                    ? [participant]
                    : []
        });
    } catch (sendError) {
        console.log(
            `[ANTI-VIEW-ONCE] Impossible d'envoyer l'erreur : ${sendError.message}`
        );
    }
}

/* =========================================================
 * LISTENER PRINCIPAL
 * ========================================================= */

function initAntiViewOnce(socket) {
    try {
        console.log('[ANTI-VIEW-ONCE] Initialisation...');

        if (!socket?.user?.id) {
            console.log(
                '[ANTI-VIEW-ONCE] Socket sans utilisateur, annulation.'
            );
            return;
        }

        const sessionJid = jidNormalizedUser(socket.user.id);
        const socketId = sessionJid
            .split('@')[0]
            .split(':')[0]
            .replace(/[^0-9]/g, '');

        const existing =
            global.antiViewOnceListeners.get(socketId);

        if (existing?.socket === socket) {
            console.log(
                `[ANTI-VIEW-ONCE] Listener déjà enregistré pour ${socketId}`
            );
            return;
        }

        if (existing?.socket && existing?.listener) {
            try {
                existing.socket.ev.off(
                    'messages.upsert',
                    existing.listener
                );
                console.log(
                    `[ANTI-VIEW-ONCE] Ancien listener supprimé pour ${socketId}`
                );
            } catch (error) {
                console.log(
                    `[ANTI-VIEW-ONCE] Erreur suppression : ${error.message}`
                );
            }
        }

        global.antiViewOnceStates.set(socketId, false);

        loadAntiViewOnceState(socketId)
            .then(enabled => {
                if (
                    global.antiViewOnceStates.get(socketId) !== true
                ) {
                    global.antiViewOnceStates.set(
                        socketId,
                        enabled === true
                    );
                }
                console.log(
                    `[ANTI-VIEW-ONCE] État chargé : ${enabled ? 'ON' : 'OFF'}`
                );
            })
            .catch(error => {
                console.log(
                    `[ANTI-VIEW-ONCE] Erreur état : ${error.message}`
                );
            });

        const antiViewOnceListener = async ({ messages }) => {
            try {
                if (
                    global.antiViewOnceStates.get(socketId) !== true
                ) {
                    return;
                }

                if (!Array.isArray(messages) || !messages.length) {
                    return;
                }

                for (const msg of messages) {
                    try {
                        if (!msg?.key) continue;
                        if (msg.key.fromMe) continue;

                        const remoteJid =
                            msg.key.remoteJid || 'inconnu';

                        if (remoteJid === 'status@broadcast') {
                            continue;
                        }

                        const messageKeys = msg.message
                            ? Object.keys(msg.message)
                            : [];

                        console.log(
                            `[ANTI-VIEW-ONCE] Message | remoteJid=${remoteJid} | key.isViewOnce=${!!msg.key.isViewOnce} | keys=${messageKeys.join(',') || 'aucune'}`
                        );

                        const info = inspectViewOnceMessage(msg);
                        if (!info?.detected) continue;

                        console.log(
                            `[ANTI-VIEW-ONCE] Wrapper : ${info.wrapper || 'inconnu'}`
                        );
                        console.log(
                            `[ANTI-VIEW-ONCE] Média : ${info.type || 'aucun'}`
                        );

                        /*
                         * Si aucun média n'est présent,
                         * on envoie juste une notification.
                         */
                        if (!info.media || !info.type) {
                            await sendErrorNotification(
                                socket,
                                sessionJid,
                                msg,
                                info,
                                new Error(
                                    'Aucun média présent dans ce message Vue Unique'
                                )
                            );
                            continue;
                        }

                        /*
                         * Téléchargement du média.
                         */
                        let buffer;
                        try {
                            buffer = await downloadViewOnceMedia(
                                info.media,
                                info.type
                            );
                        } catch (downloadError) {
                            console.log(
                                `[ANTI-VIEW-ONCE] Erreur téléchargement : ${downloadError.message}`
                            );
                            await sendErrorNotification(
                                socket,
                                sessionJid,
                                msg,
                                info,
                                downloadError
                            );
                            continue;
                        }

                        if (!buffer || !buffer.length) {
                            await sendErrorNotification(
                                socket,
                                sessionJid,
                                msg,
                                info,
                                new Error('Téléchargement vide')
                            );
                            continue;
                        }

                        /*
                         * Envoi dans l'inbox.
                         */
                        try {
                            await sendMediaToInbox(
                                socket,
                                sessionJid,
                                msg,
                                info,
                                buffer
                            );
                            console.log(
                                `[ANTI-VIEW-ONCE] Média envoyé dans l'inbox (${buffer.length} octets)`
                            );
                        } catch (sendError) {
                            console.log(
                                `[ANTI-VIEW-ONCE] Erreur envoi inbox : ${sendError.message}`
                            );
                            await sendErrorNotification(
                                socket,
                                sessionJid,
                                msg,
                                info,
                                sendError
                            );
                        }

                    } catch (messageError) {
                        console.log(
                            `[ANTI-VIEW-ONCE] Erreur message : ${messageError.message}`
                        );
                        try {
                            await sendErrorNotification(
                                socket,
                                sessionJid,
                                msg,
                                {
                                    type: null,
                                    wrapper: 'traitement'
                                },
                                messageError
                            );
                        } catch (_) {}
                    }
                }

            } catch (error) {
                console.log(
                    `[ANTI-VIEW-ONCE] Erreur listener : ${error.message}`
                );
            }
        };

        socket.ev.on('messages.upsert', antiViewOnceListener);

        global.antiViewOnceListeners.set(socketId, {
            socket,
            listener: antiViewOnceListener
        });

        console.log(
            `[ANTI-VIEW-ONCE] Listener enregistré pour ${socketId}`
        );

    } catch (error) {
        console.log(
            `[ANTI-VIEW-ONCE] Erreur init : ${error.message}`
        );
    }
}

/* =========================================================
 * COMMANDE ANTIVIEWONCE
 * ========================================================= */

module.exports = {
    name: 'antiviewonce',
    category: 5,

    description:
        'Capture les messages Vue Unique et envoie le média dans ton inbox',

    commands: [
        'antiviewonce',
        'aviewonce',
        'avo'
    ],

    init: initAntiViewOnce,

    handler: async ({
        socket,
        msg,
        sender,
        args,
        reply,
        isOwner,
        sessionConfig,
        activeSockets,
        botNumber
    }) => {
        try {
            const sessionJid = jidNormalizedUser(socket.user.id);
            const sessionNumber = sessionJid
                .split('@')[0]
                .split(':')[0]
                .replace(/[^0-9]/g, '');

            const sanitizedNumber = (botNumber || sessionNumber)
                .replace(/[^0-9]/g, '');

            const normalizedSender = (sender || '')
                .split('@')[0]
                .split(':')[0]
                .replace(/[^0-9]/g, '');

            const ownerAccess =
                isOwner === true ||
                normalizedSender === sessionNumber;

            if (!ownerAccess) {
                return reply(
                    '❌ *Cette commande est réservée au propriétaire du bot.*'
                );
            }

            const option = (args?.[0] || '')
                .toLowerCase()
                .trim();

            const getState = () =>
                global.antiViewOnceStates.get(sessionNumber) === true ||
                global.antiViewOnceStates.get(sanitizedNumber) === true;

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
                    `📥 *Capture automatique :* ${getState() ? 'Activée' : 'Désactivée'}`
                );
            }

            const enabled = option === 'on';

            global.antiViewOnceStates.set(sessionNumber, enabled);
            global.antiViewOnceStates.set(sanitizedNumber, enabled);

            if (sessionConfig) {
                sessionConfig.ANTI_VIEW_ONCE =
                    enabled ? 'true' : 'false';
            }

            const currentData =
                activeSockets?.get?.(sanitizedNumber);

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
                    ? `🟢 *Anti-View-Once activé*\n\nLes médias Vue Unique seront automatiquement téléchargés et envoyés dans ton inbox.`
                    : `🔴 *Anti-View-Once désactivé*\n\nLes messages Vue Unique ne seront plus capturés.`
            );

        } catch (error) {
            console.log(
                `[ANTI-VIEW-ONCE] Erreur commande : ${error.message}`
            );
            return reply(
                `❌ *Impossible de modifier Anti-View-Once.*\n${error.message}`
            );
        }
    }
};
