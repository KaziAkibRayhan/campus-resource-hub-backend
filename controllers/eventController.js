const Event = require("../models/Event");
const Notification = require("../models/Notification");

// @desc    Get all events
// @route   GET /api/events
// @access  Public
exports.getEvents = async (req, res) => {
  try {
    const { search, approved, limit, mine } = req.query;
    const query = {};

    if (mine === "true" && req.user) {
      query.postedBy = req.user._id;
    } else if (!req.user || (req.user.role !== "admin" && req.user.role !== "moderator")) {
      query.approved = true;
    } else if (approved !== undefined) {
      query.approved = approved === "true";
    }
    // admin/moderator with no filter → sees all

    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    let eventsQuery = Event.find(query)
      .populate("postedBy", "name email")
      .sort("date")
      .lean();

    if (limit) {
      eventsQuery = eventsQuery.limit(parseInt(limit));
    }

    const events = await eventsQuery;

    const currentUserId = req.user?._id?.toString();
    const shapedEvents = events.map((event) => ({
      ...event,
      registrationCount: event.registrations?.length || 0,
      isRegistered: currentUserId
        ? event.registrations?.some(
            (registration) => registration.user.toString() === currentUserId
          )
        : false,
    }));

    res.status(200).json({
      success: true,
      count: shapedEvents.length,
      events: shapedEvents,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error fetching events",
    });
  }
};

// @desc    Register for an event
// @route   POST /api/events/:id/register
// @access  Private
exports.registerEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event || !event.approved) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    const alreadyRegistered = event.registrations.some(
      (registration) => registration.user.toString() === req.user._id.toString()
    );

    if (!alreadyRegistered) {
      event.registrations.push({ user: req.user._id });
      await event.save();
    }

    res.status(200).json({
      success: true,
      message: "Registered for event",
      registrationCount: event.registrations.length,
    });
  } catch (error) {
    console.error("Register event error:", error);
    res.status(500).json({
      success: false,
      message: "Error registering for event",
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
      approved: true,
      approvedBy: req.user._id,
      approvedAt: Date.now(),
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
    event.rejectionReason = "";
    await event.save();

    await Notification.create({
      user: event.postedBy,
      title: "Event approved",
      message: `"${event.title}" is now visible.`,
      type: "event",
    });

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

// @desc    Reject event
// @route   PUT /api/events/:id/reject
// @access  Private (Admin/Moderator)
exports.rejectEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    event.approved = false;
    event.rejectionReason = req.body.reason || "Does not meet event standards";
    await event.save();

    await Notification.create({
      user: event.postedBy,
      title: "Event rejected",
      message: `"${event.title}" needs revision. Reason: ${event.rejectionReason}`,
      type: "event",
    });

    res.status(200).json({
      success: true,
      message: "Event rejected",
      event,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Error rejecting event",
    });
  }
};

// @desc    Update event
// @route   PUT /api/events/:id
// @access  Private (Owner/Admin)
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }
    if (
      event.postedBy.toString() !== req.user._id.toString() &&
      req.user.role !== "admin" && req.user.role !== "moderator"
    ) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }
    const { title, description, club, date, time, location } = req.body;
    if (title)       event.title       = title;
    if (description) event.description = description;
    if (club)        event.club        = club;
    if (date)        event.date        = date;
    if (time)        event.time        = time;
    if (location)    event.location    = location;
    await event.save();
    res.status(200).json({ success: true, message: "Event updated", event });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Error updating event" });
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
