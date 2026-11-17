/** The only methods an app frame may ask its server for; the server refuses any other with 400. */
export const APP_RPC_METHODS = ["tools/call", "tools/list", "resources/read", "resources/list"];
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_HOST_REFUSED = -32000;
