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
const initializeSocket = require("./socket");

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

// Initialize Express app
const app = express();
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

initializeSocket(io);

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

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests. Please try again later.",
    },
  })
);

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

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(
    `🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`
  );
});
