const express = require("express");
const {
  getNotifications,
  markAllRead,
  markRead,
  deleteNotification,
  clearNotifications,
} = require("../controllers/notificationController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", protect, getNotifications);
router.put("/read-all", protect, markAllRead);
router.delete("/", protect, clearNotifications);
router.put("/:id/read", protect, markRead);
router.delete("/:id", protect, deleteNotification);

module.exports = router;
