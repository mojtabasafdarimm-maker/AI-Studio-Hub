/** `features.usbPhoneTakeover`: a person watches and takes over the bots' USB phone. Off unless true. */
export function usbPhoneTakeoverEnabled({ features }) {
    return typeof features === "object" && features !== null && "usbPhoneTakeover" in features && features.usbPhoneTakeover === true;
}
/** For `onConfigSaved`: a hold must not outlive the feature, and with no stream open nothing else notices it going off. */
export function endHoldUnlessOn(hold, saved) {
    if (!usbPhoneTakeoverEnabled(saved))
        hold.release();
}
/** Every turn the engine can mount it, whatever its words: they pick only the skill's instructions. */
export function usbPhoneOffered(instance, skills) {
    return instance.adapter.capabilities.phoneMcp === true &&
        skills.some(({ manifest }) => manifest.defaultEnabled && manifest.requiredCapabilities.includes("phoneMcp"));
}
