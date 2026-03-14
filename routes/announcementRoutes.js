const express = require("express");
const {
  getAnnouncements,
  createAnnouncement,
  approveAnnouncement,
  deleteAnnouncement,
} = require("../controllers/announcementController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", getAnnouncements);
router.post("/", protect, createAnnouncement);
router.put("/:id/approve", protect, authorize("admin"), approveAnnouncement);
router.delete("/:id", protect, deleteAnnouncement);

module.exports = router;
