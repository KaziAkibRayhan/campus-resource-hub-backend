// Vercel WebSocket Functions expect the underlying HTTP server to be exported.
// Requiring server.js does not call listen() because it is not the entry module.
module.exports = require("../server");
