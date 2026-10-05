const {
    downloadContentFromMessage,
    getContentType,
    jidNormalizedUser
} = require('baileys');

if (!global.onceDlListeners) {
    global.onceDlListeners = new Map();
}

/*
 * Cache global des View Once récemment reçus.
 *
 * Pourquoi ?
 * Une réaction WhatsApp contient normalement la clé du message ciblé,
 * mais pas nécessairement le contenu complet du View Once.
 *
 * On mémorise donc les View Once reçus afin de pouvoir retrouver
 * leur contenu lorsque Baileys reçoit reactionMessage.
 */
if (!global.onceDlCache) {
    global.onceDlCache = new Map();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Construit une clé suffisamment précise pour identifier un message.
 */
function getMessageKey(key = {}) {
    if (!key) return '';

    const remoteJid = key.remoteJid || '';
    const id = key.id || '';
    const participant = key.participant || '';
    const fromMe = key.fromMe ? '1' : '0';

    return `${remoteJid}|${id}|${participant}|${fromMe}`;
}

/**
 * Certaines versions/structures peuvent encapsuler le message
 * dans ephemeralMessage ou autres wrappers.
 *
 * Cette fonction descend dans les wrappers connus.
 */
function unwrapMessage(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    let current = message;

    for (let i = 0; i < 10; i++) {
        if (!current || typeof current !== 'object') break;

        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }

        if (current.viewOnceMessage?.message) {
            return current;
        }

        if (current.viewOnceMessageV2?.message) {
            return current;
        }

        if (current.viewOnceMessageV2Extension?.message) {
            return current;
        }

        break;
    }

    return current;
}

/**
 * Vérifie si un objet message contient réellement un View Once.
 */
function getViewOnceContainer(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.viewOnceMessage?.message) {
        return {
            wrapper: 'viewOnceMessage',
            message: message.viewOnceMessage.message
        };
    }

    if (message.viewOnceMessageV2?.message) {
        return {
            wrapper: 'viewOnceMessageV2',
            message: message.viewOnceMessageV2.message
        };
    }

    if (message.viewOnceMessageV2Extension?.message) {
        return {
            wrapper: 'viewOnceMessageV2Extension',
            message: message.viewOnceMessageV2Extension.message
        };
    }

    /*
     * Compatibilité avec les structures où le flag viewOnce
     * est directement présent sur image/video/audio.
     */
    if (message.imageMessage?.viewOnce) {
        return {
            wrapper: 'imageMessage',
            message
        };
    }

    if (message.videoMessage?.viewOnce) {
        return {
            wrapper: 'videoMessage',
            message
        };
    }

    if (message.audioMessage?.viewOnce) {
        return {
            wrapper: 'audioMessage',
            message
        };
    }

    return null;
}

/**
 * Retourne le vrai mediaMessage d'un View Once.
 */
function extractViewOnceMedia(message) {
    const container = getViewOnceContainer(message);

    if (!container) {
        return null;
    }

    const actualMessage = container.message;

    if (!actualMessage) {
        return null;
    }

    const type = getContentType(actualMessage);

    if (
        type !== 'imageMessage' &&
        type !== 'videoMessage' &&
        type !== 'audioMessage'
    ) {
        return null;
    }

    const mediaMsg = actualMessage[type];

    if (!mediaMsg) {
        return null;
    }

    return {
        type,
        mediaMsg,
        message: actualMessage,
        wrapper: container.wrapper
    };
}

/**
 * Recherche récursive de contextInfo.
 *
 * Important :
 * Une réponse peut être :
 * - texte
 * - emoji
 * - image
 * - vidéo
 * - audio
 * - sticker
 * - document
 * - etc.
 *
 * Il ne faut donc surtout pas limiter la détection à
 * extendedTextMessage.
 */
function findContextInfo(message, depth = 0) {
    if (!message || typeof message !== 'object' || depth > 10) {
        return null;
    }

    if (message.contextInfo) {
        return message.contextInfo;
    }

    for (const [key, value] of Object.entries(message)) {
        if (!value || typeof value !== 'object') {
            continue;
        }

        /*
         * Évite de parcourir inutilement des structures gigantesques.
         */
        if (
            key === 'messageContextInfo' ||
            key === 'senderKeyDistributionMessage'
        ) {
            continue;
        }

        const found = findContextInfo(value, depth + 1);

        if (found) {
            return found;
        }
    }

    return null;
}

