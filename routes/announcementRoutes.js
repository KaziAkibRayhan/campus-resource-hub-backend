const express = require("express");
const {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  approveAnnouncement,
  rejectAnnouncement,
  deleteAnnouncement,
  streamAttachment,
} = require("../controllers/announcementController");
const {
  protect,
  authorize,
  optionalProtect,
} = require("../middleware/authMiddleware");
const { upload, handleUploadError } = require("../middleware/uploadMiddleware");

const router = express.Router();

router.get("/", optionalProtect, getAnnouncements);
router.get("/:id/attachments/:index/file", streamAttachment);
router.post(
  "/",
  protect,
  authorize("admin", "moderator"),
  upload.array("attachments", 5),
  handleUploadError,
  createAnnouncement
);
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
router.put(
  "/:id",
  protect,
  upload.array("attachments", 5),
  handleUploadError,
  updateAnnouncement
);
router.delete("/:id", protect, deleteAnnouncement);

module.exports = router;
