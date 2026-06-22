const Event = require("../models/Event");
const Club = require("../models/Club");
const {
  sendNotification,
  broadcastNotification,
} = require("../utils/notificationHelper");
const { moderatePost } = require("../utils/postModeration");

const canModerate = (user) =>
  user && (user.role === "admin" || user.role === "moderator");

const idOf = (ref) =>
  ref && (ref._id ? ref._id.toString() : ref.toString ? ref.toString() : "");

// Shape an event for the requesting user: RSVP counts, their own status, and
// remaining capacity.
const shapeEvent = (event, userId) => {
  const obj = event.toObject ? event.toObject() : { ...event };
  const regs = obj.registrations || [];
  const goingCount = regs.filter((r) => r.status === "going").length;
  const maybeCount = regs.filter((r) => r.status === "maybe").length;
  const mine = userId
    ? regs.find((r) => idOf(r.user) === userId.toString())
    : null;

  obj.goingCount = goingCount;
  obj.maybeCount = maybeCount;
  obj.registrationCount = goingCount; // back-compat with existing UI
  obj.myStatus = mine ? mine.status : null;
  obj.isRegistered = mine ? mine.status === "going" : false;
  obj.spotsLeft = obj.capacity > 0 ? Math.max(0, obj.capacity - goingCount) : null;
  obj.isFull = obj.capacity > 0 && goingCount >= obj.capacity;
  // Don't leak the full registrant list to everyone.
  delete obj.registrations;
  return obj;
};

// Resolve a clubRef (if provided) to its canonical name; falls back to the
// free-text club field.
const resolveClub = async (clubRef, clubName) => {
  if (clubRef) {
    const club = await Club.findById(clubRef).select("name");
    if (club) return { clubRef: club._id, club: club.name };
  }
  return { clubRef: undefined, club: clubName };
};

// @route GET /api/events
exports.getEvents = async (req, res) => {
  try {
    const {
      search,
      approved,
      mine,
      scope, // "upcoming" | "past" | "all"
      clubRef,
      from,
      to,
      limit = 12,
      page = 1,
    } = req.query;
    const query = {};

    if (mine === "true" && req.user) {
      query.postedBy = req.user._id;
    } else if (!canModerate(req.user)) {
      query.approved = true;
    } else if (approved !== undefined) {
      query.approved = approved === "true";
    }

    if (search) query.title = { $regex: search, $options: "i" };
    if (clubRef) query.clubRef = clubRef;

    // Date scoping (calendar uses from/to; lists use scope).
    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      if (to) query.date.$lte = new Date(to);
    } else if (scope === "upcoming") {
      query.date = { $gte: new Date(new Date().setHours(0, 0, 0, 0)) };
    } else if (scope === "past") {
      query.date = { $lt: new Date(new Date().setHours(0, 0, 0, 0)) };
    }

    const perPage = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 100);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sortDir = scope === "past" ? "-date" : "date";

    const [events, total] = await Promise.all([
      Event.find(query)
        .populate("postedBy", "name email")
        .populate("clubRef", "name")
        .sort(sortDir)
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      Event.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      count: events.length,
      total,
      totalPages: Math.ceil(total / perPage),
      currentPage: pageNum,
      events: events.map((e) => shapeEvent(e, req.user?._id)),
    });
  } catch (error) {
    console.error("Get events error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error fetching events",
    });
  }
};

