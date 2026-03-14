const Event = require("../models/Event");

// @desc    Get all events
// @route   GET /api/events
// @access  Public
exports.getEvents = async (req, res) => {
  try {
    const { search, approved } = req.query;
    const query = {};

    if (
      !req.user ||
      (req.user.role !== "admin" && req.user.role !== "moderator")
    ) {
      query.approved = true;
    } else if (approved !== undefined) {
      query.approved = approved === "true";
    } else {
      query.approved = true;
    }

    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    const events = await Event.find(query)
      .populate("postedBy", "name email")
      .sort("date");

    res.status(200).json({
      success: true,
      count: events.length,
      events,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error fetching events",
    });
  }
};

// @desc    Create an event
// @route   POST /api/events
// @access  Private (Admin/Club Member)
exports.createEvent = async (req, res) => {
  try {
    const { title, description, club, date, time, location } = req.body;

    const event = await Event.create({
      title,
      description,
      club,
      date,
      time,
      location,
      postedBy: req.user._id,
      approved: req.user.role === "admin" || req.user.role === "moderator", // Auto-approve if admin/moderator
    });

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error creating event",
    });
  }
};

// @desc    Approve/Reject event
// @route   PUT /api/events/:id/approve
// @access  Private (Admin)
exports.approveEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    event.approved = true;
    await event.save();

    res.status(200).json({
      success: true,
      message: "Event approved",
      event,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error approving event",
    });
  }
};

// @desc    Delete event
// @route   DELETE /api/events/:id
// @access  Private (Admin/Owner)
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    // Check ownership
    if (
      event.postedBy.toString() !== req.user._id.toString() &&
      req.user.role !== "admin"
    ) {
      return res.status(401).json({
        success: false,
        message: "Not authorized to delete this event",
      });
    }

    await event.deleteOne();

    res.status(200).json({
      success: true,
      message: "Event removed",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error deleting event",
    });
  }
};
