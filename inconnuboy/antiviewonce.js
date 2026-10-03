const {
    jidNormalizedUser,
    getContentType
} = require("baileys");

if (!global.antiViewOnceStates) {
    global.antiViewOnceStates = new Map();
}

if (!global.antiViewOnceListeners) {
    global.antiViewOnceListeners = new Map();
}

function getSessionInfo(socket) {
    if (!socket?.user?.id) return null;

    const jid = jidNormalizedUser(socket.user.id);
    const number = jid
        .split("@")[0]
        .split(":")[0]
        .replace(/[^0-9]/g, "");

    return {
        jid,
        number
    };
}

function unwrapViewOnce(message) {
    if (!message) return null;

    let current = message;
    let detected = false;

    for (let i = 0; i < 5 && current; i++) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }

        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            detected = true;
            continue;
        }

        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            detected = true;
            continue;
        }

        if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
            detected = true;
            continue;
        }

        break;
    }

    if (!current || !detected) {
        return null;
    }

    const type = getContentType(current);

    if (!type) {
        return {
            type: "unknown",
            message: current
        };
    }

    return {
        type,
        message: current
    };
}

function getMediaLabel(type) {
    switch (type) {
        case "imageMessage":
            return "Image";

        case "videoMessage":
            return "Vidéo";

        case "audioMessage":
            return "Audio";

        case "documentMessage":
            return "Document";

        default:
            return "Type inconnu";
    }
}

function getChatLabel(jid) {
    if (!jid) return "Inconnu";

    if (jid.endsWith("@g.us")) {
        return "Groupe";
    }

    return "Conversation privée";
}

function getSender(msg) {
    return (
        msg?.key?.participant ||
        msg?.key?.remoteJid ||
        "inconnu@s.whatsapp.net"
    );
}

function createDetectionMessage(msg, type) {
    const sender = getSender(msg);
    const senderNumber = sender
        .split("@")[0]
        .split(":")[0];

    const remoteJid = msg?.key?.remoteJid || "";
    const mediaLabel = getMediaLabel(type);
    const chatLabel = getChatLabel(remoteJid);

    return (
`╭━━〔 👁️ ANTI-VUE UNIQUE 〕━━╮
┃
┃ ✅ Message Vue Unique détecté
┃
┃ 📷 Type : ${mediaLabel}
┃ 💬 Discussion : ${chatLabel}
┃ 👤 Expéditeur : @${senderNumber}
┃
┃ 🔒 Protection conservée
┃
┃ ⚠️ Le média n'est pas extrait
┃    ni redistribué.
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
    );
}

function createErrorMessage(error) {
    return (
`╭━━〔 ❌ ANTI-VUE UNIQUE 〕━━╮
┃
┃ Une erreur est survenue.
┃
┃ ⚠️ Détails :
┃ ${String(error || "Erreur inconnue")}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
    );
}

function initAntiViewOnce(socket) {
    try {
        const session = getSessionInfo(socket);

        if (!session) return;

        const {
            jid: sessionJid,
            number: sessionNumber
        } = session;

        if (global.antiViewOnceListeners.has(sessionNumber)) {
            console.log(
                `👁️ Anti-Vue Unique déjà initialisé pour ${sessionNumber}`
            );
            return;
        }

        if (!global.antiViewOnceStates.has(sessionNumber)) {
            global.antiViewOnceStates.set(
                sessionNumber,
                false
            );
        }

        const listener = async (chatUpdate) => {
            try {
                if (
                    global.antiViewOnceStates.get(
                        sessionNumber
                    ) !== true
                ) {
                    return;
                }

                const msg =
                    chatUpdate?.messages?.[0];

                if (!msg?.message) {
                    return;
                }

                if (msg.key?.fromMe) {
                    return;
                }

                if (
                    msg.key?.remoteJid ===
                    "status@broadcast"
                ) {
                    return;
                }

                const detected =
                    unwrapViewOnce(msg.message);

                if (!detected) {
                    return;
                }

                console.log(
                    `👁️ Anti-Vue Unique : ${detected.type} détecté pour ${sessionNumber}`
                );

                const notification =
                    createDetectionMessage(
                        msg,
                        detected.type
                    );

                const sender = getSender(msg);

                await socket.sendMessage(
                    sessionJid,
                    {
                        text: notification,
                        mentions: sender.includes("@")
                            ? [sender]
                            : []
                    }
                );

                console.log(
                    `✅ Anti-Vue Unique : détection signalée dans l'inbox de ${sessionNumber}`
                );

            } catch (error) {
                console.log(
                    `❌ Erreur Anti-Vue Unique : ${error.message}`
                );

                try {
                    await socket.sendMessage(
                        sessionJid,
                        {
                            text:
                                createErrorMessage(
                                    error.message
                                )
                        }
                    );
                } catch (sendError) {
                    console.log(
                        `❌ Impossible d'envoyer l'erreur Anti-Vue Unique : ${sendError.message}`
                    );
                }
            }
        };

        socket.ev.on(
            "messages.upsert",
            listener
        );

        global.antiViewOnceListeners.set(
            sessionNumber,
            {
                socket,
                listener
            }
        );

        console.log(
            `👁️ Anti-Vue Unique initialisé pour ${sessionNumber}`
        );

    } catch (error) {
        console.log(
            `❌ Erreur d'initialisation Anti-Vue Unique : ${error.message}`
        );
    }
}

module.exports = {
    name: "antiviewonce",

    category: 5,

    description:
        "Détection des messages Vue Unique.",

    commands: [
        "antiviewonce",
        "aviewonce",
        "avo"
    ],

    init: initAntiViewOnce,

    handler: async ({
        socket,
        sender,
        args,
        reply
    }) => {
        try {
            const session =
                getSessionInfo(socket);

            if (!session) {
                return reply(
                    "❌ Impossible d'identifier la session du bot."
                );
            }

            const sessionNumber =
                session.number;

            const option =
                String(
                    args?.[0] || "status"
                )
                .toLowerCase()
                .trim();

            if (
                ![
                    "on",
                    "off",
                    "status"
                ].includes(option)
            ) {
                return reply(
`*👁️ Anti-Vue Unique*

📌 *État :* ${
    global.antiViewOnceStates.get(
        sessionNumber
    ) === true
        ? "ON 🟢"
        : "OFF 🔴"
}

Utilisation :

• *.antiviewonce on*
• *.antiviewonce off*
• *.antiviewonce status*`
                );
            }

            if (option === "status") {
                const active =
                    global.antiViewOnceStates.get(
                        sessionNumber
                    ) === true;

                return reply(
`*👁️ Statut Anti-Vue Unique*

🛡️ *Système :* ${
    active
        ? "Actif 🟢"
        : "Inactif 🔴"
}

📷 *Détection :* ${
    active
        ? "Activée"
        : "Désactivée"
}

🔒 *Protection View Once :*
Conservée`
                );
            }

            const enabled =
                option === "on";

            global.antiViewOnceStates.set(
                sessionNumber,
                enabled
            );

            return reply(
                enabled
                    ? `*👁️ Anti-Vue Unique ACTIVÉ 🟢*\n\nLes messages Vue Unique seront détectés et signalés dans l'inbox du bot.`
                    : `*👁️ Anti-Vue Unique DÉSACTIVÉ 🔴*\n\nLa détection automatique est désactivée.`
            );

        } catch (error) {
            console.log(
                `❌ Erreur de configuration Anti-Vue Unique : ${error.message}`
            );

            return reply(
`❌ *Erreur Anti-Vue Unique*

${error.message}`
            );
        }
    }
};
