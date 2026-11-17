// The owner's paired phones as bot tools, wired once by server/index.ts: the registry and the jobs a phone polls, which
// sends came from a phone, whose turn may reach the phones, what a turn mounts and is told, and the /api/phones routes.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cloudHomeLendingRefusal, createCloudRoutineAuthors } from "../cloud-lending.js";
import { personKey } from "../person-key.js";
import { createPhoneHost } from "../phones/host.js";
import { PhoneJobs } from "../phones/jobs.js";
import { adoptExistingRoutines, desktopLendingTurn, desktopPhonesOffered } from "../phones/owner.js";
import { PhoneRegistry } from "../phones/registry.js";
import { createPhoneSends } from "../phones/sends.js";
import { createPhoneRoutes, PHONE_ACCESS_CHANGED, phoneKey } from "../routes/phones.js";
/** The owner of a desktop's phones: whoever works at this machine or holds an admin session. */
const DESKTOP_OWNER = "owner";
export function createPhones(deps) {
    const { store } = deps;
    const registry = new PhoneRegistry(join(deps.dataDir, "phones.json"));
    const sends = createPhoneSends();
    const jobs = new PhoneJobs((phone, id) => deps.nudge({ kind: "device.job", phone, id }));
    const unsubscribe = deps.sessions.onSessionRevoked((id) => {
        const key = `session:${id}`;
        try {
            registry.remove(key);
        }
        catch { }
        jobs.drop(key, PHONE_ACCESS_CHANGED);
    });
    const ownerRoutinesFile = join(deps.dataDir, "owner-routines.json");
    const routineRecordsExisted = existsSync(ownerRoutinesFile);
    /** Off a Cloud home: the routines the desktop owner wrote, so their runs and reports keep the owner's phones. */
    const routineAuthors = deps.cloudHome ? null : createCloudRoutineAuthors(ownerRoutinesFile);
    const desktopPhones = () => desktopPhonesOffered({ sharedMembership: deps.sharedMembership(), loopbackTrust: deps.loopbackTrust });
    /** Whose phones this server offers at all, before any turn is looked at. */
    const owner = () => (deps.shared ? null : deps.cloudHome ? deps.cloudOwnerKey : desktopPhones() ? DESKTOP_OWNER : null);
    function ownerOf(auth) {
        if (deps.shared)
            return null;
        if (deps.cloudHome)
            return deps.cloudOwnerSession(auth) ? deps.cloudOwnerKey : null;
        return desktopPhones() && deps.ownerOrAdmin(auth) ? DESKTOP_OWNER : null;
    }
    /** Whose phones a turn may use: on a Cloud home the owner's, when the lent Mac would allow the turn; elsewhere the desktop owner's. */
    function turnOwner(turn) {
        if (deps.shared)
            return null;
        if (deps.cloudHome)
            return deps.cloudLendingRefusal(turn) === null ? deps.cloudOwnerKey : null;
        if (!desktopPhones())
            return null;
        const lending = desktopLendingTurn({ ...deps.cloudLendingTurn(turn), thread: store.messagesFor(turn.threadId) }, {
            adminPersons: () => new Set(deps.sessions.list().filter((session) => session.scopes.includes("admin")).map((session) => personKey(session))),
            originIsUser: () => deps.originIsUser(turn),
            ownerWrote: (id) => {
                const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === id);
                return Boolean(routine && routineAuthors?.authored(routine.id, routine));
            },
        });
        return cloudHomeLendingRefusal(lending) === null ? DESKTOP_OWNER : null;
    }
    const fromPhone = (auth) => {
        const key = phoneKey(auth);
        return key !== null && registry.get(key) !== undefined;
    };
    const host = createPhoneHost({
        registry, jobs, dataDir: deps.dataDir, bot: (id) => store.bot(id), turnOwner,
        inRoom: (threadId) => Boolean(store.groupByThread(threadId)),
        appendMessage: (threadId, message) => { store.appendMessage(threadId, message); },
        active: deps.active,
    });
    return {
        routineAuthors,
        fromPhone,
        noteSend: (sendId) => sends.note(sendId),
        /** A fresh send id, known as the phone's when one of the owner's registered phones made the send. */
        sendIdFor(auth) {
            const sendId = randomUUID().replaceAll("-", "");
            if (fromPhone(auth))
                sends.note(sendId);
            return sendId;
        },
        turnOwner,
        /** Where the person is, from where the turn came from: the phone's send, the person at the computer, or nobody. */
        place(threadId, personAsked) {
            const request = deps.request(threadId);
            const line = request?.messageId ? store.messagesFor(threadId).find((message) => message.id === request.messageId) : undefined;
            if (sends.has(line?.sendId))
                return "phone";
            return personAsked && !request?.automation && request?.origin?.kind === "user" ? "computer" : "unattended";
        },
        /** Only for the owner's own turn and a bot granted an app one of the owner's phones allows. */
        integration(bot, turn) {
            return host.integration(bot, turnOwner({ botId: bot.id, ...turn }), () => deps.mint(bot.id, turn), deps.harnessUrl);
        },
        /** A turn's phone parts: what it may use and where the person is, or (unmounted) why the owner's phone is not here. */
        promptParts(bot, input) {
            if (input.mounted)
                return host.parts(bot, turnOwner(input.turn), input.place);
            return [{ id: "device", label: "Phone", text: input.offered ? host.withheld(bot, owner()) : "" }];
        },
        /** The bot settings preview: the owner's phone as a turn at the computer would see it. */
        previewParts(bot, offered) {
            const phoneOwner = owner();
            return offered && host.mounts(bot, phoneOwner) ? host.parts(bot, phoneOwner, "computer") : [];
        },
        handle: host.handle,
        toolListing: host.toolListing,
        routes: createPhoneRoutes({ registry, jobs, owner: ownerOf, isAdmin: deps.ownerOrAdmin, live: (auth) => auth.kind !== "session" || deps.sessions.isLive(auth.session.id) }),
        /** How many phones run the phone app here. */
        paired: () => registry.list(null, () => false).length,
        /** Routines written before records were kept are the owner's on a single-person desktop: record them once. */
        adoptRoutines() {
            if (!routineAuthors)
                return;
            adoptExistingRoutines({
                recordsExisted: routineRecordsExisted, offered: desktopPhones(),
                otherPeople: deps.sessions.list().some((session) => !session.scopes.includes("admin")),
                routines: deps.routines()?.listRoutines() ?? [],
                record: (routine) => routineAuthors.record(routine.id, routine), persist: () => routineAuthors.persist(),
            });
        },
        /** Anyone else's edit makes the routine no longer the owner's; the owner's keeps or renews it. */
        routineEdited(auth, routine, ownersAgain) {
            if (!routineAuthors)
                return;
            if (!deps.ownerOrAdmin(auth))
                routineAuthors.forget(routine.id);
            else if (ownersAgain)
                routineAuthors.record(routine.id, routine);
        },
        close: () => { unsubscribe(); jobs.close(); },
    };
}
