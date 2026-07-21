const mongoose = require("mongoose");
const { createAdapter } = require("@socket.io/mongo-adapter");

let adapterPromise;

const configureSocketAdapter = (io, databaseReady) => {
  // A single-process host (local development or the current Render service)
  // can keep Socket.IO's in-memory adapter. Vercel may run several Function
  // instances, so use the existing MongoDB Atlas cluster to share broadcasts.
  const useMongoAdapter =
    Boolean(process.env.VERCEL) || process.env.SOCKET_ADAPTER === "mongodb";

  if (!useMongoAdapter) {
    return Promise.resolve(databaseReady);
  }

  if (!adapterPromise) {
    adapterPromise = Promise.resolve(databaseReady)
      .then(async () => {
        const collection = mongoose.connection.db.collection(
          "socket.io-adapter-events"
        );

        // Broadcast packets are temporary coordination data, not chat history.
        // The TTL index prevents this collection from growing indefinitely.
        await collection.createIndex(
          { createdAt: 1 },
          { expireAfterSeconds: 3600, background: true }
        );

        io.adapter(
          createAdapter(collection, {
            addCreatedAtField: true,
          })
        );

        console.log("Socket.IO MongoDB adapter ready");
      })
      .catch((error) => {
        console.error("Socket.IO MongoDB adapter error:", error.message);
        throw error;
      });
  }

  return adapterPromise;
};

module.exports = configureSocketAdapter;
