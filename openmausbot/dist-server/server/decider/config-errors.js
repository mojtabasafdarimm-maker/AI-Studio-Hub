import { parseConfigPatch } from "../config.js";
import { USER_ERROR, userError, userErrorFields } from "../user-errors.js";
export function parseConfigPatchForPerson(value) {
    try {
        return parseConfigPatch(value);
    }
    catch (error) {
        if (error instanceof Error && error.message === USER_ERROR["serverError.decider.accountFormat"]) {
            Object.assign(error, userErrorFields(userError("serverError.decider.accountFormat")));
        }
        throw error;
    }
}