// Shared RSVP handler. status: "going" | "maybe" | "declined"
const applyRsvp = async (req, res, status) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event || !event.approved) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }
    if (event.status === "cancelled") {
      return res
        .status(400)
        .json({ success: false, message: "This event was cancelled" });
    }

    const existing = event.registrations.find(
      (r) => r.user.toString() === req.user._id.toString()
    );
    const wasGoing = existing?.status === "going";

    // Capacity only constrains "going".
    if (status === "going" && !wasGoing && event.capacity > 0) {
      const goingCount = event.registrations.filter(
        (r) => r.status === "going"
      ).length;
      if (goingCount >= event.capacity) {
        return res.status(400).json({
          success: false,
          message: "This event is full. Try marking yourself as 'maybe'.",
        });
      }
    }

    if (existing) {
      existing.status = status;
      existing.updatedAt = new Date();
    } else {
      event.registrations.push({ user: req.user._id, status });
    }
    await event.save();

    const goingCount = event.registrations.filter(
      (r) => r.status === "going"
    ).length;
    const maybeCount = event.registrations.filter(
      (r) => r.status === "maybe"
    ).length;

    // Announce only the first time someone commits to going.
    if (status === "going" && !wasGoing) {
      broadcastNotification(req.io, {
        excludeUser: req.user._id,
        title: "Event registration",
        message: `${req.user.name} is going to "${event.title}" — ${goingCount} going.`,
        type: "event",
        sender: req.user._id,
        link: `/events?highlight=${event._id}`,
        metadata: { eventId: event._id },
      });
    }

    req.io?.emit("event:updated", {
      eventId: event._id,
      goingCount,
      maybeCount,
      registrationCount: goingCount,
    });

    res.status(200).json({
      success: true,
      message:
        status === "going"
          ? "You're going!"
          : status === "maybe"
          ? "Marked as maybe"
          : "RSVP removed",
      myStatus: status,
      goingCount,
      maybeCount,
      spotsLeft: event.capacity > 0 ? Math.max(0, event.capacity - goingCount) : null,
    });
  } catch (error) {
    console.error("RSVP error:", error);
    res.status(500).json({ success: false, message: "Error updating RSVP" });
  }
};

// @route POST /api/events/:id/register  (back-compat: RSVP "going")
exports.registerEvent = (req, res) => applyRsvp(req, res, "going");

// @route PUT /api/events/:id/rsvp  { status }
exports.rsvpEvent = (req, res) => {
  const status = ["going", "maybe", "declined"].includes(req.body.status)
    ? req.body.status
    : "going";
  return applyRsvp(req, res, status);
};

// @route POST /api/events
exports.createEvent = async (req, res) => {
  try {
    const { title, description, club, date, time, location, capacity } = req.body;

    const rejection = await moderatePost({
      texts: [title, description, club, location],
    });
    if (rejection) {
      return res.status(422).json({
        success: false,
        code: "CONTENT_REJECTED",
        message: rejection.message,
        categories: rejection.categories,
      });
    }

    const resolved = await resolveClub(req.body.clubRef, club);
    if (!resolved.club) {
      return res
        .status(400)
        .json({ success: false, message: "Please provide a club name" });
    }

    const event = await Event.create({
      title,
      description,
      club: resolved.club,
      clubRef: resolved.clubRef,
      date,
      time,
      location,
      capacity: Math.max(0, parseInt(capacity, 10) || 0),
      postedBy: req.user._id,
      approved: true,
      approvedBy: req.user._id,
      approvedAt: Date.now(),
    });
    await event.populate("clubRef", "name");

    broadcastNotification(req.io, {
      excludeUser: req.user._id,
      title: "New event",
      message: `"${event.title}" by ${event.club} — ${new Date(
        event.date
      ).toLocaleDateString()} at ${event.location}.`,
      type: "event",
      sender: req.user._id,
      link: `/events?highlight=${event._id}`,
      metadata: { eventId: event._id },
    });
    req.io?.emit("event:new", shapeEvent(event, null));

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event: shapeEvent(event, req.user._id),
    });
  } catch (error) {
    console.error("Create event error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error creating event",
    });
  }
};

