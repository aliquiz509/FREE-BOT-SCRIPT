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
 * CONFIG
 * ============================================================
 */

const MAX_CACHE_SIZE = 3000;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY = 1500;


/*
 * ============================================================
 * SLEEP
 * ============================================================
 */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/*
 * ============================================================
 * MESSAGE KEY
 * ============================================================
 */

function getMessageKey(key) {
    if (!key) return null;

    const remoteJid = key.remoteJid || '';
    const id = key.id || '';

    if (!remoteJid || !id) {
        return null;
    }

    /*
     * We intentionally do NOT include participant here.
     *
     * For a message inside a group:
     *
     * remoteJid + message ID
     *
     * is enough to identify the target message.
     */

    return `${remoteJid}:${id}`;
}


/*
 * ============================================================
 * CACHE INCOMING MESSAGE
 * ============================================================
 */

function cacheMessage(msg) {
    try {
        if (!msg?.key?.remoteJid || !msg?.key?.id) {
            return;
        }

        const key = getMessageKey(msg.key);

        if (!key) {
            return;
        }

        global.onceDlMessageCache.set(key, {
            message: msg,
            timestamp: Date.now()
        });

        /*
         * Prevent unlimited memory growth.
         */

        while (
            global.onceDlMessageCache.size >
            MAX_CACHE_SIZE
        ) {
            const oldestKey =
                global.onceDlMessageCache.keys().next().value;

            if (!oldestKey) {
                break;
            }

            global.onceDlMessageCache.delete(oldestKey);
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
 * CLEAN MESSAGE CACHE
 * ============================================================
 */

function cleanMessageCache() {
    try {
        const now = Date.now();

        for (
            const [key, entry]
            of global.onceDlMessageCache.entries()
        ) {
            if (
                !entry?.timestamp ||
                now - entry.timestamp > CACHE_TTL
            ) {
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
 * CLEAN DOWNLOAD CACHE
 * ============================================================
 */

function cleanDownloadedCache() {
    try {
        const now = Date.now();

        for (
            const [key, entry]
            of global.onceDlDownloaded.entries()
        ) {
            if (
                !entry?.timestamp ||
                now - entry.timestamp > CACHE_TTL
            ) {
                global.onceDlDownloaded.delete(key);
            }
        }

    } catch (error) {
        console.error(
            '[OnceDL] Download cache cleanup error:',
            error?.message || error
        );
    }
}


/*
 * ============================================================
 * FIND ORIGINAL MESSAGE
 *
 * Priority:
 *
 * 1. Local OnceDL cache
 * 2. socket.store.loadMessage()
 * 3. socket.store.messages
 * 4. global.store.loadMessage()
 * 5. global.store.messages
 * ============================================================
 */

async function findOriginalMessage(socket, key) {
    try {
        if (!key) {
            return null;
        }

        const cacheKey = getMessageKey(key);

        if (!cacheKey) {
            return null;
        }


        /*
         * --------------------------------------------------------
         * 1. OUR LOCAL CACHE
         * --------------------------------------------------------
         */

        const cached =
            global.onceDlMessageCache.get(cacheKey);

        if (cached?.message) {
            return cached.message;
        }


        /*
         * --------------------------------------------------------
         * 2. socket.store.loadMessage()
         * --------------------------------------------------------
         */

        try {
            if (
                socket?.store &&
                typeof socket.store.loadMessage === 'function'
            ) {
                const loaded =
                    await socket.store.loadMessage(
                        key.remoteJid,
                        key.id
                    );

                if (loaded) {
                    return loaded;
                }
            }
        } catch (error) {
            console.error(
                '[OnceDL] socket.store.loadMessage failed:',
                error?.message || error
            );
        }


        /*
         * --------------------------------------------------------
         * 3. socket.store.messages
         * --------------------------------------------------------
         */

        try {
            const messages =
                socket?.store?.messages;

            if (messages?.get) {
                const chat =
                    messages.get(key.remoteJid);

                if (chat?.get) {
                    const found =
                        chat.get(key.id);

                    if (found) {
                        return found;
                    }
                }
            }
        } catch (error) {}


        /*
         * --------------------------------------------------------
         * 4. global.store.loadMessage()
         * --------------------------------------------------------
         */

        try {
            if (
                global.store &&
                typeof global.store.loadMessage === 'function'
            ) {
                const loaded =
                    await global.store.loadMessage(
                        key.remoteJid,
                        key.id
                    );

                if (loaded) {
                    return loaded;
                }
            }
        } catch (error) {
            console.error(
                '[OnceDL] global.store.loadMessage failed:',
                error?.message || error
            );
        }


        /*
         * --------------------------------------------------------
         * 5. global.store.messages
         * --------------------------------------------------------
         */

        try {
            const messages =
                global.store?.messages;

            if (messages?.get) {
                const chat =
                    messages.get(key.remoteJid);

                if (chat?.get) {
                    const found =
                        chat.get(key.id);

                    if (found) {
                        return found;
                    }
                }
            }
        } catch (error) {}


        return null;

    } catch (error) {
        console.error(
            '[OnceDL] Find original message error:',
            error?.message || error
        );

        return null;
    }
}


/*
 * ============================================================
 * UNWRAP MESSAGE
 *
 * Supports:
 *
 * - ephemeralMessage
 * - viewOnceMessage
 * - viewOnceMessageV2
 * - viewOnceMessageV2Extension
 * ============================================================
 */

function unwrapMessage(message) {
    if (!message) {
        return null;
    }

    let current = message;

    /*
     * Multiple wrappers can exist.
     * Limit the loop to prevent malformed recursive objects.
     */

    for (let i = 0; i < 6; i++) {
        if (current?.ephemeralMessage?.message) {
            current =
                current.ephemeralMessage.message;
            continue;
        }

        if (current?.viewOnceMessage?.message) {
            current =
                current.viewOnceMessage.message;
            continue;
        }

        if (current?.viewOnceMessageV2?.message) {
            current =
                current.viewOnceMessageV2.message;
            continue;
        }

        if (
            current
                ?.viewOnceMessageV2Extension
                ?.message
        ) {
            current =
                current
                    .viewOnceMessageV2Extension
                    .message;
            continue;
        }

        break;
    }

    return current;
}


/*
 * ============================================================
 * GET VIEW ONCE MEDIA
 * ============================================================
 */

function getViewOnceMedia(message) {
    if (!message) {
        return null;
    }

    /*
     * Check the original object for ViewOnce.
     */

    const isViewOnce =
        !!(
            message.viewOnceMessage ||
            message.viewOnceMessageV2 ||
            message.viewOnceMessageV2Extension ||
            message.imageMessage?.viewOnce ||
            message.videoMessage?.viewOnce ||
            message.audioMessage?.viewOnce
        );

    if (!isViewOnce) {
        return null;
    }


    /*
     * Unwrap wrappers.
     */

    const actualMessage =
        unwrapMessage(message);

    if (!actualMessage) {
        return null;
    }


    /*
     * Identify media type.
     */

    const type =
        getContentType(actualMessage);

    if (!type) {
        return null;
    }


    /*
     * Only support:
     *
     * image
     * video
     * audio
     */

    if (
        type !== 'imageMessage' &&
        type !== 'videoMessage' &&
        type !== 'audioMessage'
    ) {
        return null;
    }


    const mediaMsg =
        actualMessage[type];

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
 * DOWNLOAD WITH RETRY
 * ============================================================
 */

async function downloadMedia(
    mediaMsg,
    messageType
) {
    const mediaType =
        messageType.replace(
            'Message',
            ''
        );

    let lastError = null;

    for (
        let attempt = 1;
        attempt <= DOWNLOAD_RETRIES;
        attempt++
    ) {
        try {
            console.log(
                `[OnceDL] Download attempt ${attempt}/${DOWNLOAD_RETRIES}`
            );

            const stream =
                await downloadContentFromMessage(
                    mediaMsg,
                    mediaType
                );

            const chunks = [];

            for await (
                const chunk of stream
            ) {
                chunks.push(chunk);
            }

            const buffer =
                Buffer.concat(chunks);

            if (
                !buffer ||
                buffer.length === 0
            ) {
                throw new Error(
                    'Downloaded media is empty'
                );
            }

            console.log(
                `[OnceDL] Download successful: ${buffer.length} bytes`
            );

            return buffer;

        } catch (error) {
            lastError = error;

            console.error(
                `[OnceDL] Attempt ${attempt}/${DOWNLOAD_RETRIES} failed:`,
                error?.message || error
            );

            if (
                attempt <
                DOWNLOAD_RETRIES
            ) {
                await sleep(
                    RETRY_DELAY
                );
            }
        }
    }

    throw (
        lastError ||
        new Error(
            'Unable to download ViewOnce media'
        )
    );
}


/*
 * ============================================================
 * PROCESS VIEW ONCE
 * ============================================================
 *
 * IMPORTANT:
 *
 * There is NO automatic reaction here.
 *
 * The downloader never sends:
 *
 * ⏳
 * ✅
 * ❌
 *
 * to the user's message.
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
         * IDENTIFY VIEW ONCE MEDIA
         * --------------------------------------------------------
         */

        const mediaInfo =
            getViewOnceMedia(
                targetMessage
            );

        if (!mediaInfo) {
            return false;
        }

        const {
            type,
            mediaMsg
        } = mediaInfo;


        /*
         * --------------------------------------------------------
         * UNIQUE MESSAGE KEY
         * --------------------------------------------------------
         */

        const uniqueKey =
            getMessageKey(
                targetKey ||
                targetMessage.key
            );

        if (!uniqueKey) {
            console.log(
                '[OnceDL] Cannot determine target message key.'
            );

            return false;
        }


        /*
         * --------------------------------------------------------
         * ANTI-DUPLICATE
         * --------------------------------------------------------
         */

        const existing =
            global.onceDlDownloaded.get(
                uniqueKey
            );

        if (existing) {
            console.log(
                `[OnceDL] Already processed: ${uniqueKey}`
            );

            return false;
        }


        /*
         * Reserve immediately.
         *
         * If the user reacts and replies almost at the same
         * time, only the first event gets permission to download.
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
         * DOWNLOAD
         * --------------------------------------------------------
         */

        let buffer;

        try {
            buffer =
                await downloadMedia(
                    mediaMsg,
                    type
                );

        } catch (error) {
            /*
             * Allow a future reaction/reply to retry if
             * the download genuinely failed.
             */

            global.onceDlDownloaded.delete(
                uniqueKey
            );

            console.error(
                '[OnceDL] Final download failure:',
                error?.message || error
            );

            return false;
        }


        /*
         * --------------------------------------------------------
         * DETERMINE OUTPUT TYPE
         * --------------------------------------------------------
         */

        let outputType;

        if (
            type === 'imageMessage'
        ) {
            outputType = 'image';

        } else if (
            type === 'videoMessage'
        ) {
            outputType = 'video';

        } else if (
            type === 'audioMessage'
        ) {
            outputType = 'audio';

        } else {
            global.onceDlDownloaded.delete(
                uniqueKey
            );

            return false;
        }


        /*
         * --------------------------------------------------------
         * CAPTION
         * --------------------------------------------------------
         */

        const originalCaption =
            mediaMsg.caption || '';

        let caption =
            '👁️ *ViewOnce Downloaded*\n\n';

        if (originalCaption) {
            caption +=
                `📝 *Caption:* ${originalCaption}\n\n`;
        }

        caption +=
            '> BY MR ALEX';


        /*
         * --------------------------------------------------------
         * BOT INBOX
         * --------------------------------------------------------
         */

        const sessionJid =
            jidNormalizedUser(
                socket.user.id
            );

        await socket.sendMessage(
            sessionJid,
            {
                [outputType]: buffer,
                caption
            }
        );


        /*
         * --------------------------------------------------------
         * MARK AS DOWNLOADED
         * --------------------------------------------------------
         */

        global.onceDlDownloaded.set(
            uniqueKey,
            {
                timestamp: Date.now(),
                status: 'downloaded'
            }
        );


        console.log(
            `[OnceDL] SUCCESS: ${uniqueKey}`
        );

        return true;

    } catch (error) {
        console.error(
            '[OnceDL] processViewOnce error:',
            error?.message || error
        );

        return false;
    }
}


/*
 * ============================================================
 * GET QUOTED MESSAGE
 * ============================================================
 */

function getQuotedInfo(msg) {
    try {
        if (!msg?.message) {
            return null;
        }

        const messageType =
            getContentType(
                msg.message
            );

        if (!messageType) {
            return null;
        }

        const content =
            msg.message[messageType];

        const contextInfo =
            content?.contextInfo;

        if (!contextInfo?.quotedMessage) {
            return null;
        }


        /*
         * WhatsApp's stanzaId identifies the original message.
         */

        const targetKey =
            contextInfo.stanzaId
                ? {
                    remoteJid:
                        msg.key.remoteJid,

                    id:
                        contextInfo.stanzaId,

                    participant:
                        contextInfo.participant
                }
                : null;


        return {
            quotedMessage:
                contextInfo.quotedMessage,

            targetKey
        };

    } catch (error) {
        return null;
    }
}


/*
 * ============================================================
 * REPLY HANDLER
 * ============================================================
 */

async function handleReply(
    socket,
    msg
) {
    const quotedInfo =
        getQuotedInfo(msg);

    if (!quotedInfo) {
        return;
    }

    const {
        quotedMessage,
        targetKey
    } = quotedInfo;


    /*
     * No text validation.
     *
     * The user can reply with:
     *
     * "ok"
     * "hello"
     * "."
     * "😂"
     * "👍"
     * anything.
     */

    const mediaInfo =
        getViewOnceMedia(
            quotedMessage
        );

    if (!mediaInfo) {
        return;
    }


    await processViewOnce({
        socket,
        triggerMessage: msg,
        targetMessage: quotedMessage,
        targetKey
    });
}


/*
 * ============================================================
 * REACTION HANDLER
 * ============================================================
 *
 * Baileys provides this through:
 *
 * socket.ev.on('messages.reaction', ...)
 *
 * The event contains:
 *
 * {
 *   key: targetMessageKey,
 *   reaction: {
 *      key: reactorMessageKey,
 *      text: "😂"
 *   }
 * }
 *
 * ============================================================
 */

async function handleReaction(
    socket,
    reactionUpdate
) {
    try {
        if (!reactionUpdate) {
            return;
        }

        const targetKey =
            reactionUpdate.key;

        const reaction =
            reactionUpdate.reaction;


        /*
         * Invalid reaction event.
         */

        if (!targetKey || !reaction) {
            return;
        }


        /*
         * If reaction.text is empty,
         * the user REMOVED the reaction.
         *
         * Do not download.
         */

        if (!reaction.text) {
            return;
        }


        /*
         * If the bot itself created the reaction,
         * ignore it.
         *
         * This is an additional safety measure.
         */

        if (reaction.key?.fromMe) {
            return;
        }


        /*
         * IMPORTANT:
         *
         * reactionUpdate.key is the KEY OF THE MESSAGE
         * THAT RECEIVED THE REACTION.
         *
         * This is exactly what we need.
         */

        console.log(
            `[OnceDL] Reaction detected: ${reaction.text}`
        );

        console.log(
            `[OnceDL] Target: ${targetKey.remoteJid}:${targetKey.id}`
        );


        /*
         * --------------------------------------------------------
         * FIND ORIGINAL MESSAGE
         * --------------------------------------------------------
         */

        const originalMessage =
            await findOriginalMessage(
                socket,
                targetKey
            );

        if (!originalMessage) {
            console.log(
                '[OnceDL] Reaction target was not found in cache/store.'
            );

            return;
        }


        /*
         * --------------------------------------------------------
         * CHECK VIEW ONCE
         * --------------------------------------------------------
         */

        const mediaInfo =
            getViewOnceMedia(
                originalMessage.message
            );

        if (!mediaInfo) {
            return;
        }


        /*
         * --------------------------------------------------------
         * DOWNLOAD
         * --------------------------------------------------------
         */

        await processViewOnce({
            socket,

            /*
             * Reaction event itself is not a normal WAMessage.
             * We therefore do not pass it as a trigger message.
             */

            triggerMessage: null,

            targetMessage:
                originalMessage.message,

            targetKey
        });

    } catch (error) {
        console.error(
            '[OnceDL] Reaction handler error:',
            error?.message || error
        );
    }
}


/*
 * ============================================================
 * INITIALIZE PLUGIN
 * ============================================================
 */

function initOnceDL(socket) {
    if (!socket || !socket.user) {
        return;
    }

    const sessionJid =
        jidNormalizedUser(
            socket.user.id
        );

    const socketId =
        sessionJid.split('@')[0];


    /*
     * Prevent duplicate listeners.
     */

    const existing =
        global.onceDlListeners.get(
            socketId
        );

    if (
        existing &&
        existing.socket === socket
    ) {
        console.log(
            `[OnceDL] Already active for ${socketId}`
        );

        return;
    }


    /*
     * ========================================================
     * MESSAGE LISTENER
     * ========================================================
     *
     * Used mainly for:
     *
     * - caching ViewOnce messages
     * - detecting replies
     * ========================================================
     */

    const upsertListener =
        async (chatUpdate) => {
            try {
                const messages =
                    chatUpdate?.messages || [];

                if (!messages.length) {
                    return;
                }


                for (
                    const msg of messages
                ) {
                    if (!msg?.message) {
                        continue;
                    }


                    /*
                     * ALWAYS cache messages first.
                     *
                     * This is crucial for reaction support.
                     */

                    cacheMessage(msg);


                    /*
                     * Clean cache periodically.
                     */

                    cleanMessageCache();


                    /*
                     * Reply detection.
                     *
                     * We do NOT require text.
                     * We do NOT require emoji.
                     * We do NOT require 3 characters.
                     */

                    const quotedInfo =
                        getQuotedInfo(msg);

                    if (!quotedInfo) {
                        continue;
                    }


                    const mediaInfo =
                        getViewOnceMedia(
                            quotedInfo.quotedMessage
                        );

                    if (!mediaInfo) {
                        continue;
                    }


                    await processViewOnce({
                        socket,

                        triggerMessage:
                            msg,

                        targetMessage:
                            quotedInfo.quotedMessage,

                        targetKey:
                            quotedInfo.targetKey
                    });
                }

            } catch (error) {
                console.error(
                    '[OnceDL] messages.upsert error:',
                    error?.message || error
                );
            }
        };


    /*
     * ========================================================
     * REACTION LISTENER
     * ========================================================
     *
     * THIS WAS THE IMPORTANT MISSING PART.
     *
     * Baileys has a dedicated messages.reaction event.
     * ========================================================
     */

    const reactionListener =
        async (reactionUpdates) => {
            try {
                if (
                    !Array.isArray(
                        reactionUpdates
                    )
                ) {
                    return;
                }


                for (
                    const reactionUpdate
                    of reactionUpdates
                ) {
                    await handleReaction(
                        socket,
                        reactionUpdate
                    );
                }

            } catch (error) {
                console.error(
                    '[OnceDL] messages.reaction error:',
                    error?.message || error
                );
            }
        };


    /*
     * ========================================================
     * REGISTER EVENTS
     * ========================================================
     */

    socket.ev.on(
        'messages.upsert',
        upsertListener
    );

    socket.ev.on(
        'messages.reaction',
        reactionListener
    );


    /*
     * ========================================================
     * SAVE LISTENERS
     * ========================================================
     */

    global.onceDlListeners.set(
        socketId,
        {
            socket,

            upsertListener,

            reactionListener
        }
    );


    /*
     * ========================================================
     * CLEANUP TIMER
     * ========================================================
     */

    const cleanupTimer =
        setInterval(() => {
            cleanMessageCache();
            cleanDownloadedCache();
        }, 5 * 60 * 1000);

    if (
        cleanupTimer.unref
    ) {
        cleanupTimer.unref();
    }


    /*
     * ========================================================
     * LOG
     * ========================================================
     */

    console.log(
        `👁️ ViewOnce Downloader AUTO-ACTIVATED for ${socketId}`
    );

    console.log(
        '↳ Reply trigger: ENABLED'
    );

    console.log(
        '↳ Reaction trigger: ENABLED'
    );

    console.log(
        '↳ Any emoji: ENABLED'
    );

    console.log(
        '↳ Image ViewOnce: ENABLED'
    );

    console.log(
        '↳ Video ViewOnce: ENABLED'
    );

    console.log(
        '↳ Audio ViewOnce: ENABLED'
    );

    console.log(
        '↳ Anti-duplicate: ENABLED'
    );

    console.log(
        `↳ Download retries: ${DOWNLOAD_RETRIES}`
    );

    console.log(
        '↳ Automatic reactions: DISABLED'
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
        'Automatically downloads ViewOnce image, video and audio through replies or reactions.',

    commands: [
        'oncedl'
    ],

    init: initOnceDL,

    handler: async ({ reply }) => {
        await reply(
            '✅ *ViewOnce Downloader is Active!*\n\n' +
            '↳ Reply to a ViewOnce to download it.\n' +
            '↳ React to a ViewOnce with any emoji to download it.\n' +
            '↳ No specific emoji is required.\n' +
            '↳ Automatic download reactions are disabled.'
        );
    }
};
