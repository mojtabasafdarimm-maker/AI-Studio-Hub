/** The same engine, model, effort and variant. */
export function sameModelSelection(a, b) {
    if (!a || !b)
        return a === b;
    return a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;
}
/** A bot's threads that run on a model of their own, different from the
 * bot's: the ones "Switch them too" moves onto the bot's model. Reads the
 * wire shape, where only followsBotModel === false is a thread's own pick, so
 * a server too old to send it counts none. */
export function threadsOnOwnModel(botModel, tasks) {
    return tasks.filter((task) => task.followsBotModel === false && !sameModelSelection(task.modelSelection ?? botModel, botModel));
}