// @route PUT /api/events/:id
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }
    if (event.postedBy.toString() !== req.user._id.toString() && !canModerate(req.user)) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    const { title, description, club, date, time, location, capacity } = req.body;

    if (title || description || club || location) {
      const rejection = await moderatePost({
        texts: [title, description, club, location],
      });
      if (rejection) {
        return res.status(422).json({
          success: false,
          code: "CONTENT_REJECTED",
          message: rejection.message,
          categories: rejection.categories,
        });
      }
    }

    if (req.body.clubRef !== undefined || club) {
      const resolved = await resolveClub(req.body.clubRef, club || event.club);
      event.club = resolved.club || event.club;
      event.clubRef = resolved.clubRef;
    }
    if (title) event.title = title;
    if (description) event.description = description;
    if (date) event.date = date;
    if (time) event.time = time;
    if (location) event.location = location;
    if (capacity !== undefined) event.capacity = Math.max(0, parseInt(capacity, 10) || 0);

    await event.save();
    await event.populate("clubRef", "name");

    req.io?.emit("event:updated", {
      eventId: event._id,
      ...shapeEvent(event, null),
    });

    res.status(200).json({
      success: true,
      message: "Event updated",
      event: shapeEvent(event, req.user._id),
    });
  } catch (error) {
    console.error("Update event error:", error);
    res
      .status(500)
      .json({ success: false, message: error.message || "Error updating event" });
  }
};

// @route PUT /api/events/:id/cancel
exports.cancelEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }
    if (event.postedBy.toString() !== req.user._id.toString() && !canModerate(req.user)) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    event.status = "cancelled";
    await event.save();

    // Notify everyone who had RSVP'd going/maybe.
    const recipients = [
      ...new Set(
        event.registrations
          .filter((r) => r.status !== "declined")
          .map((r) => r.user.toString())
      ),
    ];
    await Promise.all(
      recipients.map((userId) =>
        sendNotification(req.io, {
          user: userId,
          title: "Event cancelled",
          message: `"${event.title}" on ${new Date(
            event.date
          ).toLocaleDateString()} has been cancelled.`,
          type: "event",
          link: `/events?highlight=${event._id}`,
          metadata: { eventId: event._id },
        })
      )
    );

    req.io?.emit("event:updated", { eventId: event._id, status: "cancelled" });

    res
      .status(200)
      .json({ success: true, message: "Event cancelled", event: shapeEvent(event, req.user._id) });
  } catch (error) {
    console.error("Cancel event error:", error);
    res.status(500).json({ success: false, message: "Error cancelling event" });
  }
};

// @route PUT /api/events/:id/approve
exports.approveEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    event.approved = true;
    event.approvedBy = req.user._id;
    event.approvedAt = Date.now();
    event.rejectionReason = "";
    await event.save();
    await event.populate("clubRef", "name");

    await sendNotification(req.io, {
      user: event.postedBy,
      title: "Event approved",
      message: `"${event.title}" is now visible.`,
      type: "event",
      link: `/events?highlight=${event._id}`,
    });
    broadcastNotification(req.io, {
      excludeUser: idOf(event.postedBy),
      title: "New event",
      message: `"${event.title}" by ${event.club} — ${new Date(
        event.date
      ).toLocaleDateString()} at ${event.location}.`,
      type: "event",
      link: `/events?highlight=${event._id}`,
      metadata: { eventId: event._id },
    });
    req.io?.emit("event:new", shapeEvent(event, null));

    res
      .status(200)
      .json({ success: true, message: "Event approved", event: shapeEvent(event, req.user._id) });
  } catch (error) {
    console.error("Approve event error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error approving event",
    });
  }
};

// @route PUT /api/events/:id/reject
exports.rejectEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    event.approved = false;
    event.rejectionReason = req.body.reason || "Does not meet event standards";
    await event.save();

    await sendNotification(req.io, {
      user: event.postedBy,
      title: "Event rejected",
      message: `"${event.title}" needs revision. Reason: ${event.rejectionReason}`,
      type: "event",
      link: "/events",
    });

    res.status(200).json({ success: true, message: "Event rejected", event });
  } catch (error) {
    console.error("Reject event error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error rejecting event",
    });
  }
};

// @route DELETE /api/events/:id
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found" });
    }
    if (event.postedBy.toString() !== req.user._id.toString() && !canModerate(req.user)) {
      return res
        .status(401)
        .json({ success: false, message: "Not authorized to delete this event" });
    }

    await event.deleteOne();
    req.io?.emit("event:deleted", { _id: event._id });

    res.status(200).json({ success: true, message: "Event removed" });
  } catch (error) {
    console.error("Delete event error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error deleting event",
    });
  }
};
