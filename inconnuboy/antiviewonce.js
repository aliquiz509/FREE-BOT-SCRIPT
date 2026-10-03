const { jidNormalizedUser } = require("baileys");

if (!global.antiViewOnceActive) {
    global.antiViewOnceActive = new Map();
}

function getSessionId(socket) {
    try {
        if (!socket?.user?.id) return null;

        const sessionJid = jidNormalizedUser(socket.user.id);
        return sessionJid.split("@")[0];
    } catch {
        return null;
    }
}

function getViewOnceMessage(message) {
    if (!message) return null;

    return (
        message?.viewOnceMessage?.message ||
        message?.viewOnceMessageV2?.message ||
        message?.viewOnceMessageV2Extension?.message ||
        null
    );
}

function getMediaType(message) {
    if (!message) return null;

    if (message.imageMessage) return "image";
    if (message.videoMessage) return "video";
    if (message.audioMessage) return "audio";
    if (message.documentMessage) return "document";

    return null;
}

function getChatType(jid) {
    if (!jid) return "Inconnu";

    if (jid.endsWith("@g.us")) {
        return "Groupe";
    }

    if (jid === "status@broadcast") {
        return "Statut";
    }

    return "Conversation privée";
}

function createNotification({
    mediaType,
    remoteJid,
    sender,
    status,
    error
}) {
    const typeLabels = {
        image: "Image",
        video: "Vidéo",
        audio: "Audio",
        document: "Document"
    };

    const type = typeLabels[mediaType] || "Inconnu";
    const chatType = getChatType(remoteJid);
    const senderNumber = sender
        ? sender.split("@")[0]
        : "Inconnu";

    if (status === "detected") {
        return (
`╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮
┃
┃ ✅ Message Vue Unique détecté.
┃
┃ 📷 Type : ${type}
┃ 💬 Discussion : ${chatType}
┃ 👤 Expéditeur : @${senderNumber}
┃ 🔒 Protection conservée
┃
┃ ℹ️ Le média n'a pas été
┃    extrait ou redistribué.
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
        );
    }

    return (
`╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮
┃
┃ ❌ Erreur de traitement.
┃
┃ 📷 Type : ${type}
┃ 💬 Discussion : ${chatType}
┃ 👤 Expéditeur : @${senderNumber}
┃
┃ ⚠️ Erreur :
┃ ${String(error || "Erreur inconnue")}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
    );
}

function initAntiViewOnce(socket) {
    try {
        if (!socket?.user?.id) return;

        const sessionId = getSessionId(socket);

        if (!sessionId) return;

        if (global.antiViewOnceActive.has(sessionId)) {
            console.log(
                `👁️ Anti-Vue Unique déjà actif pour ${sessionId}`
            );
            return;
        }

        const listener = async (chatUpdate) => {
            try {
                if (!global.antiViewOnceActive.get(sessionId)) {
                    return;
                }

                const message = chatUpdate?.messages?.[0];

                if (!message?.message) {
                    return;
                }

                const key = message.key || {};
                const remoteJid = key.remoteJid;

                if (!remoteJid || remoteJid === "status@broadcast") {
                    return;
                }

                const viewOnce = getViewOnceMessage(message.message);

                if (!viewOnce) {
                    return;
                }

                const mediaType = getMediaType(viewOnce);

                if (!mediaType) {
                    try {
                        await socket.sendMessage(
                            sessionId + "@s.whatsapp.net",
                            {
                                text: createNotification({
                                    mediaType: null,
                                    remoteJid,
                                    sender:
                                        key.participant ||
                                        remoteJid,
                                    status: "error",
                                    error:
                                        "Type de message Vue Unique non pris en charge."
                                })
                            }
                        );
                    } catch (sendError) {
                        console.log(
                            "Erreur d'envoi Anti-Vue Unique :",
                            sendError.message
                        );
                    }

                    return;
                }

                console.log(
                    `👁️ Vue Unique détectée : ${mediaType} depuis ${remoteJid}`
                );

                const sender =
                    key.participant ||
                    remoteJid;

                try {
                    await socket.sendMessage(
                        sessionId + "@s.whatsapp.net",
                        {
                            text: createNotification({
                                mediaType,
                                remoteJid,
                                sender,
                                status: "detected"
                            }),
                            mentions: sender.includes("@")
                                ? [sender]
                                : []
                        }
                    );

                    console.log(
                        `✅ Anti-Vue Unique : ${mediaType} détecté et notification envoyée.`
                    );
                } catch (sendError) {
                    console.log(
                        "Erreur notification Anti-Vue Unique :",
                        sendError.message
                    );
                }

            } catch (error) {
                try {
                    await socket.sendMessage(
                        sessionId + "@s.whatsapp.net",
                        {
                            text: createNotification({
                                mediaType: null,
                                remoteJid:
                                    chatUpdate?.messages?.[0]?.key
                                        ?.remoteJid,
                                sender:
                                    chatUpdate?.messages?.[0]?.key
                                        ?.participant ||
                                    chatUpdate?.messages?.[0]?.key
                                        ?.remoteJid,
                                status: "error",
                                error: error.message
                            })
                        }
                    );
                } catch (sendError) {
                    console.log(
                        "Erreur d'envoi du rapport Anti-Vue Unique :",
                        sendError.message
                    );
                }

                console.log(
                    "Erreur Anti-Vue Unique :",
                    error.message
                );
            }
        };

        socket.ev.on(
            "messages.upsert",
            listener
        );

        global.antiViewOnceActive.set(
            sessionId,
            true
        );

        console.log(
            `👁️ Anti-Vue Unique activé pour ${sessionId}`
        );

    } catch (error) {
        console.log(
            "Erreur d'initialisation Anti-Vue Unique :",
            error.message
        );
    }
}

function stopAntiViewOnce(socket) {
    try {
        const sessionId = getSessionId(socket);

        if (!sessionId) return false;

        global.antiViewOnceActive.set(
            sessionId,
            false
        );

        console.log(
            `👁️ Anti-Vue Unique désactivé pour ${sessionId}`
        );

        return true;

    } catch (error) {
        console.log(
            "Erreur de désactivation Anti-Vue Unique :",
            error.message
        );

        return false;
    }
}

module.exports = {
    name: "antiviewonce",

    category: 7,

    description:
        "Système de détection des messages Vue Unique.",

    commands: [
        "antiviewonce",
        "av"
    ],

    init: initAntiViewOnce,

    handler: async ({
        socket,
        msg,
        sender,
        args
    }) => {
        try {
            const sessionId = getSessionId(socket);

            if (!sessionId) {
                return;
            }

            const action =
                String(args?.[0] || "status")
                    .toLowerCase()
                    .trim();

            if (action === "on") {

                global.antiViewOnceActive.set(
                    sessionId,
                    true
                );

                await socket.sendMessage(
                    sender,
                    {
                        text:
`╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮
┃
┃ 🟢 Système activé
┃
┃ 👁️ Détection : ACTIVÉE
┃ 📷 Images : DÉTECTÉES
┃ 🔒 Protection : CONSERVÉE
┃
┃ Les messages Vue Unique
┃ seront signalés dans votre
┃ boîte de réception.
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
                    },
                    {
                        quoted: msg
                    }
                );

                console.log(
                    `🟢 Anti-Vue Unique activé pour ${sessionId}`
                );

                return;
            }

            if (action === "off") {

                global.antiViewOnceActive.set(
                    sessionId,
                    false
                );

                await socket.sendMessage(
                    sender,
                    {
                        text:
`╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮
┃
┃ 🔴 Système désactivé
┃
┃ 👁️ Détection : DÉSACTIVÉE
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
                    },
                    {
                        quoted: msg
                    }
                );

                console.log(
                    `🔴 Anti-Vue Unique désactivé pour ${sessionId}`
                );

                return;
            }

            if (action === "status") {

                const active =
                    global.antiViewOnceActive.get(
                        sessionId
                    ) === true;

                await socket.sendMessage(
                    sender,
                    {
                        text:
`╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮
┃
┃ État : ${
    active
        ? "🟢 ACTIVÉ"
        : "🔴 DÉSACTIVÉ"
}
┃
┃ 📷 Détection des images :
┃ ${
    active
        ? "🟢 ACTIVE"
        : "🔴 INACTIVE"
}
┃
┃ 🔒 Protection View Once :
┃ CONSERVÉE
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
                    },
                    {
                        quoted: msg
                    }
                );

                return;
            }

            await socket.sendMessage(
                sender,
                {
                    text:
`╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮
┃
┃ Commandes disponibles :
┃
┃ • .antiviewonce on
┃ • .antiviewonce off
┃ • .antiviewonce status
┃
┃ Alias :
┃ • .av on
┃ • .av off
┃ • .av status
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
                },
                {
                    quoted: msg
                }
            );

        } catch (error) {
            console.log(
                "Erreur du module Anti-Vue Unique :",
                error.message
            );

            try {
                await socket.sendMessage(
                    sender,
                    {
                        text:
`╭━━〔 ❌ ERREUR 〕━━╮
┃
┃ Impossible d'exécuter
┃ Anti-Vue Unique.
┃
┃ ⚠️ ${error.message}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
                    },
                    {
                        quoted: msg
                    }
                );
            } catch {}
        }
    }
};
