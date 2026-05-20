const express = require("express");
const {
  getNotifications,
  markAllRead,
  markRead,
  deleteNotification,
} = require("../controllers/notificationController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", protect, getNotifications);
router.put("/read-all", protect, markAllRead);
router.put("/:id/read", protect, markRead);
router.delete("/:id", protect, deleteNotification);

module.exports = router;
