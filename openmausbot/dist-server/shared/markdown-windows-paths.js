// Markdown reads a backslash before punctuation as an escape, so a link to
// C:\Users\me\.openmausbot\report.md would lose the separator before
// ".openmausbot". In a link, image or definition destination that starts with
// a drive letter, such a backslash stays a separator; "\\" and the delimiters
// "\(", "\)", "\<" and "\>" still escape. The server and the client both parse
// with this extension, so the file authorized is the file rendered.
const destinations = new WeakSet();
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const STILL_ESCAPES = new Set(["\\", "(", ")", "<", ">"]);
function enterDestination() {
    this.buffer();
    destinations.add(this.stack[this.stack.length - 1]);
}
function exitCharacterEscapeValue(token) {
    // The text node `characterEscape` opened, as mdast's own data handler pops it.
    const tail = this.stack.pop();
    const value = this.sliceSerialize(token);
    const separator = destinations.has(this.stack[this.stack.length - 1])
        && DRIVE.test(tail.value)
        && !STILL_ESCAPES.has(value);
    tail.value += separator ? `\\${value}` : value;
    tail.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset };
}
export const windowsPathDestinations = {
    enter: {
        resourceDestinationString: enterDestination,
        definitionDestinationString: enterDestination,
    },
    exit: {
        characterEscapeValue: exitCharacterEscapeValue,
    },
};
