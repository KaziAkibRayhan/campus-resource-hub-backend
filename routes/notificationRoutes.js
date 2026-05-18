const express = require("express");
const {
  getNotifications,
  markAllRead,
} = require("../controllers/notificationController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", protect, getNotifications);
router.put("/read-all", protect, markAllRead);

module.exports = router;
