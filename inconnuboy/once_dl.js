const {
    downloadContentFromMessage,
    getContentType,
    jidNormalizedUser
} = require('baileys');

if (!global.onceDlListeners) {
    global.onceDlListeners = new Map();
}

function initOnceDL(socket) {
    if (!socket || !socket.user) return;

    const sessionJid = jidNormalizedUser(socket.user.id);
    const socketId = sessionJid.split('@')[0];

    // Évite d'enregistrer plusieurs listeners sur le même socket
    const active = global.onceDlListeners.get(socketId);

    if (active && active.socket === socket) {
        return;
    }

    const onceListener = async (chatUpdate) => {
        try {
            const msg = chatUpdate?.messages?.[0];

            if (!msg || !msg.message) return;

            /*
             * ============================================================
             * 1. RÉCUPÉRER LE CONTEXT INFO DU MESSAGE
             * ============================================================
             *
             * Le téléchargement se déclenche maintenant uniquement
             * lorsqu'un utilisateur RÉPOND à un message.
             *
             * Aucun emoji obligatoire.
             * Aucun texte obligatoire.
             * Aucun nombre minimum de caractères.
             * Aucun emoji identique obligatoire.
             */

            const messageType = getContentType(msg.message);

            let contextInfo = null;

            if (messageType === 'extendedTextMessage') {
                contextInfo = msg.message.extendedTextMessage?.contextInfo;
            } else {
                /*
                 * Certains messages peuvent également contenir
                 * contextInfo directement dans leur type.
                 */
                const messageContent = msg.message?.[messageType];

                contextInfo = messageContent?.contextInfo || null;
            }

            if (!contextInfo) return;

            /*
             * ============================================================
             * 2. VÉRIFIER QU'IL S'AGIT BIEN D'UNE RÉPONSE / QUOTED MESSAGE
             * ============================================================
             */

            const quotedMsg = contextInfo.quotedMessage;

            if (!quotedMsg) return;

            /*
             * ============================================================
             * 3. VÉRIFIER SI LE MESSAGE CITÉ EST UN VIEW ONCE
             * ============================================================
             */

            const isViewOnce =
                quotedMsg.viewOnceMessage ||
                quotedMsg.viewOnceMessageV2 ||
                quotedMsg.viewOnceMessageV2Extension ||
                quotedMsg.imageMessage?.viewOnce ||
                quotedMsg.videoMessage?.viewOnce ||
                quotedMsg.audioMessage?.viewOnce;

            if (!isViewOnce) return;

            /*
             * ============================================================
             * 4. EXTRAIRE LE VRAI MESSAGE MEDIA
             * ============================================================
             */

            let actualMessage = quotedMsg;

            if (quotedMsg.viewOnceMessage?.message) {
                actualMessage = quotedMsg.viewOnceMessage.message;
            } else if (quotedMsg.viewOnceMessageV2?.message) {
                actualMessage = quotedMsg.viewOnceMessageV2.message;
            } else if (quotedMsg.viewOnceMessageV2Extension?.message) {
                actualMessage = quotedMsg.viewOnceMessageV2Extension.message;
            }

            /*
             * ============================================================
             * 5. IDENTIFIER LE TYPE DE MEDIA
             * ============================================================
             */

            const type = getContentType(actualMessage);

            if (
                !type ||
                (
                    type !== 'imageMessage' &&
                    type !== 'videoMessage' &&
                    type !== 'audioMessage'
                )
            ) {
                return;
            }

            const mediaMsg = actualMessage[type];

            if (!mediaMsg) return;

            const msgType =
                type === 'imageMessage'
                    ? 'image'
                    : type === 'videoMessage'
                        ? 'video'
                        : 'audio';

            /*
             * ============================================================
             * 6. RÉACTION : TÉLÉCHARGEMENT EN COURS
             * ============================================================
             */

            try {
                await socket.sendMessage(
                    msg.key.remoteJid,
                    {
                        react: {
                            text: '⏳',
                            key: msg.key
                        }
                    }
                );
            } catch (e) {
                // La réaction ne doit jamais bloquer le téléchargement
            }

            /*
             * ============================================================
             * 7. TÉLÉCHARGEMENT DU VIEW ONCE
             * ============================================================
             */

            let buffer = Buffer.alloc(0);
            let downloadSuccess = false;

            const mediaType = type.replace('Message', '');

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const stream = await downloadContentFromMessage(
                        mediaMsg,
                        mediaType
                    );

                    const chunks = [];

                    for await (const chunk of stream) {
                        chunks.push(chunk);
                    }

                    buffer = Buffer.concat(chunks);

                    if (buffer.length > 0) {
                        downloadSuccess = true;
                        break;
                    }

                } catch (error) {
                    console.error(
                        `[OnceDL] Download attempt ${attempt}/3 failed:`,
                        error?.message || error
                    );
                }

                if (attempt < 3) {
                    await new Promise(resolve =>
                        setTimeout(resolve, 1500)
                    );
                }
            }

            /*
             * ============================================================
             * 8. ÉCHEC DU TÉLÉCHARGEMENT
             * ============================================================
             */

            if (!downloadSuccess || !buffer.length) {
                try {
                    await socket.sendMessage(
                        msg.key.remoteJid,
                        {
                            react: {
                                text: '❌',
                                key: msg.key
                            }
                        }
                    );
                } catch (e) {}

                return;
            }

            /*
             * ============================================================
             * 9. CAPTION
             * ============================================================
             */

            const originalCaption = mediaMsg.caption || '';

            let finalCaption =
                `👁️ *ViewOnce Downloaded*\n\n`;

            if (originalCaption) {
                finalCaption +=
                    `📝 *Caption:* ${originalCaption}\n\n`;
            }

            finalCaption += `> BY MR ALEX`;

            /*
             * ============================================================
             * 10. ENVOYER LE MEDIA DANS LA BOÎTE DU BOT
             * ============================================================
             */

            await socket.sendMessage(
                sessionJid,
                {
                    [msgType]: buffer,
                    caption: finalCaption
                }
            );

            /*
             * ============================================================
             * 11. SUCCÈS
             * ============================================================
             */

            try {
                await socket.sendMessage(
                    msg.key.remoteJid,
                    {
                        react: {
                            text: '✅',
                            key: msg.key
                        }
                    }
                );
            } catch (e) {}

        } catch (err) {
            console.error(
                '[OnceDL] Error:',
                err?.message || err
            );

            try {
                const errorMsg = chatUpdate?.messages?.[0];

                if (errorMsg?.key?.remoteJid) {
                    await socket.sendMessage(
                        errorMsg.key.remoteJid,
                        {
                            react: {
                                text: '❌',
                                key: errorMsg.key
                            }
                        }
                    );
                }
            } catch (e) {}
        }
    };

    /*
     * ================================================================
     * 12. ENREGISTRER LE LISTENER
     * ================================================================
     */

    socket.ev.on('messages.upsert', onceListener);

    global.onceDlListeners.set(
        socketId,
        {
            socket,
            listener: onceListener
        }
    );

    console.log(
        `👁️ ViewOnce Downloader AUTO-ACTIVATED for ${socketId}`
    );
}

module.exports = {
    name: 'once_downloader',

    category: 'utility',

    description:
        'Automatically downloads ViewOnce media when a user replies to it.',

    commands: ['oncedl'],

    init: initOnceDL,

    handler: async ({ reply }) => {
        await reply(
            '✅ *ViewOnce Downloader is Active!*\n\n' +
            'Reply to any ViewOnce photo, video or audio to download it automatically.'
        );
    }
};
