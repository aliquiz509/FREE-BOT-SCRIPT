const {
    downloadContentFromMessage,
    getContentType,
    jidNormalizedUser
} = require('baileys');

/*
 * ============================================================
 * GLOBAL STATE
 * ============================================================
 */

if (!global.onceDlListeners) {
    global.onceDlListeners = new Map();
}

if (!global.onceDlMessageCache) {
    global.onceDlMessageCache = new Map();
}

if (!global.onceDlDownloaded) {
    global.onceDlDownloaded = new Map();
}


/*
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

const MAX_CACHE_SIZE = 3000;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY = 1500;


/*
 * ============================================================
 * UTILITY — SLEEP
 * ============================================================
 */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/*
 * ============================================================
 * UTILITY — MESSAGE CACHE KEY
 * ============================================================
 */

function getMessageKey(key) {
    if (!key) return null;

    const remoteJid = key.remoteJid || '';
    const id = key.id || '';

    if (!remoteJid || !id) return null;

    return `${remoteJid}:${id}`;
}


/*
 * ============================================================
 * CACHE MESSAGE
 * ============================================================
 */

function cacheMessage(msg) {
    try {
        if (!msg?.key?.id || !msg?.key?.remoteJid) {
            return;
        }

        const cacheKey = getMessageKey(msg.key);

        if (!cacheKey) return;

        global.onceDlMessageCache.set(cacheKey, {
            message: msg,
            timestamp: Date.now()
        });

        /*
         * Limiter la taille du cache.
         */

        if (global.onceDlMessageCache.size > MAX_CACHE_SIZE) {
            const firstKey =
                global.onceDlMessageCache.keys().next().value;

            if (firstKey) {
                global.onceDlMessageCache.delete(firstKey);
            }
        }

    } catch (error) {
        console.error(
            '[OnceDL] Cache error:',
            error?.message || error
        );
    }
}


/*
 * ============================================================
 * CLEAN OLD CACHE ENTRIES
 * ============================================================
 */

function cleanMessageCache() {
    try {
        const now = Date.now();

        for (const [key, value] of global.onceDlMessageCache.entries()) {
            if (!value?.timestamp) {
                global.onceDlMessageCache.delete(key);
                continue;
            }

            if (now - value.timestamp > CACHE_TTL) {
                global.onceDlMessageCache.delete(key);
            }
        }

    } catch (error) {
        console.error(
            '[OnceDL] Cache cleanup error:',
            error?.message || error
        );
    }
}


/*
 * ============================================================
 * FIND MESSAGE IN CACHE / EXISTING STORE
 * ============================================================
 */

function findOriginalMessage(socket, key) {
    try {
        if (!key) return null;

        const cacheKey = getMessageKey(key);

        if (!cacheKey) return null;


        /*
         * --------------------------------------------------------
         * 1. Notre propre cache
         * --------------------------------------------------------
         */

        const cached = global.onceDlMessageCache.get(cacheKey);

        if (cached?.message) {
            return cached.message;
        }


        /*
         * --------------------------------------------------------
         * 2. socket.store
         * --------------------------------------------------------
         */

        try {
            const socketStore = socket?.store;

            if (socketStore?.messages?.get) {
                const chatMessages =
                    socketStore.messages.get(key.remoteJid);

                if (chatMessages?.get) {
                    const found = chatMessages.get(key.id);

                    if (found) {
                        return found;
                    }
                }
            }
        } catch (e) {}


        /*
         * --------------------------------------------------------
         * 3. global.store
         * --------------------------------------------------------
         */

        try {
            const globalStore = global.store;

            if (globalStore?.messages?.get) {
                const chatMessages =
                    globalStore.messages.get(key.remoteJid);

                if (chatMessages?.get) {
                    const found = chatMessages.get(key.id);

                    if (found) {
                        return found;
                    }
                }
            }
        } catch (e) {}


        return null;

    } catch (error) {
        console.error(
            '[OnceDL] Message lookup error:',
            error?.message || error
        );

        return null;
    }
}


/*
 * ============================================================
 * UNWRAP VIEW ONCE MESSAGE
 * ============================================================
 */

function unwrapViewOnce(message) {
    if (!message) return null;

    let current = message;

    /*
     * Support multiple ViewOnce wrappers.
     */

    if (current.viewOnceMessage?.message) {
        current = current.viewOnceMessage.message;
    }

    if (current.viewOnceMessageV2?.message) {
        current = current.viewOnceMessageV2.message;
    }

    if (current.viewOnceMessageV2Extension?.message) {
        current = current.viewOnceMessageV2Extension.message;
    }

    return current;
}


/*
 * ============================================================
 * GET VIEW ONCE MEDIA
 * ============================================================
 */