/**
 * Récupère le quotedMessage depuis n'importe quelle structure
 * supportant contextInfo.
 */
function getQuotedMessage(message) {
    const contextInfo = findContextInfo(message);

    if (!contextInfo?.quotedMessage) {
        return null;
    }

    return {
        contextInfo,
        quotedMessage: contextInfo.quotedMessage
    };
}

/**
 * Détermine si un message est une réaction.
 */
function getReactionData(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    const reaction = message.reactionMessage;

    if (!reaction) {
        return null;
    }

    /*
     * Une réaction supprimée possède généralement une valeur vide.
     * Elle ne doit pas déclencher un nouveau téléchargement.
     */
    const reactionText = reaction.text;

    if (!reactionText) {
        return null;
    }

    /*
     * La clé cible du message réagi.
     */
    const targetKey = reaction.key;

    if (!targetKey?.id) {
        return null;
    }

    return {
        emoji: reactionText,
        targetKey
    };
}

/**
 * Détermine le type de média à envoyer.
 */
function getSendType(type) {
    if (type === 'imageMessage') return 'image';
    if (type === 'videoMessage') return 'video';
    if (type === 'audioMessage') return 'audio';
    return null;
}

/**
 * Télécharge un View Once avec plusieurs tentatives.
 */
async function downloadViewOnce(mediaMsg, type) {
    const downloadType = type.replace('Message', '');

    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const stream = await downloadContentFromMessage(
                mediaMsg,
                downloadType
            );

            const chunks = [];

            for await (const chunk of stream) {
                if (chunk) {
                    chunks.push(Buffer.from(chunk));
                }
            }

            const buffer = Buffer.concat(chunks);

            if (!buffer.length) {
                throw new Error('Downloaded ViewOnce media is empty');
            }

            return buffer;

        } catch (error) {
            lastError = error;

            if (attempt < 3) {
                await sleep(1500);
            }
        }
    }

    throw lastError || new Error('ViewOnce download failed');
}

/**
 * Déduplication temporaire.
 *
 * La clé contient :
 * session + trigger + message ciblé.
 *
 * Ainsi :
 * réaction + reply restent deux actions différentes.
 *
 * Une réaction de l'utilisateur A ne bloque pas un reply légitime
 * d'un autre utilisateur.
 */
function buildDedupKey(sessionJid, trigger, messageKey) {
    return `${sessionJid}|${trigger}|${messageKey}`;
}

function hasProcessed(key) {
    return global.onceDlCache.processed?.has(key);
}

function markProcessed(key) {
    if (!global.onceDlCache.processed) {
        global.onceDlCache.processed = new Map();
    }

    global.onceDlCache.processed.set(key, Date.now());

    /*
     * Nettoyage périodique des anciennes entrées.
     * Évite une croissance infinie de la mémoire.
     */
    const expiration = 10 * 60 * 1000;
    const now = Date.now();

    for (const [oldKey, timestamp] of global.onceDlCache.processed.entries()) {
        if (now - timestamp > expiration) {
            global.onceDlCache.processed.delete(oldKey);
        }
    }
}

/**
 * Met en cache un View Once reçu.
 */
function cacheViewOnce(msg) {
    if (!msg?.key?.id || !msg?.key?.remoteJid || !msg?.message) {
        return;
    }

    const media = extractViewOnceMedia(msg.message);

    if (!media) {
        return;
    }

    const key = getMessageKey(msg.key);

    if (!key) {
        return;
    }

    global.onceDlCache.set(key, {
        key: msg.key,
        message: msg.message,
        media,
        createdAt: Date.now()
    });

    /*
     * Nettoyage des View Once trop anciens.
     * 30 minutes suffisent largement pour permettre une réaction/reply.
     */
    const expiration = 30 * 60 * 1000;
    const now = Date.now();

    for (const [cacheKey, item] of global.onceDlCache.entries()) {
        if (
            cacheKey !== 'processed' &&
            item?.createdAt &&
            now - item.createdAt > expiration
        ) {
            global.onceDlCache.delete(cacheKey);
        }
    }
}

/**
 * Recherche un View Once à partir de la clé d'une réaction.
 *
 * On essaie plusieurs représentations car participant/fromMe
 * peuvent différer selon le contexte du groupe ou du chat privé.
 */
