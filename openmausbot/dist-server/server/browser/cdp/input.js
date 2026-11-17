const BUTTON_BITS = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
const BUTTON_ORDER = ["left", "right", "middle", "back", "forward"];
/** A real mouse reports half pressure while a button is down. */
const PRESSED_FORCE = 0.5;
/** Trusted mouse input in the page's viewport (CSS pixels); every event goes through Input.dispatchMouseEvent. */
export class Mouse {
    #session;
    #keyboard;
    #x = 0;
    #y = 0;
    #buttons = 0;
    constructor(session, keyboard) {
        this.#session = session;
        this.#keyboard = keyboard;
    }
    get position() {
        return { x: this.#x, y: this.#y };
    }
    #pressedButton() {
        return BUTTON_ORDER.find((button) => this.#buttons & BUTTON_BITS[button]) ?? "none";
    }
    async move(x, y, { steps = 1 } = {}) {
        const from = { x: this.#x, y: this.#y };
        for (let step = 1; step <= steps; step++) {
            const at = { x: from.x + ((x - from.x) * step) / steps, y: from.y + ((y - from.y) * step) / steps };
            await this.#session.send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: at.x,
                y: at.y,
                button: this.#pressedButton(),
                buttons: this.#buttons,
                modifiers: this.#keyboard.modifiers,
                pointerType: "mouse",
                ...(this.#buttons ? { force: PRESSED_FORCE } : {}),
            });
        }
        this.#x = x;
        this.#y = y;
    }
    async down({ button = "left", clickCount = 1 } = {}) {
        this.#buttons |= BUTTON_BITS[button];
        await this.#session.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: this.#x,
            y: this.#y,
            button,
            buttons: this.#buttons,
            clickCount,
            modifiers: this.#keyboard.modifiers,
            pointerType: "mouse",
            force: PRESSED_FORCE,
        });
    }
    async up({ button = "left", clickCount = 1 } = {}) {
        this.#buttons &= ~BUTTON_BITS[button];
        await this.#session.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: this.#x,
            y: this.#y,
            button,
            buttons: this.#buttons,
            clickCount,
            modifiers: this.#keyboard.modifiers,
            pointerType: "mouse",
        });
    }
    /** Moves, then presses and releases `clickCount` times (a double click is two clicks counted 1 and 2). */
    async click(x, y, { button = "left", clickCount = 1 } = {}) {
        await this.move(x, y);
        for (let count = 1; count <= clickCount; count++) {
            await this.down({ button, clickCount: count });
            await this.up({ button, clickCount: count });
        }
    }
    async wheel(deltaX, deltaY) {
        await this.#session.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: this.#x,
            y: this.#y,
            deltaX,
            deltaY,
            buttons: this.#buttons,
            modifiers: this.#keyboard.modifiers,
            pointerType: "mouse",
        });
    }
    async releaseAll() {
        for (const button of BUTTON_ORDER) {
            if (this.#buttons & BUTTON_BITS[button])
                await this.up({ button }).catch(() => { });
        }
        this.#buttons = 0;
    }
}
