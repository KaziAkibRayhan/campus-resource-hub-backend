const express = require("express");
const {
  getEvents,
  createEvent,
  updateEvent,
  approveEvent,
  deleteEvent,
  registerEvent,
  rsvpEvent,
  cancelEvent,
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
router.put("/:id/rsvp", protect, rsvpEvent);
router.put("/:id/cancel", protect, cancelEvent);
router.put("/:id/approve", protect, authorize("admin", "moderator"), approveEvent);
router.put("/:id/reject", protect, authorize("admin", "moderator"), rejectEvent);
router.put("/:id", protect, updateEvent);
router.delete("/:id", protect, deleteEvent);

module.exports = router;
