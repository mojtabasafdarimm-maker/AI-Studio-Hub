import { redactSecretsInText } from "../redact.js";
import { speakerOf } from "../replies.js";
import { extractTurnImages } from "../turn-images.js";
/** Scrubbed of secrets and attachment markup before it leaves this machine. */
export function roomRoutingInput(roomName, text, members, history, userName, sender) {
    const clean = (value) => redactSecretsInText(extractTurnImages(value).text);
    const humans = new Set(typeof userName === "string" ? [userName] : []);
    const recent = history.flatMap((m) => {
        if (m.kind !== "text" || !m.text)
            return [];
        if (m.role === "user") {
            const person = speakerOf(userName, m);
            humans.add(person);
            return [{ from: person, text: clean(m.text) }];
        }
        return [{ from: `${m.from?.name ?? "A bot"} (bot)`, text: clean(m.text) }];
    });
    const from = speakerOf(userName, { sender });
    humans.add(from);
    return {
        room: roomName,
        humans: [...humans],
        members: members.map((member) => ({ id: member.id, name: member.name, title: member.title, description: member.description })),
        recent,
        message: { from, text: clean(text) },
    };
}
