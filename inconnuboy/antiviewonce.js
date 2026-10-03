const {
    getContentType,
    jidNormalizedUser
} = require('baileys');

const mongoose = require('mongoose');

if (!global.antiViewOnceStates) {
    global.antiViewOnceStates = new Map();
}

if (!global.antiViewOnceListeners) {
    global.antiViewOnceListeners = new Map();
}

/* =========================================================
 * ANTI VIEW ONCE — DETECTION UNIQUEMENT
 * Ne télécharge pas et ne redistribue pas le média protégé.
 * ========================================================= */

function inspectViewOnceMessage(msg) {
    if (!msg) return null;

    const rootMessage = msg.message;
    const key = msg.key || {};

    let current = rootMessage;
    let wrapper = null;
    let isViewOnce = false;

    /*
     * Certains formats Baileys peuvent signaler View Once
     * directement dans la clé, même lorsque message est absent.
     */
    if (key.isViewOnce === true) {
        isViewOnce = true;
        wrapper = 'key.isViewOnce';
    }

    /*
     * Parcours des wrappers connus.
     */
    for (let i = 0; i < 8 && current; i++) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;

            if (!wrapper) {
                wrapper = 'ephemeralMessage';
            }

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

    /*
     * Si le média possède lui-même viewOnce:true.
     */
    if (current) {
        const type = getContentType(current);
        const media = type ? current[type] : null;

        if (media?.viewOnce === true) {
            isViewOnce = true;

            if (!wrapper) {
                wrapper = `${type}.viewOnce`;
            }
        }

        if (isViewOnce && type) {
            return {
                detected: true,
                type,
                media,
                wrapper
            };
        }
    }

    /*
     * Cas important :
     * key.isViewOnce === true mais aucun contenu média n'est
     * présent dans le message reçu.
     */
    if (isViewOnce) {
        return {
            detected: true,
            type: null,
            media: null,
            wrapper: wrapper || 'key.isViewOnce'
        };
    }

    return null;
}

/* =========================================================
 * TYPE HUMAIN DU MEDIA
 * ========================================================= */

function getMediaLabel(type) {
    switch (type) {
        case 'imageMessage':
            return 'Image';

        case 'videoMessage':
            return 'Vidéo';

        case 'audioMessage':
            return 'Audio';

        case 'documentMessage':
            return 'Document';

        default:
            return type || 'Inconnu';
    }
}

/* =========================================================
 * INITIALISATION ETAT
 * ========================================================= */