function getViewOnceMedia(message) {
    if (!message) return null;

    const original = message;

    /*
     * Vérification ViewOnce.
     */

    const isViewOnce =
        original.viewOnceMessage ||
        original.viewOnceMessageV2 ||
        original.viewOnceMessageV2Extension ||
        original.imageMessage?.viewOnce ||
        original.videoMessage?.viewOnce ||
        original.audioMessage?.viewOnce;

    if (!isViewOnce) {
        return null;
    }

    /*
     * Déballer le ViewOnce.
     */

    const actualMessage = unwrapViewOnce(original);

    if (!actualMessage) {
        return null;
    }

    /*
     * Identifier le média.
     */

    const type = getContentType(actualMessage);

    if (!type) {
        return null;
    }

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
        actualMessage
    };
}


/*
 * ============================================================
 * DOWNLOAD MEDIA WITH RETRIES
 * ============================================================
 */

async function downloadMedia(mediaMsg, type) {
    const mediaType = type.replace('Message', '');

    let lastError = null;

    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
        try {
            console.log(
                `[OnceDL] Download attempt ${attempt}/${DOWNLOAD_RETRIES}`
            );

            const stream = await downloadContentFromMessage(
                mediaMsg,
                mediaType
            );

            const chunks = [];

            for await (const chunk of stream) {
                chunks.push(chunk);
            }

            const buffer = Buffer.concat(chunks);

            if (!buffer || buffer.length === 0) {
                throw new Error('Downloaded buffer is empty');
            }

            return buffer;

        } catch (error) {
            lastError = error;

            console.error(
                `[OnceDL] Attempt ${attempt} failed:`,
                error?.message || error
            );

            if (attempt < DOWNLOAD_RETRIES) {
                await sleep(RETRY_DELAY);
            }
        }
    }

    throw lastError || new Error('ViewOnce download failed');
}


/*
 * ============================================================
 * REACTION TARGET KEY
 * ============================================================
 */

function getReactionTargetKey(msg) {
    try {
        const reaction =
            msg?.message?.reactionMessage;

        if (!reaction?.key) {
            return null;
        }

        return reaction.key;

    } catch (error) {
        return null;
    }
}


/*
 * ============================================================
 * CHECK REACTION
 * ============================================================
 */

function isReactionMessage(msg) {
    return !!msg?.message?.reactionMessage;
}


/*
 * ============================================================
 * CHECK REPLY / QUOTED MESSAGE
 * ============================================================
 */

function getQuotedMessage(msg) {
    try {
        const messageType = getContentType(msg?.message);

        if (!messageType) {
            return null;
        }

        const messageContent =
            msg.message[messageType];

        /*
         * Reply classique avec extendedTextMessage.
         */

        if (messageType === 'extendedTextMessage') {
            return (
                messageContent?.contextInfo?.quotedMessage ||
                null
            );
        }

        /*
         * Certains media peuvent également contenir
         * contextInfo.
         */

        return (
            messageContent?.contextInfo?.quotedMessage ||
            null
        );

    } catch (error) {
        return null;
    }
}


/*
 * ============================================================
 * DOWNLOAD VIEW ONCE
 * ============================================================
 */

