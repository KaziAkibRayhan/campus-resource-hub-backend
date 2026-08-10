// backend/server.js
const dns = require("dns");
// Some hosts (e.g. Render) have no outbound IPv6 route. When DNS returns an
// AAAA (IPv6) record first, outbound connections to Gmail SMTP / Mongo Atlas /
// Cloudinary etc. fail with "connect ENETUNREACH <ipv6>". Prefer IPv4 to avoid
// this. Must run before any network connection is made.
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const connectDB = require("./config/db");
const configureSocketAdapter = require("./config/socketAdapter");
const initializeSocket = require("./socket");
const { startAnnouncementScheduler } = require("./utils/announcementScheduler");

// Load environment variables
dotenv.config();

// Start connecting once per runtime instance. Database-backed route operations
// still use this connection, but ordinary HTTP dispatch must not wait for the
// Socket.IO adapter and its index setup.
const databaseReady = connectDB();
void databaseReady.catch(() => {});

// Initialize Express app
const app = express();
// Vercel terminates TLS and forwards the original client address. Express must
// trust that first proxy hop so express-rate-limit can identify clients without
// rejecting X-Forwarded-For / Forwarded headers.
app.set("trust proxy", 1);
const server = http.createServer(app);
const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:5173",
  "http://localhost:3000",
].filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

const realtimeReady = configureSocketAdapter(io, databaseReady);
// Mark startup failures as handled even before the first HTTP/WebSocket request;
// individual requests still receive the same rejection below.
void realtimeReady.catch(() => {});
initializeSocket(io, realtimeReady);

// Middleware
app.use((req, res, next) => {
  req.io = io;
  next();
});

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// A real health check must include Atlas, not just confirm that Express loaded.
app.get("/api/health", async (req, res) => {
  try {
    await connectDB();
    res.status(200).json({ success: true, database: "connected" });
  } catch (error) {
    res.status(503).json({
      success: false,
      database: "unavailable",
      message: "Database is temporarily unavailable. Please retry shortly.",
    });
  }
});

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    // 300 was too low: the admin panel alone fires 8 requests per load, and a
    // single active user (navigation + AI search + notifications) can burn
    // through it in minutes — everything then 429s ("Failed to fetch ...").
    max: 1500,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests. Please try again later.",
    },
  })
);

// Vercel may create a fresh function instance with a new outbound IP. Await a
// retryable Atlas connection before dispatching database-backed routes instead
// of letting Mongoose buffer queries until they fail with an opaque 500.
app.use("/api", async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("API database readiness error:", error.message);
    res.status(503).json({
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: "Service is temporarily unavailable. Please retry shortly.",
    });
  }
});

// CORS configuration
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Routes
app.use("/api/auth", require("./routes/authRoutes"));
app.use('/api/resources', require('./routes/resourceRoutes'));
app.use('/api/announcements', require('./routes/announcementRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/lost-found', require('./routes/lostFoundRoutes'));
app.use('/api/clubs', require('./routes/clubRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));

// Test route
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Campus Resource Hub API is running flame icon",
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Render/local runs this file directly and needs a listening process. Vercel
// imports and owns the exported HTTP server instead.
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(
      `🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`
    );
    // Background job: fire notifications for scheduled announcements as they go live.
    startAnnouncementScheduler(io);
  });
}

module.exports = server;
