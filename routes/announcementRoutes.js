const express = require("express");
const {
  getAnnouncements,
  createAnnouncement,
  approveAnnouncement,
  rejectAnnouncement,
  deleteAnnouncement,
} = require("../controllers/announcementController");
const {
  protect,
  authorize,
  optionalProtect,
} = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", optionalProtect, getAnnouncements);
router.post("/", protect, authorize("admin", "moderator"), createAnnouncement);
router.put(
  "/:id/approve",
  protect,
  authorize("admin", "moderator"),
  approveAnnouncement
);
router.put(
  "/:id/reject",
  protect,
  authorize("admin", "moderator"),
  rejectAnnouncement
);
router.delete("/:id", protect, deleteAnnouncement);

module.exports = router;
