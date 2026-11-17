import { baseBotId, layerAudience, layerId, mayRead, memberAudience, audienceMember, threadAudienceFrom } from "../audience.js";
import { createPeopleAbout } from "../people-about.js";
import { personKey } from "../person-key.js";
import { ensureWorkspace, loadMemory, workspaceDir } from "../workspace.js";
import { storeThreads } from "../engine-homes/migrate.js";
export function createCloudTeamHost(deps) {
    const team = deps.team;
    const people = createPeopleAbout(deps.dataDir);
    const audienceOf = (threadId) => (team ? deps.shares?.audienceOf(threadId) : null)
        ?? threadAudienceFrom({ room: deps.store.groupByThread(threadId)?.id, starter: deps.starters.get(threadId), markers: deps.markers });
    /** The person an audience is private to; a conversation shared with one person is nobody's own. */
    const ownPerson = (audience) => {
        const person = audienceMember(audience);
        return person && !deps.shares?.isShareKey(person) ? person : null;
    };
    if (team)
        deps.engineHomes?.start({ dataDir: deps.dataDir, audienceOf, threads: () => storeThreads(deps.store.bots ?? []) });
    /** The layer a turn in this conversation writes into: the bot's own folder off a team or for the team's conversations,
     * a sibling folder for a room's or a member's. The folder exists before the turn starts, so the box can bind it. */
    const layer = (botId, threadId) => {
        if (!team)
            return botId;
        const id = layerId(botId, audienceOf(threadId));
        if (id !== botId)
            ensureWorkspace(id, deps.language?.());
        return id;
    };
    const claimed = (session) => session.email?.trim().toLowerCase() ?? "";
    /** The server's profile becomes the person's whose address it names, filling only what they have not set themselves. */
    const adoptServerProfile = (email) => {
        const server = deps.serverProfile?.read();
        if (!team || !email || server?.email?.trim().toLowerCase() !== email)
            return false;
        const person = personKey({ id: "", email });
        const own = people.profile(person);
        people.saveProfile(person, { email, ...(own.name ? {} : { name: server.name ?? "" }), ...(own.avatarUrl ? {} : { avatarUrl: server.avatarUrl ?? "" }) });
        if (server.aboutMe?.trim() && !people.read(person))
            people.write(person, server.aboutMe);
        deps.serverProfile.clear();
        return true;
    };
    /** A person seen with a verified claim: their address is kept for the turns that name them. */
    const met = (session) => {
        const email = claimed(session);
        if (!team || !email)
            return null;
        adoptServerProfile(email);
        const person = personKey(session);
        if (people.profile(person).email !== email)
            people.saveProfile(person, { email });
        return person;
    };
    const personName = (person) => {
        if (!team || !person || deps.markers.has(person))
            return undefined;
        try {
            const own = people.profile(person);
            return own.name || own.email || undefined;
        }
        catch {
            return undefined;
        }
    };
    /** Who a signed-in team session is, as "you": never the server's profile. */
    const memberProfile = (session) => {
        const person = met(session) ?? personKey(session);
        const own = people.profile(person);
        return { name: own.name ?? "", email: claimed(session), aboutMe: people.read(person), ...(own.avatarUrl ? { avatarUrl: own.avatarUrl } : {}) };
    };
    return {
        team,
        audienceOf,
        layer,
        /** What a turn in this conversation reads: its own layer and the team's (the bot's own folder). */
        memoryIds(botId, threadId) {
            const own = layer(botId, threadId);
            return own === botId ? [botId] : [own, botId];
        },
        /** The folders a turn's box must put back besides the bot's own: its layer, when it has one. */
        layerDirs(botId, threadId) {
            const own = layer(botId, threadId);
            return own === botId ? [] : [workspaceDir(own)];
        },
        /** Captured facts about the person, into that person's own "About you"; nothing for the team's or a room's layer. */
        learnAbout(layerOrBotId, plan) {
            const person = team ? ownPerson(layerAudience(layerOrBotId)) : null;
            if (!person)
                return 0;
            const planned = plan(people.read(person));
            if (!planned)
                return 0;
            people.write(person, planned.next);
            return planned.count;
        },
        /** Whether a turn in `threadId` may read `other` (the read rule). Off a team: everything, as before. */
        readableFrom(threadId) {
            if (!team)
                return () => true;
            const turn = audienceOf(threadId);
            return (other) => mayRead(audienceOf(other), turn);
        },
        /** The team's notes, read-only, for a turn that writes elsewhere (a room's or a member's layer). */
        sharedNotesPrompt(botId, threadId) {
            if (!team || layer(botId, threadId) === botId)
                return "";
            const shared = loadMemory(botId);
            if (!shared)
                return "";
            return `\n\n${team.name}'s shared notes with you (read-only here; what you save in this conversation stays with it):\n${shared.text}`;
        },
        /** "About the user" for a turn: on a team only a member's own, with their name, in their own conversations; the
         * server's profile otherwise. */
        profileFor(threadId, serverProfile) {
            if (!team)
                return serverProfile;
            const person = ownPerson(audienceOf(threadId));
            if (!person)
                return undefined;
            const name = personName(person);
            return { aboutMe: people.read(person), ...(name ? { person: name } : {}) };
        },
        /** What a person is called in a bot's words and on their lines: the name they chose, else their address. */
        personName,
        memberProfile,
        /** Settings → Profile on a team: the signed-in person's own profile and nobody else's. The address is the claim's. */
        saveMemberProfile(session, patch) {
            const person = met(session) ?? personKey(session);
            const { aboutMe, name, avatarUrl } = patch;
            if (name !== undefined || avatarUrl !== undefined)
                people.saveProfile(person, { ...(name !== undefined ? { name } : {}), ...(avatarUrl !== undefined ? { avatarUrl } : {}) });
            if (aboutMe !== undefined)
                people.write(person, aboutMe);
            return memberProfile(session);
        },
        /** The name and picture from the person's own computer fill what their team profile lacks: each field once, never
         * over what they set here, and never again after they clear it here. */
        seedMemberProfile(session, offer) {
            const person = met(session) ?? personKey(session);
            const own = people.profile(person);
            const seeded = own.seeded ?? [];
            const fill = {};
            const filled = [];
            for (const field of ["name", "avatarUrl"]) {
                const offered = offer[field]?.trim();
                if (!offered || own[field] || seeded.includes(field))
                    continue;
                fill[field] = offered;
                filled.push(field);
            }
            if (filled.length)
                people.saveProfile(person, { ...fill, seeded: [...seeded, ...filled] });
            return { profile: memberProfile(session), filled };
        },
        /** The fields this person's own computer already filled once. */
        seededFields(session) {
            return people.profile(met(session) ?? personKey(session)).seeded ?? [];
        },
        met,
        /** At start: the server's profile goes to the person it names when they are already known here. */
        adoptServerProfile(knownEmails) {
            const email = deps.serverProfile?.read()?.email?.trim().toLowerCase();
            return Boolean(email) && knownEmails.some((known) => known.trim().toLowerCase() === email) && adoptServerProfile(email);
        },
        /** The person whose "About you" a layer's captured facts belong to; null for the team's and a room's. */
        aboutPerson(layerOrBotId) {
            return team ? ownPerson(layerAudience(layerOrBotId)) : null;
        },
        /** A turn's captured facts are the member's own when the conversation is theirs. */
        ownTurn(threadId) {
            return team !== null && ownPerson(audienceOf(threadId)) !== null;
        },
        people,
        baseBotId,
        /** How a session sees conversations on a team, a member's or an admin's: with each one's audience and the person's own
         * key, so another person's private chat is never theirs to see. Only the server itself (no address) sees everything. */
        audiencesFor(viewer) {
            if (!team || (viewer.kind === "all" && viewer.email === undefined))
                return undefined;
            return { of: audienceOf, person: viewer.email ? personKey({ id: "", email: viewer.email }) : null, ...(deps.shares ? { readers: deps.shares.readers } : {}) };
        },
        /** Whose browser a conversation's turns use: on a team its audience's (the member's, the group chat's or the team's),
         * the bot's own elsewhere. */
        browserAudience(threadId) {
            return team ? audienceOf(threadId) : "team";
        },
        /** Whose browser a person's live view of a bot shows: the conversation's when they name one they see, their own
         * when they name none, and null when they name one hidden from them. The bot's own off a team. */
        viewerBrowserAudience(input) {
            if (!team)
                return "team";
            if (input.threadId !== null)
                return input.sees(input.threadId) ? audienceOf(input.threadId) : null;
            return input.person ? memberAudience(input.person) : "team";
        },
        /** A session's team, for the app: the team's name and the person's role. */
        sessionInfo(session) {
            return team && session.teamRole ? { id: team.id, name: team.name, role: session.teamRole } : null;
        },
        /** The person a conversation is private to on a team (theirs alone, audience.ts); null for the team's, a room's and
         * anywhere off a team. Security invariant: a conversation shared with one person answers its share key, which no
         * session holds, so whatever follows this alone (a routine's home, an ask's person) reaches nobody rather than either
         * of its two readers. */
        privateTo(threadId) {
            return team ? audienceMember(audienceOf(threadId)) : null;
        },
        memberAudience,
    };
}
