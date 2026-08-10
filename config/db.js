const mongoose = require("mongoose");

// Vercel can reuse a Node.js instance across several invocations. Keep both the
// resolved connection and an in-flight connection promise on globalThis so a
// warm instance never creates duplicate MongoDB pools.
const cache =
  globalThis.__campusHubMongoose ||
  (globalThis.__campusHubMongoose = { connection: null, promise: null });

const connectDB = async () => {
  if (cache.connection && mongoose.connection.readyState === 1) {
    return cache.connection;
  }

  if (!cache.promise) {
    cache.promise = mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 30000,
    });
  }

  try {
    cache.connection = await cache.promise;
    console.log("MongoDB Connected Successfully");
    return cache.connection;
  } catch (error) {
    // Allow a later invocation to retry. process.exit() is unsafe in a shared
    // Vercel Function instance and can terminate unrelated concurrent requests.
    cache.promise = null;
    console.error("MongoDB Connection Error:", error.message);
    throw error;
  }
};

module.exports = connectDB;