function findCachedViewOnce(targetKey) {
    if (!targetKey?.id) {
        return null;
    }

    const exactKey = getMessageKey(targetKey);
    const exact = global.onceDlCache.get(exactKey);

    if (exact) {
        return exact;
    }

    /*
     * Fallback : même remoteJid + id.
     */
    for (const [cacheKey, item] of global.onceDlCache.entries()) {
        if (cacheKey === 'processed') {
            continue;
        }

        if (!item?.key) {
            continue;
        }

        if (
            item.key.id === targetKey.id &&
            item.key.remoteJid === targetKey.remoteJid
        ) {
            return item;
        }
    }

    return null;
}

/**
 * Télécharge et envoie le View Once dans l'inbox du bot.
 */
async function processViewOnce({
    socket,
    sessionJid,
    sourceJid,
    reactionKey,
    targetMessage,
    trigger,
    triggerMessageKey
}) {
    if (!targetMessage) {
        return false;
    }

    const media = extractViewOnceMedia(targetMessage);

    if (!media) {
        return false;
    }

    const sendType = getSendType(media.type);

    if (!sendType) {
        return false;
    }

    /*
     * La déduplication est faite sur le View Once ciblé.
     */
    const targetKey = reactionKey || triggerMessageKey;

    const targetMessageKey = getMessageKey(targetKey);

    if (!targetMessageKey) {
        return false;
    }

    const dedupKey = buildDedupKey(
        sessionJid,
        trigger,
        targetMessageKey
    );

    if (hasProcessed(dedupKey)) {
        return false;
    }

    /*
     * On marque avant le téléchargement afin d'éviter que deux
     * événements identiques lancent simultanément deux téléchargements.
     */
    markProcessed(dedupKey);

    let statusJid = sourceJid || targetKey?.remoteJid;

    /*
     * Réaction visuelle facultative conservée.
     */
    try {
        if (statusJid) {
            await socket.sendMessage(statusJid, {
                react: {
                    text: '⏳',
                    key: triggerMessageKey || targetKey
                }
            });
        }
    } catch (_) {}

    try {
        const buffer = await downloadViewOnce(
            media.mediaMsg,
            media.type
        );

        /*
         * Comportement demandé :
         * l'inbox du bot reste sessionJid.
         */
        const myInbox = sessionJid;

        let originalCaption = media.mediaMsg.caption || '';

        let finalCaption = `👁️ *ViewOnce Downloaded*\n\n`;

        if (originalCaption) {
            finalCaption += `📝 *Caption:* ${originalCaption}\n\n`;
        }

        finalCaption += `> BY INCONNU BOY`;

        const payload = {
            [sendType]: buffer,
            caption: finalCaption
        };

        await socket.sendMessage(myInbox, payload);

        /*
         * Succès.
         */
        try {
            if (statusJid) {
                await socket.sendMessage(statusJid, {
                    react: {
                        text: '✅',
                        key: triggerMessageKey || targetKey
                    }
                });
            }
        } catch (_) {}

        return true;

    } catch (error) {
        console.error(
            '[OnceDL] Download failed:',
            error?.message || error
        );

        /*
         * Important :
         * on ne laisse jamais une erreur de téléchargement
         * casser le listener ou le socket.
         */
        try {
            if (statusJid) {
                await socket.sendMessage(statusJid, {
                    react: {
                        text: '❌',
                        key: triggerMessageKey || targetKey
                    }
                });
            }
        } catch (_) {}

        return false;
    }
}