async function processViewOnce({
    socket,
    triggerMessage,
    targetMessage,
    targetKey
}) {
    try {
        if (!targetMessage) {
            return false;
        }

        /*
         * --------------------------------------------------------
         * Vérifier si c'est bien un ViewOnce.
         * --------------------------------------------------------
         */

        const mediaInfo =
            getViewOnceMedia(targetMessage);

        if (!mediaInfo) {
            return false;
        }

        const {
            type,
            mediaMsg
        } = mediaInfo;


        /*
         * --------------------------------------------------------
         * ANTI-DUPLICATE
         * --------------------------------------------------------
         *
         * Un même ViewOnce ne sera téléchargé qu'une seule fois
         * par session.
         */

        const uniqueKey =
            getMessageKey(targetKey || targetMessage.key);

        if (!uniqueKey) {
            return false;
        }

        if (global.onceDlDownloaded.has(uniqueKey)) {
            console.log(
                `[OnceDL] Already downloaded: ${uniqueKey}`
            );

            return false;
        }

        /*
         * Réserver immédiatement la clé.
         *
         * Cela évite qu'un reaction + reply simultané lance
         * deux téléchargements en parallèle.
         */

        global.onceDlDownloaded.set(
            uniqueKey,
            {
                timestamp: Date.now(),
                status: 'processing'
            }
        );


        /*
         * --------------------------------------------------------
         * Déterminer le type d'envoi.
         * --------------------------------------------------------
         */

        const msgType =
            type === 'imageMessage'
                ? 'image'
                : type === 'videoMessage'
                    ? 'video'
                    : 'audio';


        /*
         * --------------------------------------------------------
         * Réaction ⏳
         * --------------------------------------------------------
         */

        try {
            if (triggerMessage?.key?.remoteJid) {
                await socket.sendMessage(
                    triggerMessage.key.remoteJid,
                    {
                        react: {
                            text: '⏳',
                            key: triggerMessage.key
                        }
                    }
                );
            }
        } catch (error) {
            /*
             * Une erreur de réaction ne doit jamais
             * empêcher le téléchargement.
             */
        }


        /*
         * --------------------------------------------------------
         * DOWNLOAD
         * --------------------------------------------------------
         */

        let buffer;

        try {
            buffer = await downloadMedia(
                mediaMsg,
                type
            );
        } catch (error) {
            /*
             * Supprimer la réservation afin qu'un prochain
             * déclencheur puisse réessayer.
             */

            global.onceDlDownloaded.delete(uniqueKey);

            try {
                if (triggerMessage?.key?.remoteJid) {
                    await socket.sendMessage(
                        triggerMessage.key.remoteJid,
                        {
                            react: {
                                text: '❌',
                                key: triggerMessage.key
                            }
                        }
                    );
                }
            } catch (e) {}

            return false;
        }


        /*
         * --------------------------------------------------------
         * CAPTION
         * --------------------------------------------------------
         */

        const originalCaption =
            mediaMsg.caption || '';

        let finalCaption =
            `👁️ *ViewOnce Downloaded*\n\n`;

        if (originalCaption) {
            finalCaption +=
                `📝 *Caption:* ${originalCaption}\n\n`;
        }

        finalCaption +=
            `> BY MR ALEX`;


        /*
         * --------------------------------------------------------
         * ENVOYER DANS L'INBOX DU BOT
         * --------------------------------------------------------
         */

        const sessionJid =
            jidNormalizedUser(socket.user.id);

        await socket.sendMessage(
            sessionJid,
            {
                [msgType]: buffer,
                caption: finalCaption
            }
        );


        /*
         * --------------------------------------------------------
         * MARQUER COMME TÉLÉCHARGÉ
         * --------------------------------------------------------
         */

        global.onceDlDownloaded.set(
            uniqueKey,
            {
                timestamp: Date.now(),
                status: 'downloaded'
            }
        );


        /*
         * --------------------------------------------------------
         * Réaction ✅
         * --------------------------------------------------------
         */

        try {
            if (triggerMessage?.key?.remoteJid) {
                await socket.sendMessage(
                    triggerMessage.key.remoteJid,
                    {
                        react: {
                            text: '✅',
                            key: triggerMessage.key
                        }
                    }
                );
            }
        } catch (error) {}

        console.log(
            `[OnceDL] ViewOnce downloaded successfully: ${uniqueKey}`
        );

        return true;

    } catch (error) {
        console.error(
            '[OnceDL] Process error:',
            error?.message || error
        );

        return false;
    }
}


/*
 * ============================================================
 * CLEAN DOWNLOADED CACHE
 * ============================================================
 */

function cleanDownloadedCache() {
    try {
        const now = Date.now();

        /*
         * Garder la protection anti-duplicate pendant 30 minutes.
         */

        for (
            const [key, value]
            of global.onceDlDownloaded.entries()
        ) {
            if (!value?.timestamp) {
                global.onceDlDownloaded.delete(key);
                continue;
            }

            if (now - value.timestamp > CACHE_TTL) {
                global.onceDlDownloaded.delete(key);
            }
        }

    } catch (error) {
        console.error(
            '[OnceDL] Downloaded cache cleanup error:',
            error?.message || error
        );
    }
}


/*
 * ============================================================
 * INITIALIZE
 * ============================================================
 */