async function loadAntiViewOnceState(socketId) {
    try {
        const Session = mongoose.models.SessionNew;

        if (!Session) {
            return false;
        }

        const doc = await Session
            .findOne(
                { number: socketId },
                'config'
            )
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
 * NOTIFICATION INBOX
 * ========================================================= */

async function sendDetectionNotification(socket, inboxJid, msg, info) {
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

    const notification =
        `╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮\n` +
        `┃\n` +
        `┃ ✅ Message Vue Unique détecté\n` +
        `┃\n` +
        `┃ 📷 Type : ${typeLabel}\n` +
        `┃ 💬 Discussion : ${discussion}\n` +
        `┃ 👤 Expéditeur : @${senderNumber}\n` +
        `┃\n` +
        `┃ 🔒 Protection conservée\n` +
        `┃\n` +
        `┃ 🔍 Wrapper : ${info?.wrapper || 'non identifié'}\n` +
        `┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━╯`;

    await socket.sendMessage(
        inboxJid,
        {
            text: notification,
            mentions:
                participant &&
                participant !== 'inconnu'
                    ? [participant]
                    : []
        }
    );
}

/* =========================================================
 * NOTIFICATION ERREUR
 * ========================================================= */

async function sendErrorNotification(socket, inboxJid, msg, info, error) {
    const remoteJid =
        msg?.key?.remoteJid || 'inconnu';

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

    const typeLabel =
        getMediaLabel(info?.type);

    const realError =
        error?.stack ||
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
        `┃ 🔍 Wrapper : ${info?.wrapper || 'non identifié'}\n` +
        `┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━╯`;

    try {
        await socket.sendMessage(
            inboxJid,
            {
                text: notification,
                mentions:
                    participant &&
                    participant !== 'inconnu'
                        ? [participant]
                        : []
            }
        );
    } catch (sendError) {
        console.log(
            `[ANTI-VIEW-ONCE] Impossible d'envoyer l'erreur dans l'inbox : ${sendError.message}`
        );
    }
}

/* =========================================================
 * LISTENER PRINCIPAL
 * ========================================================= */

function initAntiViewOnce(socket) {
    try {
        console.log(
            '[ANTI-VIEW-ONCE] Initialisation...'
        );

        if (!socket?.user?.id) {
            console.log(
                '[ANTI-VIEW-ONCE] Socket sans utilisateur, initialisation annulée.'
            );

            return;
        }

        const sessionJid =
            jidNormalizedUser(socket.user.id);

        const socketId =
            sessionJid
                .split('@')[0]
                .split(':')[0]
                .replace(/[^0-9]/g, '');

        /*
         * Empêche l'enregistrement de plusieurs listeners
         * pour la même session.
         */
        const existing =
            global.antiViewOnceListeners.get(socketId);

        if (existing?.socket === socket) {
            console.log(
                `[ANTI-VIEW-ONCE] Listener déjà enregistré pour ${socketId}`
            );

            return;
        }

        /*
         * Si une ancienne socket possède encore un listener,
         * on le retire avant d'enregistrer le nouveau.
         */
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
                    `[ANTI-VIEW-ONCE] Erreur suppression ancien listener : ${error.message}`
                );
            }
        }

        global.antiViewOnceStates.set(
            socketId,
            false
        );

        /*
         * Chargement de l'état depuis MongoDB.
         */
        loadAntiViewOnceState(socketId)
            .then(enabled => {
                /*
                 * Ne pas écraser un état activé entre-temps.
                 */
                if (
                    global.antiViewOnceStates.get(socketId) !== true
                ) {
                    global.antiViewOnceStates.set(
                        socketId,
                        enabled === true
                    );
                }

                console.log(
                    `[ANTI-VIEW-ONCE] État chargé : ${
                        enabled ? 'ON' : 'OFF'
                    }`
                );
            })
            .catch(error => {
                console.log(
                    `[ANTI-VIEW-ONCE] Erreur chargement état : ${error.message}`
                );
            });

        const antiViewOnceListener = async ({ messages }) => {
            try {
                /*
                 * Le système est OFF : aucun traitement.
                 */
                if (
                    global.antiViewOnceStates.get(socketId) !== true
                ) {
                    return;
                }

                if (!Array.isArray(messages) || !messages.length) {
                    return;
                }

                /*
                 * Plusieurs messages peuvent être présents
                 * dans un même messages.upsert.
                 */
                for (const msg of messages) {
                    try {
                        if (!msg?.key) {
                            continue;
                        }

                        if (msg.key.fromMe) {
                            continue;
                        }

                        const remoteJid =
                            msg.key.remoteJid || 'inconnu';

                        if (
                            remoteJid === 'status@broadcast'
                        ) {
                            continue;
                        }

                        const messageKeys =
                            msg.message
                                ? Object.keys(msg.message)
                                : [];

                        console.log(
                            `[ANTI-VIEW-ONCE] Message reçu | remoteJid=${remoteJid} | fromMe=${!!msg.key.fromMe} | key.isViewOnce=${!!msg.key.isViewOnce} | messageKeys=${messageKeys.join(',') || 'aucune'}`
                        );

                        /*
                         * Détection View Once.
                         */
                        const info =
                            inspectViewOnceMessage(msg);

                        if (!info?.detected) {
                            continue;
                        }

                        console.log(
                            `[ANTI-VIEW-ONCE] Wrapper détecté : ${info.wrapper || 'non identifié'}`
                        );

                        console.log(
                            `[ANTI-VIEW-ONCE] Média détecté : ${info.type || 'aucun contenu média'}`
                        );

                        /*
                         * Protection :
                         * aucun téléchargement,
                         * aucune conversion,
                         * aucune redistribution.
                         */

                        try {
                            await sendDetectionNotification(
                                socket,
                                sessionJid,
                                msg,
                                info
                            );

                            console.log(
                                `[ANTI-VIEW-ONCE] Notification envoyée`
                            );

                        } catch (notificationError) {
                            console.log(
                                `[ANTI-VIEW-ONCE] Erreur notification : ${notificationError.message}`
                            );

                            await sendErrorNotification(
                                socket,
                                sessionJid,
                                msg,
                                info,
                                notificationError
                            );
                        }

                    } catch (messageError) {
                        console.log(
                            `[ANTI-VIEW-ONCE] Erreur traitement message : ${messageError.message}`
                        );

                        /*
                         * On tente de notifier l'inbox sans
                         * masquer l'erreur originale.
                         */
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
                        } catch (errorNotification) {
                            console.log(
                                `[ANTI-VIEW-ONCE] Erreur secondaire notification : ${errorNotification.message}`
                            );
                        }
                    }
                }

            } catch (error) {
                console.log(
                    `[ANTI-VIEW-ONCE] Erreur listener : ${error.message}`
                );
            }
        };

        socket.ev.on(
            'messages.upsert',
            antiViewOnceListener
        );

        global.antiViewOnceListeners.set(
            socketId,
            {
                socket,
                listener: antiViewOnceListener
            }
        );

        console.log(
            `[ANTI-VIEW-ONCE] Listener enregistré pour ${socketId}`
        );

    } catch (error) {
        console.log(
            `[ANTI-VIEW-ONCE] Erreur d'initialisation : ${error.message}`
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
        'Détecte les messages Vue Unique sans télécharger ni redistribuer le média',

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
            const sessionJid =
                jidNormalizedUser(socket.user.id);

            const sessionNumber =
                sessionJid
                    .split('@')[0]
                    .split(':')[0]
                    .replace(/[^0-9]/g, '');

            const sanitizedNumber =
                (botNumber || sessionNumber)
                    .replace(/[^0-9]/g, '');

            const normalizedSender =
                (sender || '')
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

            const option =
                (args?.[0] || '')
                    .toLowerCase()
                    .trim();

            const getState = () =>
                global.antiViewOnceStates.get(sessionNumber) === true ||
                global.antiViewOnceStates.get(sanitizedNumber) === true;

            if (
                ![
                    'on',
                    'off',
                    'status'
                ].includes(option)
            ) {
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
                    `📥 *Détection automatique :* ${getState() ? 'Activée' : 'Désactivée'}`
                );
            }

            const enabled =
                option === 'on';

            global.antiViewOnceStates.set(
                sessionNumber,
                enabled
            );

            global.antiViewOnceStates.set(
                sanitizedNumber,
                enabled
            );

            if (sessionConfig) {
                sessionConfig.ANTI_VIEW_ONCE =
                    enabled ? 'true' : 'false';
            }

            const currentData =
                activeSockets?.get?.(
                    sanitizedNumber
                );

            if (currentData) {
                currentData.config =
                    sessionConfig;

                activeSockets.set(
                    sanitizedNumber,
                    currentData
                );
            }

            const Session =
                mongoose.models.SessionNew;

            if (Session) {
                await Session.findOneAndUpdate(
                    {
                        number: sanitizedNumber
                    },
                    {
                        $set: {
                            config: sessionConfig,
                            updatedAt: new Date()
                        }
                    },
                    {
                        upsert: true
                    }
                );
            }

            return reply(
                enabled
                    ? `🟢 *Anti-View-Once activé*\n\nLes messages Vue Unique seront détectés automatiquement. Le média protégé ne sera pas téléchargé ni redistribué.`
                    : `🔴 *Anti-View-Once désactivé*\n\nLes messages Vue Unique ne seront plus traités automatiquement.`
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