function initOnceDL(socket) {
    if (!socket || !socket.user) {
        return;
    }

    const sessionJid = jidNormalizedUser(socket.user.id);
    const socketId = sessionJid.split('@')[0];

    /*
     * Protection contre plusieurs listeners sur le même socket.
     */
    const active = global.onceDlListeners.get(socketId);

    if (active && active.socket === socket) {
        return;
    }

    /*
     * Si un ancien socket est enregistré sous le même compte,
     * on tente de retirer son listener avant de remplacer l'entrée.
     */
    if (active?.socket && active.listener) {
        try {
            active.socket.ev.off(
                'messages.upsert',
                active.listener
            );
        } catch (_) {}
    }

    const onceListener = async (chatUpdate) => {
        try {
            const messages = chatUpdate?.messages;

            if (!Array.isArray(messages) || !messages.length) {
                return;
            }

            /*
             * messages.upsert peut contenir plusieurs messages.
             * On les traite tous.
             */
            for (const msg of messages) {
                if (!msg || !msg.message || !msg.key) {
                    continue;
                }

                /*
                 * =====================================================
                 * ÉTAPE 1 — CACHE DES VIEW ONCE
                 * =====================================================
                 *
                 * On mémorise les View Once dès leur réception.
                 *
                 * Cela permet ensuite de résoudre :
                 *
                 * View Once
                 *      ↓
                 * ReactionMessage
                 *      ↓
                 * reaction.key
                 *      ↓
                 * cache
                 *      ↓
                 * téléchargement
                 */
                cacheViewOnce(msg);

                /*
                 * =====================================================
                 * CAS 1 — RÉACTION
                 * =====================================================
                 */
                const reactionData = getReactionData(msg);

                if (reactionData) {
                    const targetKey = reactionData.targetKey;

                    /*
                     * La réaction n'est PAS considérée comme View Once
                     * par défaut.
                     *
                     * On cherche précisément le message ciblé.
                     */
                    const cachedTarget = findCachedViewOnce(targetKey);

                    if (cachedTarget?.message) {
                        await processViewOnce({
                            socket,
                            sessionJid,
                            sourceJid: msg.key.remoteJid,
                            reactionKey: targetKey,
                            targetMessage: cachedTarget.message,
                            trigger: 'reaction',
                            triggerMessageKey: msg.key
                        });
                    }

                    /*
                     * Une réaction ne doit pas ensuite passer dans
                     * la logique Reply.
                     */
                    continue;
                }

                /*
                 * =====================================================
                 * CAS 2 — REPLY / QUOTE
                 * =====================================================
                 *
                 * IMPORTANT :
                 * aucun contrôle sur le contenu du message.
                 *
                 * Donc :
                 * "salut"
                 * "ok"
                 * "123"
                 * "😂"
                 * sticker
                 * image
                 * vidéo
                 * audio
                 * document
                 *
                 * peuvent tous déclencher le téléchargement si
                 * contextInfo.quotedMessage est un vrai View Once.
                 */
                const replyData = getQuotedMessage(msg.message);

                if (!replyData?.quotedMessage) {
                    continue;
                }

                const quotedMsg = replyData.quotedMessage;

                /*
                 * Vérification stricte :
                 * le message cité doit réellement être un View Once.
                 */
                const quotedMedia = extractViewOnceMedia(quotedMsg);

                if (!quotedMedia) {
                    continue;
                }

                /*
                 * La clé du message cité peut être fournie par
                 * stanzaId / participant / remoteJid.
                 *
                 * Pour le téléchargement, le quotedMessage lui-même
                 * suffit.
                 */
                const contextInfo = replyData.contextInfo;

                const quotedKey = {
                    remoteJid:
                        msg.key.remoteJid ||
                        contextInfo.remoteJid ||
                        '',
                    id:
                        contextInfo.stanzaId ||
                        '',
                    participant:
                        contextInfo.participant ||
                        '',
                    fromMe: false
                };

                /*
                 * Si stanzaId est absent, on utilise une clé locale
                 * basée sur le message déclencheur afin d'éviter un
                 * crash. Le contenu reste néanmoins strictement vérifié
                 * comme View Once.
                 */
                const effectiveKey = quotedKey.id
                    ? quotedKey
                    : {
                        remoteJid: msg.key.remoteJid || '',
                        id: `quoted:${msg.key.id}`,
                        participant:
                            contextInfo.participant || '',
                        fromMe: false
                    };

                await processViewOnce({
                    socket,
                    sessionJid,
                    sourceJid: msg.key.remoteJid,
                    targetMessage: quotedMsg,
                    trigger: 'reply',
                    triggerMessageKey: effectiveKey
                });
            }

        } catch (err) {
            console.error(
                '[OnceDL] Listener Error:',
                err?.message || err
            );

            /*
             * Une erreur d'un événement ne doit jamais tuer
             * le listener ni le socket.
             */
        }
    };

    socket.ev.on('messages.upsert', onceListener);

    global.onceDlListeners.set(socketId, {
        socket,
        listener: onceListener
    });

    console.log(
        `👁️ ViewOnce Downloader AUTO-ACTIVATED for ${socketId}`
    );
}

module.exports = {
    name: 'once_downloader',
    category: 'utility',
    description: 'Download ViewOnce using reactions or replies',
    commands: ['antivv'],

    init: initOnceDL,

    handler: async ({ socket, reply }) => {
        await reply(
            '✅ *ViewOnce Downloader is Active!*'
        );
    }
};