function initOnceDL(socket) {
    if (!socket || !socket.user) {
        return;
    }

    const sessionJid =
        jidNormalizedUser(socket.user.id);

    const socketId =
        sessionJid.split('@')[0];


    /*
     * Éviter les listeners dupliqués.
     */

    const active =
        global.onceDlListeners.get(socketId);

    if (active && active.socket === socket) {
        console.log(
            `[OnceDL] Listener already active for ${socketId}`
        );

        return;
    }


    /*
     * ========================================================
     * MAIN LISTENER
     * ========================================================
     */

    const onceListener = async (chatUpdate) => {
        try {
            const messages =
                chatUpdate?.messages || [];

            if (!messages.length) {
                return;
            }

            /*
             * Traiter tous les messages reçus.
             */

            for (const msg of messages) {
                if (!msg?.message) {
                    continue;
                }


                /*
                 * ------------------------------------------------
                 * 1. METTRE LE MESSAGE DANS LE CACHE
                 * ------------------------------------------------
                 *
                 * Très important pour les reactions :
                 * une reaction ne contient généralement pas
                 * le contenu du message original.
                 */

                cacheMessage(msg);


                /*
                 * ------------------------------------------------
                 * 2. SI C'EST DIRECTEMENT UN VIEW ONCE
                 * ------------------------------------------------
                 *
                 * On le met simplement dans le cache.
                 * On ne le télécharge pas automatiquement.
                 */

                const directViewOnce =
                    getViewOnceMedia(msg.message);

                if (directViewOnce) {
                    continue;
                }


                /*
                 * ------------------------------------------------
                 * 3. REACTION SUR UN VIEW ONCE
                 * ------------------------------------------------
                 */

                if (isReactionMessage(msg)) {
                    const targetKey =
                        getReactionTargetKey(msg);

                    if (!targetKey) {
                        continue;
                    }

                    /*
                     * Trouver le message original.
                     */

                    const originalMessage =
                        findOriginalMessage(
                            socket,
                            targetKey
                        );

                    if (!originalMessage) {
                        console.log(
                            '[OnceDL] Reaction detected, but original message is not available in cache/store.'
                        );

                        continue;
                    }

                    /*
                     * Vérifier que le message ciblé est ViewOnce.
                     */

                    const mediaInfo =
                        getViewOnceMedia(
                            originalMessage.message
                        );

                    if (!mediaInfo) {
                        continue;
                    }

                    /*
                     * Télécharger.
                     */

                    await processViewOnce({
                        socket,
                        triggerMessage: msg,
                        targetMessage: originalMessage.message,
                        targetKey
                    });

                    continue;
                }


                /*
                 * ------------------------------------------------
                 * 4. REPLY SUR UN VIEW ONCE
                 * ------------------------------------------------
                 */

                const quotedMessage =
                    getQuotedMessage(msg);

                if (!quotedMessage) {
                    continue;
                }

                /*
                 * Vérifier directement le quoted message.
                 */

                const mediaInfo =
                    getViewOnceMedia(
                        quotedMessage
                    );

                if (!mediaInfo) {
                    continue;
                }

                /*
                 * Le quotedMessage n'a pas toujours sa propre
                 * key complète dans ce contexte.
                 *
                 * On utilise donc la clé fournie par
                 * contextInfo.quotedMessage.
                 */

                const messageType =
                    getContentType(msg.message);

                const messageContent =
                    msg.message?.[messageType];

                const contextInfo =
                    messageContent?.contextInfo;

                const quotedKey =
                    contextInfo?.stanzaId
                        ? {
                            remoteJid:
                                msg.key.remoteJid,
                            id:
                                contextInfo.stanzaId,
                            participant:
                                contextInfo.participant
                          }
                        : null;


                await processViewOnce({
                    socket,
                    triggerMessage: msg,
                    targetMessage: quotedMessage,
                    targetKey: quotedKey
                });
            }

        } catch (error) {
            console.error(
                '[OnceDL] Listener error:',
                error?.message || error
            );
        }
    };


    /*
     * ========================================================
     * REGISTER LISTENER
     * ========================================================
     */

    socket.ev.on(
        'messages.upsert',
        onceListener
    );


    global.onceDlListeners.set(
        socketId,
        {
            socket,
            listener: onceListener
        }
    );


    /*
     * ========================================================
     * CLEANUP INTERVAL
     * ========================================================
     */

    const cleanupInterval =
        setInterval(() => {
            cleanMessageCache();
            cleanDownloadedCache();
        }, 5 * 60 * 1000);


    /*
     * Éviter que le timer empêche Node.js de se fermer.
     */

    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }


    console.log(
        `👁️ ViewOnce Downloader AUTO-ACTIVATED for ${socketId}`
    );

    console.log(
        `↳ Reply: ENABLED`
    );

    console.log(
        `↳ Reaction: ENABLED`
    );

    console.log(
        `↳ Image: ENABLED`
    );

    console.log(
        `↳ Video: ENABLED`
    );

    console.log(
        `↳ Audio: ENABLED`
    );

    console.log(
        `↳ Anti-Duplicate: ENABLED`
    );

    console.log(
        `↳ Retry: ${DOWNLOAD_RETRIES} attempts`
    );
}


/*
 * ============================================================
 * PLUGIN EXPORT
 * ============================================================
 */

module.exports = {
    name: 'once_downloader',

    category: 'utility',

    description:
        'Automatically downloads ViewOnce image, video and audio when a user replies or reacts to it.',

    commands: [
        'oncedl'
    ],

    init: initOnceDL,

    handler: async ({ reply }) => {
        await reply(
            '✅ *ViewOnce Downloader is Active!*\n\n' +
            '↳ Reply to any ViewOnce to download it.\n' +
            '↳ React to any ViewOnce with any emoji to download it.\n' +
            '↳ No specific emoji required.'
        );
    }
};
