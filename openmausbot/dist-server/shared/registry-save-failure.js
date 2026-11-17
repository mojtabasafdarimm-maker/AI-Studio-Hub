const HELD_OR_READ_ONLY = new Set(["EPERM", "EACCES", "EBUSY", "EROFS"]);
export function registrySaveFailure(action, file, code) {
    const reason = typeof code === "string" && HELD_OR_READ_ONLY.has(code)
        ? `another program is holding OpenMausBot's ${file}, or its folder is read-only`
        : `OpenMausBot couldn't write ${file}`;
    return `Couldn't save ${action}: ${reason}.`;
}
