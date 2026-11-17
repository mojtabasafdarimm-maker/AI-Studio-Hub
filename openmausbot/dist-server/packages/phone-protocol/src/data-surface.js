// The Data surface: what the server, the bots' tools and the panel agree on.
// DuckDB runs in the OMB server, one database per bot.
/** The five tools a bot gets, in the order the catalog lists them. */
export const DATA_TOOL_NAMES = ["data_load", "data_describe", "data_sql", "data_show", "data_export"];
/** Bounds. Every result is capped by rows AND bytes; the gate's own trimming
 * is the backstop, never the plan. */
export const DATA_LIMITS = {
    /** `data_sql` rows returned to the model by default, and at most. */
    sqlRowsDefault: 50,
    sqlRowsMax: 500,
    /** Bytes of rows `data_sql` returns to the model. */
    sqlBytesMax: 32 * 1024,
    /** `data_describe` result bytes; beyond `describeColumnsMax` columns, types only. */
    describeBytesMax: 16 * 1024,
    describeColumnsMax: 50,
    /** Sample values per column, each at most `sampleChars` characters. */
    sampleValues: 3,
    sampleChars: 40,
    /** Rows per page the panel's grid asks for (Tad's proven size). */
    pageSize: 1024,
    /** Marks a chart may render after its SQL reduction. */
    chartMaxMarks: 10_000,
    /** Rows `data_show kind:"table"` keeps for the panel; the grid pages them. */
    showTableRowsMax: 1_000_000,
    /** One statement's wall clock before `interrupt()`. */
    sqlTimeoutMs: 60_000,
    /** Cards a sheet holds; the oldest unpinned card goes first. */
    sheetCardsMax: 200,
};
/** Where materialised results live inside a bot's database. DuckDB temp tables
 * are per connection; a real schema is visible to both and survives a restart. */
export const DATA_RESULTS_SCHEMA = "omb_results";
export const DATA_ROUTES = {
    sheet: (botId) => `/api/bots/${encodeURIComponent(botId)}/data`,
    page: (botId) => `/api/bots/${encodeURIComponent(botId)}/data/page`,
    run: (botId) => `/api/bots/${encodeURIComponent(botId)}/data/run`,
    cancel: (botId) => `/api/bots/${encodeURIComponent(botId)}/data/cancel`,
    card: (botId, cardId) => `/api/bots/${encodeURIComponent(botId)}/data/cards/${encodeURIComponent(cardId)}`,
    stats: (botId, table) => `/api/bots/${encodeURIComponent(botId)}/data/tables/${encodeURIComponent(table)}/stats`,
    histogram: (botId, table, column) => `/api/bots/${encodeURIComponent(botId)}/data/tables/${encodeURIComponent(table)}/histogram?column=${encodeURIComponent(column)}`,
    export: (botId) => `/api/bots/${encodeURIComponent(botId)}/data/export`,
    /** Server-rendered chart image for phones, Slack and email. */
    image: (botId, cardId) => `/api/bots/${encodeURIComponent(botId)}/data/cards/${encodeURIComponent(cardId)}/image`,
};
/** The tab's id in the Computer panel and the storage key suffix. */
export const DATA_PANEL_VIEW = "data";
