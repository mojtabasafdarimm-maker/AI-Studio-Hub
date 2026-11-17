/** Whether a Cloud home offers this place at all. */
export function cloudHomeOffersPlace(place) {
    return place !== "local" && place !== "vm";
}
