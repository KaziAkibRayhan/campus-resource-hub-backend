const express = require("express");
const {
  getEvents,
  createEvent,
  approveEvent,
  deleteEvent,
  registerEvent,
  rejectEvent,
} = require("../controllers/eventController");
const {
  protect,
  authorize,
  optionalProtect,
} = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", optionalProtect, getEvents);
router.post("/", protect, authorize("admin", "moderator"), createEvent);
router.post("/:id/register", protect, registerEvent);
router.put("/:id/approve", protect, authorize("admin", "moderator"), approveEvent);
router.put("/:id/reject", protect, authorize("admin", "moderator"), rejectEvent);
router.delete("/:id", protect, deleteEvent);

module.exports = router;
